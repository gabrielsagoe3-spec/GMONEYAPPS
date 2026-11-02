-- Synthetic credential/report are transaction-local and rolled back.
begin;
insert into private.gmoney_automation_credentials(name,key_sha256)
values ('publisher', encode(sha256(convert_to('test-only-research-key-never-use-live-0001','UTF8')),'hex'))
on conflict(name) do update set key_sha256=excluded.key_sha256;
create temporary table gmoney_test_report as select jsonb_build_object(
 'updatedAt',to_char(now(),'YYYY-MM-DD'),'mode','Synthetic test only','scope','Synthetic public research','summary','Empty feed test',
 'records','[]'::jsonb,'additionalSources','[]'::jsonb,
 'automation',jsonb_build_object('runId','gmoney-test-run','status','completed','startedAt',now(),'finishedAt',now(),
  'execution','one_shot','trigger','manual','sources',jsonb_build_array(jsonb_build_object('id','test','name','Synthetic','provider','greenhouse','url','https://example.invalid/jobs','status','ok','fetched',0,'invalid',0)),
  'stats',jsonb_build_object('fetched',0,'relevant',0,'selected',0,'duplicates',0,'new',0))) as data;
grant select on gmoney_test_report to anon;
set local role anon;
do $$ begin
 begin
  perform public.publish_automated_research((select data from gmoney_test_report));
  raise exception 'Missing-key publication allowed';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.headers','{"x-gmoney-research-key":"test-only-research-key-never-use-live-0001"}',true);
do $$ declare result jsonb; test_report jsonb := (select data from gmoney_test_report); begin
 result := public.publish_automated_research(test_report);
 if result->>'published' <> 'true' then raise exception 'Publication failed'; end if;
 result := public.publish_automated_research(test_report);
 if result->>'published' <> 'false' then raise exception 'Repeated report not idempotent'; end if;
 begin
  perform public.publish_automated_research(test_report || '{"resume_text":"private field"}'::jsonb);
  raise exception 'Unexpected private field accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.publish_automated_research(test_report || '{"summary":"Changed same-run content"}'::jsonb);
  raise exception 'Changed report reused run ID';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.publish_automated_research(jsonb_set(test_report,'{automation,runId}','"older-test-run"') || jsonb_build_object('automation',(test_report->'automation') || jsonb_build_object('runId','older-test-run','startedAt',now()-interval '1 hour','finishedAt',now()-interval '1 hour')));
  raise exception 'Stale run replaced newer report';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.publish_automated_research(jsonb_set(test_report,'{automation,status}','"partial"'));
  raise exception 'Empty partial coverage accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform key_sha256 from private.gmoney_automation_credentials;
  raise exception 'Anonymous credential-table read allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 if not exists(select 1 from private.gmoney_research_report_archive) then raise exception 'Previous report was not archived'; end if;
end $$;
rollback;
select 'passed: missing-key denial, restricted publication, idempotency, field allowlist, run-ID protection, stale-run protection, credential isolation, archival; all test writes rolled back' as result;
