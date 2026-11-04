-- Administrator-only regression check. Synthetic .invalid fixtures; all changes roll back.
begin;
create temporary table application_connector_fixtures (
 principal text primary key,user_id uuid not null default gen_random_uuid(),email text not null,
 document_sha256 text not null,draft_id uuid not null default gen_random_uuid(),
 second_draft_id uuid not null default gen_random_uuid(),third_draft_id uuid not null default gen_random_uuid()
) on commit drop;
create temporary table application_connector_state(key text primary key,value jsonb not null) on commit drop;
grant select on application_connector_fixtures to anon,authenticated;
grant select,insert,update on application_connector_state to anon,authenticated;
insert into application_connector_fixtures(principal,email,document_sha256)
 select name,'gmoney-connector-'||name||'-'||gen_random_uuid()::text||'@example.invalid',
 encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex') from (values('owner'),('other'),('unverified')) n(name);
insert into auth.users(id,email,email_confirmed_at)
 select user_id,email,case when principal='unverified' then null else now() end from application_connector_fixtures;
insert into private.gmoney_candidate_documents(document_sha256,full_name,contact_email,resume_text,owner_user_id)
 select document_sha256,'Synthetic connector candidate',email,'Synthetic resume facts only.',user_id from application_connector_fixtures;
insert into public.agent_preferences(user_id,full_name,resume_text,instructions)
 select user_id,'Synthetic connector candidate','Synthetic resume facts only.','Synthetic user instructions.' from application_connector_fixtures;
insert into private.gmoney_application_drafts(id,document_sha256,job_id,company,title,source_url)
 select draft_id,document_sha256,'synthetic-connector-'||principal,'Synthetic Employer','Synthetic Analyst',
 'https://job-boards.greenhouse.io/synthetic/jobs/'||principal from application_connector_fixtures
 union all select second_draft_id,document_sha256,'synthetic-connector-second-'||principal,'Synthetic Employer','Synthetic Operations',
 'https://job-boards.greenhouse.io/synthetic/jobs/second-'||principal from application_connector_fixtures
 union all select third_draft_id,document_sha256,'synthetic-connector-third-'||principal,'Synthetic Employer','Synthetic Coordinator',
 'https://job-boards.greenhouse.io/synthetic/jobs/third-'||principal from application_connector_fixtures;

do $test$
declare object_name text; helper regprocedure;
begin
 foreach object_name in array array['private.gmoney_application_answers','private.gmoney_application_connectors','private.gmoney_application_jobs','private.gmoney_application_events','private.gmoney_application_report_preferences','private.gmoney_application_reports'] loop
  if not(select relrowsecurity from pg_class where oid=object_name::regclass)
   or has_table_privilege('anon',object_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_table_privilege('authenticated',object_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
   raise exception 'Private application table protection failed'; end if;
 end loop;
 for helper in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private' and (p.proname like 'gmoney_app_%' or p.proname='gmoney_build_due_application_reports') loop
  if has_function_privilege('anon',helper,'EXECUTE') or has_function_privilege('authenticated',helper,'EXECUTE') then
   raise exception 'Private application helper exposed'; end if;
 end loop;
 if has_function_privilege('anon','public.get_application_workspace()','EXECUTE')
  or not has_function_privilege('authenticated','public.get_application_workspace()','EXECUTE')
  or not has_function_privilege('anon','public.application_connector_rpc(text,text,jsonb)','EXECUTE') then raise exception 'Application RPC grants failed'; end if;
end $test$;

set local role authenticated;
do $test$
declare ws jsonb; token_data jsonb; queued jsonb; repeated jsonb;
begin
 perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_connector_fixtures where principal='owner'),true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('request.jwt.claim.sub'),'role','authenticated')::text,true);
 ws:=public.get_application_workspace();
 if ws->'answers'<>'[]'::jsonb or ws->'jobs'<>'[]'::jsonb or ws#>>'{report_preferences,enabled}'<>'false' then raise exception 'Workspace invented data or enabled an unrelated schedule'; end if;
 perform public.save_application_answer('first_name','First name','Synthetic');
 begin perform public.save_application_answer('bad_secret','Never store a connector credential','gmcp_'||repeat('0',64)); raise exception 'Credential-shaped answer stored'; exception when invalid_parameter_value then null; end;
 if public.get_application_workspace()#>>'{answers,0,answer}'<>'Synthetic' then raise exception 'Confirmed answer not saved'; end if;
 token_data:=public.create_application_connector('Synthetic Windows runner');
 insert into pg_temp.application_connector_state values('owner_token',token_data),('owner_second_token',public.create_application_connector('Second synthetic runner'));
 ws:=public.get_application_workspace();
 if position(token_data->>'token' in ws::text)>0 or position('token_sha256' in ws::text)>0 then raise exception 'Workspace revealed connector credentials'; end if;
 begin
  perform public.queue_application_draft((select draft_id from pg_temp.application_connector_fixtures where principal='other'));
  raise exception 'Cross-owner queue allowed';
 exception when insufficient_privilege then null; end;
 queued:=public.queue_application_draft((select draft_id from pg_temp.application_connector_fixtures where principal='owner'),'prepare');
 repeated:=public.queue_application_draft((select draft_id from pg_temp.application_connector_fixtures where principal='owner'),'submit');
 if queued->>'id'<>repeated->>'id' or repeated->>'mode'<>'prepare' then raise exception 'Queue idempotency failed'; end if;
 insert into pg_temp.application_connector_state values('first_job',queued);
 perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_connector_fixtures where principal='other'),true);
 ws:=public.get_application_workspace();
 if ws->'answers'<>'[]'::jsonb or ws->'jobs'<>'[]'::jsonb or ws->'reports'<>'[]'::jsonb then raise exception 'Owner workspace crossed accounts'; end if;
 insert into pg_temp.application_connector_state values('other_token',public.create_application_connector('Other synthetic runner'));
 if public.revoke_application_connector((token_data->>'id')::uuid)->>'revoked'<>'false' then raise exception 'Cross-owner token revoke allowed'; end if;
 perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_connector_fixtures where principal='unverified'),true);
 begin perform public.get_application_workspace(); raise exception 'Unverified workspace allowed'; exception when insufficient_privilege then null; end;
 begin perform public.create_application_connector('Not verified'); raise exception 'Unverified connector allowed'; exception when insufficient_privilege then null; end;
