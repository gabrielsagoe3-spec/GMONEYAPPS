-- Private reusable answers, scoped Windows connectors, application attempts and nightly reports.
-- No candidate data, credentials or employer submissions are created by this migration.
begin;

create function private.gmoney_app_questions_valid(items jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog as $fn$
declare item jsonb;
begin
 if items is null or jsonb_typeof(items)<>'array' or jsonb_array_length(items)>50 then return false; end if;
 for item in select value from jsonb_array_elements(items) loop
  if jsonb_typeof(item)='string' then
   if length(item#>>'{}')>4000 then return false; end if;
  elsif jsonb_typeof(item)='object' then
   if item-array['key','question','label','reason']<>'{}'::jsonb or jsonb_typeof(item->'key') is distinct from 'string'
    or (item->>'key')!~'^[a-z][a-z0-9_.:-]{0,159}$' or jsonb_typeof(item->'question') is distinct from 'string'
    or length(btrim(item->>'question')) not between 1 and 2000
    or (item?'label' and (jsonb_typeof(item->'label')<>'string' or length(item->>'label')>2000))
    or (item?'reason' and (jsonb_typeof(item->'reason')<>'string' or length(item->>'reason')>4000)) then return false; end if;
  else return false; end if;
 end loop;
 return true;
end $fn$;

create table private.gmoney_application_answers (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_.:-]{0,159}$'),
  question text not null check (length(btrim(question)) between 1 and 2000),
  answer text not null check (length(btrim(answer)) between 1 and 4000),
  source text not null default 'user_confirmed' check (source = 'user_confirmed'),
  updated_at timestamptz not null default now(),
  primary key(owner_user_id,key)
);
create table private.gmoney_application_connectors (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  token_sha256 text not null unique check (token_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  last_worker_id text check (length(last_worker_id) <= 200)
);
create table private.gmoney_application_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid not null references private.gmoney_application_drafts(id) on delete cascade,
  job_id text not null,
  company text not null,
  title text not null,
  source_url text not null,
  mode text not null default 'submit' check (mode in ('prepare','submit')),
  status text not null default 'queued' check (status in ('queued','running','ready','needs_input','submitting','needs_confirmation','submitted','failed')),
  questions jsonb not null default '[]' check (private.gmoney_app_questions_valid(questions)),
  receipt jsonb not null default '{}' check (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=16000),
  error text not null default '' check (length(error)<=2000),
  attempt integer not null default 0 check (attempt>=0),
  lease_sha256 text check (lease_sha256 ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  lease_connector_id uuid references private.gmoney_application_connectors(id) on delete set null,
  worker_id text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id,job_id)
);
create index gmoney_application_jobs_claim_idx on private.gmoney_application_jobs(owner_user_id,status,created_at);
create table private.gmoney_application_events (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references private.gmoney_application_jobs(id) on delete cascade,
  kind text not null check (kind in ('queued','running','ready','needs_input','submitting','needs_confirmation','submitted','failed')),
  attempt integer not null,
  data jsonb not null default '{}' check (jsonb_typeof(data)='object' and octet_length(data::text)<=24000),
  created_at timestamptz not null default now()
);
create unique index gmoney_application_one_submission_idx on private.gmoney_application_events(job_id) where kind='submitted';
create index gmoney_application_events_reports_idx on private.gmoney_application_events(owner_user_id,created_at);
create table private.gmoney_application_report_preferences (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  local_time time not null default '20:00',
  timezone text not null default 'America/Chicago' check (timezone='America/Chicago'),
  enabled boolean not null default false,
  delivery text not null default 'dashboard' check (delivery='dashboard'),
  updated_at timestamptz not null default now()
);
create table private.gmoney_application_reports (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  generated_at timestamptz not null default now(),
  summary text not null,
  confirmed jsonb not null default '[]',
  blocked jsonb not null default '[]',
  failed jsonb not null default '[]',
  worker_last_seen_at timestamptz,
  unique(owner_user_id,local_date)
);

alter table private.gmoney_application_answers enable row level security;
alter table private.gmoney_application_connectors enable row level security;
alter table private.gmoney_application_jobs enable row level security;
alter table private.gmoney_application_events enable row level security;
alter table private.gmoney_application_report_preferences enable row level security;
alter table private.gmoney_application_reports enable row level security;
revoke all on private.gmoney_application_answers,private.gmoney_application_connectors,private.gmoney_application_jobs,
 private.gmoney_application_events,private.gmoney_application_report_preferences,private.gmoney_application_reports from public,anon,authenticated;
revoke all on sequence private.gmoney_application_events_id_seq from public,anon,authenticated;

create function private.gmoney_app_owner()
returns uuid language plpgsql security definer set search_path=pg_catalog as $fn$
declare principal uuid:=auth.uid();
begin
  if principal is null or not exists(select 1 from auth.users where id=principal and email_confirmed_at is not null) then
    raise exception 'Verified sign-in is required' using errcode='42501';
  end if;
  return principal;
end $fn$;

create function private.gmoney_app_event(p_job private.gmoney_application_jobs,p_kind text,p_data jsonb default '{}')
returns void language sql security definer set search_path=pg_catalog as $fn$
  insert into private.gmoney_application_events(owner_user_id,job_id,kind,attempt,data)
    values((p_job).owner_user_id,(p_job).id,p_kind,(p_job).attempt,p_data);
$fn$;

create function private.gmoney_app_job(p_owner uuid,p_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog as $fn$
 select jsonb_build_object('id',id,'draft_id',draft_id,'job_id',job_id,'company',company,'title',title,'source_url',source_url,
   'mode',mode,'status',status,'questions',questions,'receipt',receipt,'error',error,'attempt',attempt,
   'created_at',created_at,'updated_at',updated_at,'submitted_at',submitted_at)
 from private.gmoney_application_jobs where owner_user_id=p_owner and id=p_id;
$fn$;

create function private.gmoney_app_drafts(p_owner uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog as $fn$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'job_id',a.job_id,'company',a.company,'title',a.title,
  'location',a.location,'source_url',a.source_url,'status',a.status,'tailored_summary',a.tailored_summary,
  'cover_letter',a.cover_letter,'match_notes',a.match_notes,'missing_answers',a.missing_answers,'created_at',a.created_at)
  order by a.created_at desc,a.id),'[]')
 from private.gmoney_application_drafts a
 join private.gmoney_candidate_documents d on d.document_sha256=a.document_sha256
 join auth.users u on u.id=p_owner
 where d.owner_user_id=p_owner and u.email_confirmed_at is not null and lower(d.contact_email)=lower(u.email);
