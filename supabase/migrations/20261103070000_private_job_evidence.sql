-- Preserve selected PUBLIC posting text privately for accurate application review.
begin;
create table private.gmoney_job_evidence (
 job_id text primary key,
 company text not null,
 title text not null,
 location text not null,
 source_url text not null,
 description text not null,
 source_id text not null,
 retrieved_at timestamptz not null,
 updated_at timestamptz not null default now()
);
alter table private.gmoney_job_evidence enable row level security;
revoke all on private.gmoney_job_evidence from public,anon,authenticated;
create function public.cache_research_job_evidence(jobs jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $cache$
declare supplied_key text; expected_digest text; job jsonb; field text; n integer:=0; retrieved timestamptz;
begin
 supplied_key:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-gmoney-research-key';
 select key_sha256 into expected_digest from private.gmoney_automation_credentials where name='publisher';
 if supplied_key is null or length(supplied_key) not between 32 and 256 or expected_digest is null
  or encode(sha256(convert_to(supplied_key,'UTF8')),'hex') is distinct from expected_digest then
  raise exception 'Evidence caching is not authorized' using errcode='42501';
 end if;
 if jobs is null or jsonb_typeof(jobs)<>'array' or jsonb_array_length(jobs)>200 or octet_length(jobs::text)>2097152 then
  raise exception 'Invalid evidence collection' using errcode='22023';
 end if;
 for job in select value from jsonb_array_elements(jobs) loop
  if jsonb_typeof(job)<>'object' or job-array['id','company','title','location','url','description','sourceId','retrievedAt']<>'{}'::jsonb then
   raise exception 'Invalid evidence fields' using errcode='22023';
  end if;
  foreach field in array array['id','company','title','location','url','description','sourceId','retrievedAt'] loop
   if jsonb_typeof(job->field) is distinct from 'string' then raise exception 'Invalid evidence text' using errcode='22023'; end if;
  end loop;
  if length(job->>'id') not between 1 and 300 or length(job->>'company')>500 or length(job->>'title')>1000
   or length(job->>'location')>2000 or length(job->>'sourceId')>300 or length(job->>'description')>20000
   or length(job->>'url')>4000 or (job->>'url')!~'^https://[a-zA-Z0-9.-]+(:[0-9]+)?([/?#]|$)' then
   raise exception 'Evidence limits exceeded' using errcode='22023';
  end if;
  begin retrieved:=(job->>'retrievedAt')::timestamptz;
  exception when others then raise exception 'Invalid retrieval time' using errcode='22023'; end;
  if retrieved is null or retrieved>now()+interval '5 minutes' then raise exception 'Invalid retrieval time' using errcode='22023'; end if;
  insert into private.gmoney_job_evidence(job_id,company,title,location,source_url,description,source_id,retrieved_at)
   values(job->>'id',job->>'company',job->>'title',job->>'location',job->>'url',job->>'description',job->>'sourceId',retrieved)
   on conflict(job_id) do update set company=excluded.company,title=excluded.title,location=excluded.location,
    source_url=excluded.source_url,description=excluded.description,source_id=excluded.source_id,retrieved_at=excluded.retrieved_at,updated_at=now()
   where private.gmoney_job_evidence.retrieved_at<=excluded.retrieved_at;
  n:=n+1;
 end loop;
 return jsonb_build_object('cached',n);
end;
$cache$;
revoke all on function public.cache_research_job_evidence(jsonb) from public;
grant execute on function public.cache_research_job_evidence(jsonb) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