end $test$;

set local role anon;
do $test$
declare token text; alternate text; other_token text; lease jsonb; ws jsonb; result jsonb; payload jsonb; proof jsonb;
begin
 token:=(select value->>'token' from pg_temp.application_connector_state where key='owner_token');
 alternate:=(select value->>'token' from pg_temp.application_connector_state where key='owner_second_token');
 other_token:=(select value->>'token' from pg_temp.application_connector_state where key='other_token');
 begin perform public.application_connector_rpc('gmcp_'||repeat('0',64),'workspace'); raise exception 'Unknown token allowed'; exception when insufficient_privilege then null; end;
 begin perform public.get_application_workspace(); raise exception 'Anonymous owner workspace allowed'; exception when insufficient_privilege then null; end;
 ws:=public.application_connector_rpc(token,'workspace');
 if jsonb_array_length(ws->'answers')<>1 or ws#>>'{candidate,resume_text}'<>'Synthetic resume facts only.' or jsonb_array_length(ws->'drafts')<>3 then raise exception 'Scoped workspace incomplete'; end if;
 if exists(select 1 from jsonb_array_elements(ws->'answers') a where a->>'key'='authorized_to_work') then raise exception 'Unknown authorization fact was invented'; end if;
 if jsonb_array_length(public.application_connector_rpc(other_token,'workspace')->'answers')<>0 then raise exception 'Scoped connector crossed answers'; end if;
 lease:=public.application_connector_rpc(token,'claim','{"worker_id":"synthetic-windows"}');
 if lease#>>'{job,status}'<>'running' or lease->>'lease_token' is null then raise exception 'Queued job was not leased'; end if;
 insert into pg_temp.application_connector_state values('first_lease',lease);
 if public.application_connector_rpc(token,'claim','{"worker_id":"synthetic-windows"}')->'job'<>'null'::jsonb then raise exception 'Running job was claimed twice'; end if;
 payload:=jsonb_build_object('job_id',lease#>>'{job,id}','lease_token',lease->>'lease_token');
 begin perform public.application_connector_rpc(alternate,'result',payload||'{"status":"failed"}'); raise exception 'A different connector hijacked a lease'; exception when insufficient_privilege then null; end;
 begin perform public.application_connector_rpc(other_token,'result',payload||'{"status":"failed"}'); raise exception 'A different owner hijacked a lease'; exception when insufficient_privilege then null; end;
 begin perform public.application_connector_rpc(token,'before_submit',payload); raise exception 'Prepare-mode job entered submission'; exception when invalid_parameter_value then null; end;
 proof:=jsonb_build_object('source_url',lease#>>'{job,source_url}','adapter','greenhouse','confirmation_text','Thank you for applying.','confirmed_at',clock_timestamp());
 begin perform public.application_connector_rpc(token,'result',payload||jsonb_build_object('status','submitted','receipt',proof)); raise exception 'Submission accepted without checkpoint'; exception when invalid_parameter_value then null; end;
 result:=public.application_connector_rpc(token,'result',payload||jsonb_build_object('status','needs_input','questions',jsonb_build_array(jsonb_build_object('key','question_synthetic','question','Are you legally authorized for this job?','reason','This fact is unknown.'))));
 if result->>'status'<>'needs_input' or result#>>'{questions,0,key}'<>'question_synthetic' then raise exception 'Unknown question was not retained'; end if;
 begin perform public.application_connector_rpc(token,'result',payload||'{"status":"submitted"}'); raise exception 'Completed lease accepted a second outcome'; exception when insufficient_privilege then null; end;
end $test$;

set local role authenticated;
do $test$
declare token text; queued jsonb;
begin
 perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_connector_fixtures where principal='owner'),true);
 perform public.save_application_answer('question_synthetic','Are you legally authorized for this job?','Synthetic fact supplied only in a test.');
 queued:=public.queue_application_draft((select draft_id from pg_temp.application_connector_fixtures where principal='owner'),'submit');
 if queued->>'status'<>'queued' then raise exception 'Explicit reviewed retry was not queued'; end if;