$fn$;

create function private.gmoney_app_candidate(p_owner uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog as $fn$
 select jsonb_build_object('full_name',coalesce(nullif(btrim(p.full_name),''),d.full_name,''),'email',u.email,
  'resume_text',coalesce(nullif(btrim(p.resume_text),''),d.resume_text,''),'instructions',coalesce(p.instructions,''))
 from auth.users u left join public.agent_preferences p on p.user_id=u.id
 left join lateral (select full_name,resume_text from private.gmoney_candidate_documents
   where owner_user_id=u.id and lower(contact_email)=lower(u.email) order by created_at desc limit 1) d on true
 where u.id=p_owner and u.email_confirmed_at is not null;
$fn$;

create function private.gmoney_app_expire_leases(p_owner uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $fn$
declare item private.gmoney_application_jobs;
begin
 for item in select * from private.gmoney_application_jobs where owner_user_id=p_owner
   and status in ('running','submitting') and lease_expires_at<clock_timestamp() for update skip locked loop
   update private.gmoney_application_jobs set status=case when item.status='submitting' then 'needs_confirmation' else 'needs_input' end,
    questions=jsonb_build_array(case when item.status='submitting'
      then 'The worker lost its submission checkpoint. Check the employer receipt before any further attempt; do not resubmit automatically.'
      else 'The worker lease expired. Review the attempt before explicitly queuing it again.' end),
    error='Worker lease expired.',lease_sha256=null,lease_expires_at=null,lease_connector_id=null,updated_at=clock_timestamp()
    where id=item.id returning * into item;
   perform private.gmoney_app_event(item,item.status,jsonb_build_object('questions',item.questions));
 end loop;
end $fn$;

create function private.gmoney_app_workspace(p_owner uuid,p_candidate boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $fn$
declare result jsonb;
begin
 perform private.gmoney_app_expire_leases(p_owner);
 insert into private.gmoney_application_report_preferences(owner_user_id) values(p_owner) on conflict do nothing;
 select jsonb_build_object(
  'answers',(select coalesce(jsonb_agg(jsonb_build_object('key',key,'question',question,'answer',answer,'source',source,'updated_at',updated_at) order by key),'[]') from private.gmoney_application_answers where owner_user_id=p_owner),
  'connectors',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'expires_at',expires_at,'last_seen_at',last_seen_at,'revoked',revoked_at is not null) order by created_at desc),'[]') from private.gmoney_application_connectors where owner_user_id=p_owner),
  'jobs',(select coalesce(jsonb_agg(private.gmoney_app_job(p_owner,j.id) order by j.created_at desc),'[]') from (select id,created_at from private.gmoney_application_jobs where owner_user_id=p_owner order by created_at desc limit 200) j),
  'report_preferences',(select jsonb_build_object('local_time',substring(local_time::text,1,5),'timezone',timezone,'enabled',enabled,'delivery',delivery) from private.gmoney_application_report_preferences where owner_user_id=p_owner),
  'reports',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'local_date',local_date,'generated_at',generated_at,'summary',summary,'confirmed',confirmed,'blocked',blocked,'failed',failed,'worker_last_seen_at',worker_last_seen_at) order by local_date desc),'[]') from (select * from private.gmoney_application_reports where owner_user_id=p_owner order by local_date desc limit 30) r)
 ) into result;
 if p_candidate then result:=result||jsonb_build_object('candidate',private.gmoney_app_candidate(p_owner),'drafts',private.gmoney_app_drafts(p_owner)); end if;
 return result;
