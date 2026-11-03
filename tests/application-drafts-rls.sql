-- Run as a database administrator after the private draft migrations.
-- Only synthetic .invalid identities are created. All fixtures are rolled back.
begin;
create temporary table application_drafts_test_fixtures (
  principal text primary key,
  user_id uuid not null default gen_random_uuid(),
  email text not null,
  document_sha256 text not null,
  draft_id uuid not null default gen_random_uuid()
) on commit drop;
insert into application_drafts_test_fixtures(principal,email,document_sha256)
select principal,
       'gmoney-drafts-' || principal || '-' || gen_random_uuid()::text || '@example.invalid',
       encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex')
from (values ('owner'),('other'),('unverified'),('email_mismatch')) as names(principal);
grant select on application_drafts_test_fixtures to authenticated,anon;
insert into auth.users(id,email,email_confirmed_at)
select user_id,email,case when principal='unverified' then null else now() end
from application_drafts_test_fixtures where principal<>'email_mismatch';
insert into private.gmoney_candidate_documents(document_sha256,full_name,contact_email,resume_text,owner_user_id)
select f.document_sha256,'Synthetic draft test candidate',
       case when f.principal='email_mismatch' then o.email else f.email end,
       'Synthetic experience used only for database isolation checks.',
       case when f.principal='owner' then null
            when f.principal='email_mismatch' then u.user_id else f.user_id end
from application_drafts_test_fixtures f
cross join application_drafts_test_fixtures o
cross join application_drafts_test_fixtures u
where o.principal='other' and u.principal='owner';
insert into private.gmoney_application_drafts
  (id,document_sha256,job_id,company,title,source_url,tailored_summary,cover_letter,match_notes,missing_answers)
select draft_id,document_sha256,'synthetic-job-' || principal,'Synthetic Employer',
       'Synthetic Business Analyst','https://example.invalid/jobs/synthetic',
       'Synthetic summary.','Synthetic cover letter.','["Synthetic match note"]'::jsonb,
       '["Confirm synthetic answer"]'::jsonb
from application_drafts_test_fixtures;

-- RLS and ACL assertions inspect metadata, never existing candidate rows.
do $test$
declare table_name text; role_name text;
begin
  foreach table_name in array array['private.gmoney_candidate_documents','private.gmoney_application_drafts'] loop
    if not (select relrowsecurity from pg_class where oid=table_name::regclass) then
      raise exception 'Private table has row security disabled';
    end if;
    foreach role_name in array array['anon','authenticated'] loop
      if has_table_privilege(role_name,table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'Browser role has a private-table privilege';
      end if;
    end loop;
  end loop;
end;
$test$;

set local role authenticated;
do $test$
begin
  perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_drafts_test_fixtures where principal='owner'),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('request.jwt.claim.sub'),'role','authenticated')::text,true);
  if public.list_candidate_application_drafts()<>'[]'::jsonb then
    raise exception 'Unbound or email-mismatched drafts were exposed';
  end if;
  if public.claim_candidate_profile()->>'imported'<>'true' then
    raise exception 'Verified owner could not bind the synthetic document';
  end if;
end;
$test$;
reset role;
do $test$
begin
  if not exists (
    select 1 from private.gmoney_candidate_documents d
    join pg_temp.application_drafts_test_fixtures f using(document_sha256)
    where f.principal='owner' and d.owner_user_id=f.user_id
  ) then raise exception 'Claim did not bind the synthetic owner'; end if;
end;
$test$;

set local role authenticated;
do $test$
declare drafts jsonb; item jsonb; fixture record;
begin
  drafts:=public.list_candidate_application_drafts();
  if jsonb_typeof(drafts)<>'array' or jsonb_array_length(drafts)<>1
     or drafts->0->>'id'<>(select draft_id::text from pg_temp.application_drafts_test_fixtures where principal='owner') then
    raise exception 'Verified owner did not receive only their bound draft';
  end if;
  for item in select value from jsonb_array_elements(drafts) loop
    if not item ?& array['id','job_id','company','title','location','source_url','status','tailored_summary','cover_letter','match_notes','missing_answers','created_at']
       or item-array['id','job_id','company','title','location','source_url','status','tailored_summary','cover_letter','match_notes','missing_answers','created_at']<>'{}'::jsonb
       or item->>'status'<>'needs_input' then
      raise exception 'Draft RPC returned unexpected fields or status';
    end if;
  end loop;
  for fixture in select email,document_sha256 from pg_temp.application_drafts_test_fixtures loop
    if position(fixture.email in drafts::text)>0 or position(fixture.document_sha256 in drafts::text)>0 then
      raise exception 'Draft RPC leaked document identity';
    end if;
  end loop;
  begin
    perform document_sha256 from private.gmoney_candidate_documents
      where document_sha256 in (select document_sha256 from pg_temp.application_drafts_test_fixtures);
    raise exception 'Authenticated direct document read was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform document_sha256 from private.gmoney_application_drafts
      where document_sha256 in (select document_sha256 from pg_temp.application_drafts_test_fixtures);
    raise exception 'Authenticated direct draft read was allowed';
  exception when insufficient_privilege then null; end;
end;
$test$;

-- A second verified account can see its own fixture, never the first account's.
do $test$
declare drafts jsonb;
begin
  perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_drafts_test_fixtures where principal='other'),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('request.jwt.claim.sub'),'role','authenticated')::text,true);
  drafts:=public.list_candidate_application_drafts();
  if jsonb_array_length(drafts)<>1
     or drafts->0->>'id'<>(select draft_id::text from pg_temp.application_drafts_test_fixtures where principal='other') then
    raise exception 'Cross-account draft isolation failed';
  end if;
end;
$test$;

-- Verification is checked in auth.users, not accepted from a JWT email claim.
do $test$
begin
  perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_drafts_test_fixtures where principal='unverified'),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('request.jwt.claim.sub'),'role','authenticated','email_verified',true)::text,true);
  begin
    perform public.list_candidate_application_drafts();
    raise exception 'Unverified draft listing was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_candidate_profile();
    raise exception 'Unverified document claim was allowed';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  begin
    perform public.list_candidate_application_drafts();
    raise exception 'Missing-subject draft listing was allowed';
  exception when insufficient_privilege then null; end;
end;
$test$;

set local role anon;
do $test$
begin
  perform set_config('request.jwt.claim.sub',(select user_id::text from pg_temp.application_drafts_test_fixtures where principal='owner'),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('request.jwt.claim.sub'),'role','anon')::text,true);
  begin
    perform public.list_candidate_application_drafts();
    raise exception 'Anonymous draft RPC execution was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform document_sha256 from private.gmoney_candidate_documents
      where document_sha256 in (select document_sha256 from pg_temp.application_drafts_test_fixtures);
    raise exception 'Anonymous direct document read was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform document_sha256 from private.gmoney_application_drafts
      where document_sha256 in (select document_sha256 from pg_temp.application_drafts_test_fixtures);
    raise exception 'Anonymous direct draft read was allowed';
  exception when insufficient_privilege then null; end;
end;
$test$;
reset role;
rollback;
select 'passed: private application draft isolation; synthetic fixtures rolled back' as result;