end $test$;
set local role anon;
do $test$
declare token text; lease jsonb; payload jsonb; proof jsonb; result jsonb;
begin
 token:=(select value->>'token' from pg_temp.application_connector_state where key='owner_token');
 lease:=public.application_connector_rpc(token,'claim','{"worker_id":"synthetic-windows"}');
 payload:=jsonb_build_object('job_id',lease#>>'{job,id}','lease_token',lease->>'lease_token');
 if lease#>>'{job,attempt}'<>'2' then raise exception 'Attempt number did not advance'; end if;
 perform public.application_connector_rpc(token,'before_submit',payload);
 proof:=jsonb_build_object('source_url','https://example.invalid/wrong-job','adapter','greenhouse','confirmation_text','Thank you for applying.','confirmed_at',clock_timestamp());
 begin perform public.application_connector_rpc(token,'result',payload||jsonb_build_object('status','submitted','receipt',proof)); raise exception 'Unmatched receipt accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.application_connector_rpc(token,'result',payload||'{"status":"failed"}'); raise exception 'Post-click failure became retryable'; exception when invalid_parameter_value then null; end;
 proof:=proof||jsonb_build_object('source_url',lease#>>'{job,source_url}');
 result:=public.application_connector_rpc(token,'result',payload||jsonb_build_object('status','submitted','receipt',proof));
 if result->>'status'<>'submitted' or result#>>'{receipt,confirmation_text}'<>'Thank you for applying.' then raise exception 'Confirmed result missing'; end if;
 insert into pg_temp.application_connector_state values('submitted_job',result);
 begin perform public.application_connector_rpc(token,'result',payload||'{"status":"failed"}'); raise exception 'Submitted result was overwritten'; exception when insufficient_privilege then null; end;
end $test$;

set local role authenticated;
do $test$
declare returned jsonb;
begin
 returned:=public.queue_application_draft((select draft_id from pg_temp.application_connector_fixtures where principal='owner'));
 if returned->>'status'<>'submitted' then raise exception 'Submitted job was requeued'; end if;
 perform public.queue_application_draft((select second_draft_id from pg_temp.application_connector_fixtures where principal='owner'));
end $test$;
set local role anon;
do $test$
declare token text; lease jsonb;
begin
 token:=(select value->>'token' from pg_temp.application_connector_state where key='owner_token');
 lease:=public.application_connector_rpc(token,'claim','{"worker_id":"synthetic-windows"}');
 perform public.application_connector_rpc(token,'before_submit',jsonb_build_object('job_id',lease#>>'{job,id}','lease_token',lease->>'lease_token'));
 insert into pg_temp.application_connector_state values('uncertain_lease',lease);
end $test$;
reset role;
update private.gmoney_application_jobs set lease_expires_at=clock_timestamp()-interval '1 minute'
 where id=(select (value#>>'{job,id}')::uuid from application_connector_state where key='uncertain_lease');
set local role anon;
do $test$
declare token text; ws jsonb;
begin
 token:=(select value->>'token' from pg_temp.application_connector_state where key='owner_token');
 ws:=public.application_connector_rpc(token,'workspace');
 if not exists(select 1 from jsonb_array_elements(ws->'jobs') j where j->>'status'='needs_confirmation') then raise exception 'Expired submission lost uncertainty checkpoint'; end if;
 if public.application_connector_rpc(token,'claim','{"worker_id":"synthetic-windows"}')->'job'<>'null'::jsonb then raise exception 'Uncertain application was retried automatically'; end if;
end $test$;
set local role authenticated;
do $test$
begin
 if public.queue_application_draft((select second_draft_id from pg_temp.application_connector_fixtures where principal='owner'))->>'status'<>'needs_confirmation' then raise exception 'Uncertain submission was requeued'; end if;
 perform public.queue_application_draft((select third_draft_id from pg_temp.application_connector_fixtures where principal='owner'));
 perform public.set_application_report_schedule('00:00',true);
end $test$;
set local role anon;
do $test$
declare token text; lease jsonb;
begin
 token:=(select value->>'token' from pg_temp.application_connector_state where key='owner_token');
 lease:=public.application_connector_rpc(token,'claim','{"worker_id":"synthetic-windows"}');
 perform public.application_connector_rpc(token,'result',jsonb_build_object('job_id',lease#>>'{job,id}','lease_token',lease->>'lease_token','status','failed','error','Synthetic browser failure.'));
end $test$;
reset role;
-- Move only the synthetic event times into the last completed nightly window.
update private.gmoney_application_events e set created_at=(((clock_timestamp() at time zone 'America/Chicago')::date+time '00:00') at time zone 'America/Chicago')-interval '1 hour'+e.id*interval '1 microsecond'
 where e.owner_user_id=(select user_id from application_connector_fixtures where principal='owner');
do $test$
declare count_before integer; built integer; report private.gmoney_application_reports;
begin
 select count(*) into count_before from private.gmoney_application_reports;
 built:=private.gmoney_build_due_application_reports();
 select * into report from private.gmoney_application_reports where owner_user_id=(select user_id from pg_temp.application_connector_fixtures where principal='owner');
 if report.id is null or jsonb_array_length(report.confirmed)<>1 or jsonb_array_length(report.blocked)<>1 or jsonb_array_length(report.failed)<>1 then raise exception 'Nightly report did not separate actual outcomes'; end if;
 if report.blocked->0->>'status'<>'needs_confirmation' then raise exception 'Resolved historical block was reported as currently blocked'; end if;
 perform private.gmoney_build_due_application_reports();
 if (select count(*) from private.gmoney_application_reports where owner_user_id=(select user_id from pg_temp.application_connector_fixtures where principal='owner'))<>1 then raise exception 'Nightly report duplicated'; end if;
 if (select count(*) from private.gmoney_application_events where kind='submitted' and owner_user_id=(select user_id from pg_temp.application_connector_fixtures where principal='owner'))<>1 then raise exception 'Confirmed receipts duplicated'; end if;
end $test$;
set local role authenticated;
do $test$
declare data jsonb; token_id uuid;
begin
 data:=public.get_application_workspace();
 if jsonb_array_length(data->'reports')<>1 then raise exception 'Owner cannot read nightly report'; end if;
 select (value->>'id')::uuid into token_id from pg_temp.application_connector_state where key='owner_token';
 perform public.revoke_application_connector(token_id);
 perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_connector_fixtures where principal='other'),true);
 if public.get_application_workspace()->'reports'<>'[]'::jsonb then raise exception 'Nightly report crossed owners'; end if;
end $test$;
set local role anon;
do $test$
begin
 begin perform public.application_connector_rpc((select value->>'token' from pg_temp.application_connector_state where key='owner_token'),'workspace'); raise exception 'Revoked connector authenticated'; exception when insufficient_privilege then null; end;
end $test$;
reset role;
-- Memory/workspace reads must not masquerade as a connected browser worker.
do $test$
begin
 if exists(select 1 from private.gmoney_application_connectors where id=(select (value->>'id')::uuid from pg_temp.application_connector_state where key='other_token') and last_seen_at is not null) then
  raise exception 'Read-only MCP use masqueraded as a worker heartbeat'; end if;
end $test$;
-- Expiry is checked independently of revocation.
update private.gmoney_application_connectors set expires_at=clock_timestamp()-interval '1 minute'
 where id=(select (value->>'id')::uuid from application_connector_state where key='owner_second_token');
set local role anon;
do $test$
begin
 begin perform public.application_connector_rpc((select value->>'token' from pg_temp.application_connector_state where key='owner_second_token'),'workspace'); raise exception 'Expired connector authenticated'; exception when insufficient_privilege then null; end;
end $test$;
reset role;
rollback;
select 'passed: private connector ownership, answers, leases, immutable receipts, uncertainty, expiry and nightly reports; fixtures rolled back' as result;