end $fn$;

create function private.gmoney_app_save_answer(p_owner uuid,p_key text,p_question text,p_answer text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $fn$
begin
 if p_key is null or p_key!~'^[a-z][a-z0-9_.:-]{0,159}$' or p_question is null or length(btrim(p_question)) not between 1 and 2000
    or p_answer is null or length(btrim(p_answer)) not between 1 and 4000
    or (p_key||p_question||p_answer)~'(gmcp_|glease_)[a-f0-9]{64}' then raise exception 'Invalid answer fields' using errcode='22023'; end if;
 if not exists(select 1 from private.gmoney_application_answers where owner_user_id=p_owner and key=p_key)
    and (select count(*) from private.gmoney_application_answers where owner_user_id=p_owner)>=500 then raise exception 'Answer bank limit reached' using errcode='22023'; end if;
 insert into private.gmoney_application_answers(owner_user_id,key,question,answer)
 values(p_owner,p_key,btrim(p_question),btrim(p_answer)) on conflict(owner_user_id,key)
 do update set question=excluded.question,answer=excluded.answer,updated_at=clock_timestamp();
 return jsonb_build_object('saved',true,'key',p_key);
end $fn$;

create function private.gmoney_app_queue(p_owner uuid,p_draft_id uuid,p_mode text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $fn$
declare draft private.gmoney_application_drafts; item private.gmoney_application_jobs; inserted integer;
begin
 if p_mode is null or p_mode not in ('prepare','submit') then raise exception 'Invalid application mode' using errcode='22023'; end if;
 select a.* into draft from private.gmoney_application_drafts a
 join private.gmoney_candidate_documents d on d.document_sha256=a.document_sha256
 join auth.users u on u.id=p_owner where a.id=p_draft_id and d.owner_user_id=p_owner
 and u.email_confirmed_at is not null and lower(d.contact_email)=lower(u.email);
 if not found then raise exception 'Application draft is unavailable' using errcode='42501'; end if;
 perform private.gmoney_app_expire_leases(p_owner);
 insert into private.gmoney_application_jobs(owner_user_id,draft_id,job_id,company,title,source_url,mode)
 values(p_owner,draft.id,draft.job_id,draft.company,draft.title,draft.source_url,p_mode)
 on conflict(owner_user_id,job_id) do nothing;
 get diagnostics inserted=row_count;
 select * into item from private.gmoney_application_jobs where owner_user_id=p_owner and job_id=draft.job_id for update;
 if item.status in ('ready','needs_input','failed') then
   update private.gmoney_application_jobs set status='queued',mode=p_mode,questions='[]',error='',receipt='{}',
    lease_sha256=null,lease_expires_at=null,lease_connector_id=null,worker_id=null,updated_at=clock_timestamp()
    where id=item.id returning * into item;
 elsif inserted=0 then
   return private.gmoney_app_job(p_owner,item.id);
 end if;
 perform private.gmoney_app_event(item,'queued',jsonb_build_object('mode',p_mode));
 return private.gmoney_app_job(p_owner,item.id);
end $fn$;

create function public.get_application_workspace()
returns jsonb language sql security definer set search_path=pg_catalog as $fn$
 select private.gmoney_app_workspace(private.gmoney_app_owner());
$fn$;
create function public.save_application_answer(p_key text,p_question text,p_answer text)
returns jsonb language sql security definer set search_path=pg_catalog as $fn$
 select private.gmoney_app_save_answer(private.gmoney_app_owner(),p_key,p_question,p_answer);
$fn$;
create function public.create_application_connector(p_name text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $fn$
declare principal uuid:=private.gmoney_app_owner(); raw_token text; connector private.gmoney_application_connectors;
begin
 if p_name is null or length(btrim(p_name)) not between 1 and 100 then raise exception 'Invalid connector name' using errcode='22023'; end if;
 if (select count(*) from private.gmoney_application_connectors where owner_user_id=principal and revoked_at is null and expires_at>clock_timestamp())>=10 then
   raise exception 'Revoke an existing connector before creating another' using errcode='22023'; end if;
 raw_token:='gmcp_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into private.gmoney_application_connectors(owner_user_id,name,token_sha256,expires_at)
 values(principal,btrim(p_name),encode(sha256(convert_to(raw_token,'UTF8')),'hex'),clock_timestamp()+interval '30 days') returning * into connector;
 return jsonb_build_object('token',raw_token,'id',connector.id,'expires_at',connector.expires_at);
end $fn$;
create function public.revoke_application_connector(p_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $fn$
declare principal uuid:=private.gmoney_app_owner(); affected integer;
begin
 update private.gmoney_application_connectors set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=p_id and owner_user_id=principal;
 get diagnostics affected=row_count;
 return jsonb_build_object('revoked',affected=1);
end $fn$;
create function public.queue_application_draft(p_draft_id uuid,p_mode text default 'submit')
returns jsonb language sql security definer set search_path=pg_catalog as $fn$
 select private.gmoney_app_queue(private.gmoney_app_owner(),p_draft_id,p_mode);
$fn$;
create function public.set_application_report_schedule(p_local_time text,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $fn$
declare principal uuid:=private.gmoney_app_owner();
begin
 if p_local_time is null or p_local_time!~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' or p_enabled is null then
  raise exception 'Use a valid nightly report time' using errcode='22023'; end if;
 insert into private.gmoney_application_report_preferences(owner_user_id,local_time,enabled)
 values(principal,p_local_time::time,p_enabled) on conflict(owner_user_id)
 do update set local_time=excluded.local_time,enabled=excluded.enabled,updated_at=clock_timestamp();
 return jsonb_build_object('local_time',p_local_time,'timezone','America/Chicago','enabled',p_enabled,'delivery','dashboard');
end $fn$;

create function public.application_connector_rpc(p_token text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $fn$
declare connector private.gmoney_application_connectors; item private.gmoney_application_jobs;
 raw_lease text; lease_hash text; principal uuid; worker text; outcome text; proof jsonb; details jsonb; question_list jsonb;
 job_uuid uuid; result jsonb; confirmation_at timestamptz;
begin
 if p_token is null or p_token!~'^gmcp_[a-f0-9]{64}$' then raise exception 'Connector authentication failed' using errcode='42501'; end if;
 select c.* into connector from private.gmoney_application_connectors c join auth.users u on u.id=c.owner_user_id
 where c.token_sha256=encode(sha256(convert_to(p_token,'UTF8')),'hex') and c.revoked_at is null
 and c.expires_at>clock_timestamp() and u.email_confirmed_at is not null for update of c;
 if not found then raise exception 'Connector authentication failed' using errcode='42501'; end if;
 principal:=connector.owner_user_id;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>64000 then raise exception 'Invalid connector payload' using errcode='22023'; end if;
 if p_action in ('claim','heartbeat','before_submit','result') then
  update private.gmoney_application_connectors set last_seen_at=clock_timestamp() where id=connector.id;
 end if;
 if p_action='workspace' then return private.gmoney_app_workspace(principal,true);
 elsif p_action='remember_answer' then return private.gmoney_app_save_answer(principal,p_payload->>'key',p_payload->>'question',p_payload->>'answer');
 elsif p_action='queue' then
  begin job_uuid:=(p_payload->>'draft_id')::uuid; exception when others then raise exception 'Invalid draft identifier' using errcode='22023'; end;
  return private.gmoney_app_queue(principal,job_uuid,coalesce(p_payload->>'mode','submit'));
 elsif p_action in ('claim','heartbeat') then
  worker:=p_payload->>'worker_id';
  if worker is null or length(btrim(worker)) not between 1 and 200 then raise exception 'Invalid worker identifier' using errcode='22023'; end if;
  update private.gmoney_application_connectors set last_worker_id=worker where id=connector.id;
  perform private.gmoney_app_expire_leases(principal);
  if p_action='heartbeat' then return jsonb_build_object('connected',true,'server_time',clock_timestamp()); end if;
  select j.* into item from private.gmoney_application_jobs j
  join private.gmoney_application_drafts a on a.id=j.draft_id
  join private.gmoney_candidate_documents d on d.document_sha256=a.document_sha256
  join auth.users u on u.id=principal where j.owner_user_id=principal and j.status='queued'
   and d.owner_user_id=principal and lower(d.contact_email)=lower(u.email)
  order by j.created_at,j.id limit 1 for update of j skip locked;
  if not found then return jsonb_build_object('job',null); end if;
  raw_lease:='glease_'||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  update private.gmoney_application_jobs set status='running',attempt=attempt+1,worker_id=worker,
   lease_sha256=encode(sha256(convert_to(raw_lease,'UTF8')),'hex'),lease_connector_id=connector.id,
   lease_expires_at=clock_timestamp()+interval '15 minutes',updated_at=clock_timestamp() where id=item.id returning * into item;
  perform private.gmoney_app_event(item,'running');
  return jsonb_build_object('job',private.gmoney_app_job(principal,item.id),'lease_token',raw_lease,
   'candidate',private.gmoney_app_candidate(principal),'answers',(private.gmoney_app_workspace(principal)->'answers'),
   'draft',(select value from jsonb_array_elements(private.gmoney_app_drafts(principal)) where value->>'id'=item.draft_id::text));
 elsif p_action in ('before_submit','result') then
  begin job_uuid:=(p_payload->>'job_id')::uuid; exception when others then raise exception 'Invalid job identifier' using errcode='22023'; end;
  raw_lease:=p_payload->>'lease_token';
  if raw_lease is null or raw_lease!~'^glease_[a-f0-9]{64}$' then raise exception 'Application lease is unavailable' using errcode='42501'; end if;
  lease_hash:=encode(sha256(convert_to(raw_lease,'UTF8')),'hex');
  select j.* into item from private.gmoney_application_jobs j
  join private.gmoney_application_drafts a on a.id=j.draft_id
  join private.gmoney_candidate_documents d on d.document_sha256=a.document_sha256
  join auth.users u on u.id=principal where j.id=job_uuid and j.owner_user_id=principal
   and d.owner_user_id=principal and lower(d.contact_email)=lower(u.email) for update of j;
  if not found or item.lease_connector_id is distinct from connector.id or item.lease_sha256 is distinct from lease_hash
    or item.lease_expires_at is null or item.lease_expires_at<=clock_timestamp() then
    raise exception 'Application lease is unavailable' using errcode='42501'; end if;
  if p_action='before_submit' then
   if item.status<>'running' or item.mode<>'submit' then raise exception 'Application cannot enter submission' using errcode='22023'; end if;
   update private.gmoney_application_jobs set status='submitting',updated_at=clock_timestamp() where id=item.id returning * into item;
   perform private.gmoney_app_event(item,'submitting');
   return private.gmoney_app_job(principal,item.id);
  end if;
  outcome:=p_payload->>'status'; proof:=coalesce(p_payload->'receipt','{}'); question_list:=coalesce(p_payload->'questions','[]');
  if outcome is null or outcome not in ('ready','needs_input','submitted','needs_confirmation','failed')
   or jsonb_typeof(proof)<>'object' or octet_length(proof::text)>16000 or not private.gmoney_app_questions_valid(question_list)
   or length(coalesce(p_payload->>'error',''))>2000 then raise exception 'Invalid application result' using errcode='22023'; end if;
  if item.status not in ('running','submitting') or (item.status='submitting' and outcome not in ('submitted','needs_confirmation')) then
   raise exception 'Application result transition is unavailable' using errcode='22023'; end if;
  if outcome='submitted' then
   if item.status<>'submitting' or item.mode<>'submit' or proof->>'source_url' is distinct from item.source_url
    or proof->>'adapter' is null or proof->>'adapter' not in ('greenhouse','lever')
    or jsonb_typeof(proof->'confirmation_text') is distinct from 'string'
    or length(btrim(proof->>'confirmation_text')) not between 5 and 8000
    or jsonb_typeof(proof->'confirmed_at') is distinct from 'string'
    or (item.job_id like 'greenhouse-%' and proof->>'adapter'<>'greenhouse')
    or (item.job_id like 'lever-%' and proof->>'adapter'<>'lever')
    or (proof?'confirmation_url' and (jsonb_typeof(proof->'confirmation_url')<>'string'
      or (proof->>'confirmation_url')!~'^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$')) then
    raise exception 'A source-matched employer confirmation is required' using errcode='22023'; end if;
   begin confirmation_at:=(proof->>'confirmed_at')::timestamptz;
   exception when others then raise exception 'Invalid confirmation time' using errcode='22023'; end;
   if confirmation_at is null or confirmation_at>clock_timestamp()+interval '5 minutes' or confirmation_at<item.updated_at-interval '5 minutes' then
    raise exception 'Invalid confirmation time' using errcode='22023'; end if;
  elsif proof<>'{}'::jsonb then raise exception 'Only confirmed submissions may retain a receipt' using errcode='22023'; end if;
  -- Never persist credentials if a client accidentally includes one in free text.
  details:=p_payload-array['lease_token'];
  if details::text~'(gmcp_|glease_)[a-f0-9]{64}' then raise exception 'Result contains private credentials' using errcode='22023'; end if;
  update private.gmoney_application_jobs set status=outcome,questions=question_list,receipt=proof,error=coalesce(p_payload->>'error',''),
   submitted_at=case when outcome='submitted' then clock_timestamp() else null end,
   lease_sha256=null,lease_expires_at=null,lease_connector_id=null,updated_at=clock_timestamp() where id=item.id returning * into item;
  perform private.gmoney_app_event(item,outcome,jsonb_build_object('questions',question_list,'receipt',proof,'error',item.error));
  return private.gmoney_app_job(principal,item.id);
 end if;
 raise exception 'Unknown connector action' using errcode='22023';
end $fn$;

create function private.gmoney_build_due_application_reports()
returns integer language plpgsql security definer set search_path=pg_catalog as $fn$
declare pref private.gmoney_application_report_preferences; today date; cutoff timestamptz; previous_cutoff timestamptz;
 confirmed_items jsonb; blocked_items jsonb; failed_items jsonb; seen timestamptz; generated integer:=0; inserted integer;
begin
 for pref in select p.* from private.gmoney_application_report_preferences p join auth.users u on u.id=p.owner_user_id
  where p.enabled and u.email_confirmed_at is not null loop
  today:=(clock_timestamp() at time zone pref.timezone)::date;
  cutoff:=(today+pref.local_time) at time zone pref.timezone;
  if clock_timestamp()<cutoff or exists(select 1 from private.gmoney_application_reports where owner_user_id=pref.owner_user_id and local_date=today) then continue; end if;
  previous_cutoff:=((today-1)+pref.local_time) at time zone pref.timezone;
  perform private.gmoney_app_expire_leases(pref.owner_user_id);
  select coalesce(jsonb_agg(jsonb_build_object('job_id',j.id,'company',j.company,'title',j.title,'source_url',j.source_url,
   'submitted_at',e.created_at,'receipt',e.data->'receipt') order by e.created_at),'[]') into confirmed_items
   from private.gmoney_application_events e join private.gmoney_application_jobs j on j.id=e.job_id
   where e.owner_user_id=pref.owner_user_id and e.kind='submitted' and e.created_at>=previous_cutoff and e.created_at<cutoff;
  select coalesce(jsonb_agg(jsonb_build_object('job_id',j.id,'company',j.company,'title',j.title,'source_url',j.source_url,
   'status',e.kind,'questions',e.data->'questions','recorded_at',e.created_at) order by e.created_at),'[]') into blocked_items
   from (select distinct on(job_id) * from private.gmoney_application_events where owner_user_id=pref.owner_user_id
    and created_at>=previous_cutoff and created_at<cutoff order by job_id,created_at desc,id desc) e
   join private.gmoney_application_jobs j on j.id=e.job_id where e.kind in ('needs_input','needs_confirmation');
  select coalesce(jsonb_agg(jsonb_build_object('job_id',j.id,'company',j.company,'title',j.title,'source_url',j.source_url,
   'error',e.data->>'error','recorded_at',e.created_at) order by e.created_at),'[]') into failed_items
   from (select distinct on(job_id) * from private.gmoney_application_events where owner_user_id=pref.owner_user_id
    and created_at>=previous_cutoff and created_at<cutoff order by job_id,created_at desc,id desc) e
   join private.gmoney_application_jobs j on j.id=e.job_id where e.kind='failed';
  select max(last_seen_at) into seen from private.gmoney_application_connectors where owner_user_id=pref.owner_user_id;
  insert into private.gmoney_application_reports(owner_user_id,local_date,summary,confirmed,blocked,failed,worker_last_seen_at)
   values(pref.owner_user_id,today,format('Confirmed submissions: %s. Blocked or awaiting confirmation: %s. Failed attempts: %s.',
    jsonb_array_length(confirmed_items),jsonb_array_length(blocked_items),jsonb_array_length(failed_items)),confirmed_items,blocked_items,failed_items,seen)
   on conflict(owner_user_id,local_date) do nothing;
  get diagnostics inserted=row_count;
  generated:=generated+inserted;
 end loop;
 return generated;
end $fn$;

-- Every helper is private even if an older schema grants USAGE on private.
do $acl$
declare helper regprocedure;
begin
 for helper in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private' and (p.proname like 'gmoney_app_%' or p.proname='gmoney_build_due_application_reports') loop
  execute format('revoke all on function %s from public,anon,authenticated',helper);
 end loop;
end $acl$;
revoke all on function public.get_application_workspace(),public.save_application_answer(text,text,text),public.create_application_connector(text),
 public.revoke_application_connector(uuid),public.queue_application_draft(uuid,text),public.set_application_report_schedule(text,boolean) from public,anon;
grant execute on function public.get_application_workspace(),public.save_application_answer(text,text,text),public.create_application_connector(text),
 public.revoke_application_connector(uuid),public.queue_application_draft(uuid,text),public.set_application_report_schedule(text,boolean) to authenticated;
revoke all on function public.application_connector_rpc(text,text,jsonb) from public;
grant execute on function public.application_connector_rpc(text,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
