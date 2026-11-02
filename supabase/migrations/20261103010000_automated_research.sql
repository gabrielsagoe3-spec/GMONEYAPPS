-- A worker may publish public employer research, with no candidate-data access.
-- Provision a random worker key separately; store only its SHA-256 hex digest in
-- private.gmoney_automation_credentials under name='publisher'. Never commit keys.
begin;
create schema if not exists private;
create table private.gmoney_automation_credentials (
  name text primary key check (name = 'publisher'),
  key_sha256 text not null check (key_sha256 ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz not null default now()
);
alter table private.gmoney_automation_credentials enable row level security;
revoke all on private.gmoney_automation_credentials from public, anon, authenticated;

create table private.gmoney_research_report_archive (
  id bigint generated always as identity primary key,
  archived_at timestamptz not null default now(),
  previous_published_at timestamptz not null,
  report jsonb not null
);
alter table private.gmoney_research_report_archive enable row level security;
revoke all on private.gmoney_research_report_archive from public, anon, authenticated;
revoke all on sequence private.gmoney_research_report_archive_id_seq from public, anon, authenticated;

create function public.publish_automated_research(report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  supplied_key text;
  expected_digest text;
  source jsonb;
  record jsonb;
  extra_source jsonb;
  entry record;
  automation jsonb;
  stats jsonb;
  started_at timestamptz;
  finished_at timestamptz;
  ok_count integer := 0;
  failed_count integer := 0;
  total_fetched integer := 0;
  old_report jsonb;
  old_published_at timestamptz;
  run_id text;
begin
  supplied_key := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-gmoney-research-key';
  select c.key_sha256 into expected_digest
    from private.gmoney_automation_credentials as c where c.name = 'publisher';
  if supplied_key is null or length(supplied_key) < 32 or length(supplied_key) > 256
     or expected_digest is null
     or encode(sha256(convert_to(supplied_key, 'UTF8')), 'hex') is distinct from expected_digest then
    raise exception 'Research publication is not authorized' using errcode = '42501';
  end if;

  if report is null or jsonb_typeof(report) <> 'object' or octet_length(report::text) > 2097152
     or report - array['updatedAt','mode','scope','summary','records','additionalSources','automation'] <> '{}'::jsonb then
    raise exception 'Invalid public research report' using errcode = '22023';
  end if;
  foreach run_id in array array['updatedAt','mode','scope','summary'] loop
    if jsonb_typeof(report -> run_id) is distinct from 'string' or length(report ->> run_id) > 8000 then
      raise exception 'Invalid research report text' using errcode = '22023';
    end if;
  end loop;
  if (report ->> 'updatedAt') !~ '^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(report -> 'records') is distinct from 'array'
     or jsonb_array_length(report -> 'records') > 1000
     or jsonb_typeof(report -> 'additionalSources') is distinct from 'array'
     or jsonb_array_length(report -> 'additionalSources') > 100 then
    raise exception 'Invalid research report collections' using errcode = '22023';
  end if;

  automation := report -> 'automation';
  if jsonb_typeof(automation) is distinct from 'object'
     or automation - array['runId','status','startedAt','finishedAt','execution','trigger','sources','stats'] <> '{}'::jsonb
     or jsonb_typeof(automation -> 'runId') is distinct from 'string'
     or length(automation ->> 'runId') not between 1 and 100
     or coalesce(automation ->> 'status', '') not in ('completed','partial')
     or coalesce(automation ->> 'execution', '') <> 'one_shot'
     or coalesce(automation ->> 'trigger', '') not in ('manual','scheduled')
     or jsonb_typeof(automation -> 'sources') is distinct from 'array'
     or jsonb_array_length(automation -> 'sources') not between 1 and 50 then
    raise exception 'Invalid completed research run' using errcode = '22023';
  end if;
  run_id := automation ->> 'runId';
  begin
    started_at := (automation ->> 'startedAt')::timestamptz;
    finished_at := (automation ->> 'finishedAt')::timestamptz;
  exception when others then
    raise exception 'Invalid research run timestamps' using errcode = '22023';
  end;
  if started_at is null or finished_at is null or finished_at < started_at or finished_at > now() + interval '5 minutes' then
    raise exception 'Invalid research run timestamps' using errcode = '22023';
  end if;
  if automation ->> 'status' = 'partial' and jsonb_array_length(report -> 'records') = 0 then
    raise exception 'Empty incomplete coverage cannot replace the previous report' using errcode = '22023';
  end if;
  stats := automation -> 'stats';
  if jsonb_typeof(stats) is distinct from 'object'
     or stats - array['fetched','relevant','selected','duplicates','new'] <> '{}'::jsonb then
    raise exception 'Invalid research counts' using errcode = '22023';
  end if;
  foreach supplied_key in array array['fetched','relevant','selected','duplicates','new'] loop
    if coalesce(stats ->> supplied_key, '') !~ '^\d{1,9}$' then
      raise exception 'Invalid research counts' using errcode = '22023';
    end if;
  end loop;
  if (stats ->> 'selected')::integer <> jsonb_array_length(report -> 'records')
     or (stats ->> 'new')::integer > (stats ->> 'selected')::integer
     or (stats ->> 'selected')::integer > (stats ->> 'relevant')::integer
     or (stats ->> 'relevant')::integer > (stats ->> 'fetched')::integer then
    raise exception 'Inconsistent research counts' using errcode = '22023';
  end if;

  for source in select value from jsonb_array_elements(automation -> 'sources') loop
    if jsonb_typeof(source) is distinct from 'object'
       or source - array['id','name','provider','url','status','fetched','invalid','error'] <> '{}'::jsonb
       or coalesce(source ->> 'status', '') not in ('ok','failed')
       or coalesce(source ->> 'fetched', '') !~ '^\d{1,9}$'
       or coalesce(source ->> 'invalid', '') !~ '^\d{1,9}$'
       or coalesce(source ->> 'url', '') !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?([/?#]|$)'
       or length(source ->> 'url') > 4000 then
      raise exception 'Invalid research source' using errcode = '22023';
    end if;
    for entry in select * from jsonb_each(source - array['fetched','invalid']) loop
      if jsonb_typeof(entry.value) is distinct from 'string' or length(entry.value #>> '{}') > 4000 then
        raise exception 'Invalid research source text' using errcode = '22023';
      end if;
    end loop;
    foreach supplied_key in array array['id','name','provider'] loop
      if jsonb_typeof(source -> supplied_key) is distinct from 'string' then
        raise exception 'Missing research source identity' using errcode = '22023';
      end if;
    end loop;
    if source ->> 'status' = 'ok' then ok_count := ok_count + 1;
    else failed_count := failed_count + 1; end if;
    total_fetched := total_fetched + (source ->> 'fetched')::integer;
  end loop;
  if ok_count = 0 or total_fetched <> (stats ->> 'fetched')::integer
     or (failed_count = 0 and automation ->> 'status' <> 'completed')
     or (failed_count > 0 and automation ->> 'status' <> 'partial') then
    raise exception 'Research source outcomes do not support publication' using errcode = '22023';
  end if;

  for record in select value from jsonb_array_elements(report -> 'records') loop
    if jsonb_typeof(record) is distinct from 'object'
       or record - array['id','company','title','location','decision','category','sponsorship','sponsorshipStatus','sponsorshipEvidence','finding','fit','next','url','checkedAt','retrievedAt','sourceType','sourceId','matchScore','matchReasons','exclusionReasons','verificationRequired','isNew'] <> '{}'::jsonb then
      raise exception 'Invalid public job record' using errcode = '22023';
    end if;
    foreach supplied_key in array array['id','company','title','location','decision','category','sponsorship','sponsorshipStatus','finding','fit','next','url','checkedAt','retrievedAt','sourceType','sourceId'] loop
      if jsonb_typeof(record -> supplied_key) is distinct from 'string' or length(record ->> supplied_key) > 20000 then
        raise exception 'Invalid public job record text' using errcode = '22023';
      end if;
    end loop;
    if coalesce(record ->> 'category','') not in ('verify','excluded')
       or coalesce(record ->> 'sponsorshipStatus','') not in ('not_offered','mentioned','unknown')
       or coalesce(record ->> 'sourceType','') <> 'employer_feed'
       or coalesce(record ->> 'url','') !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?([/?#]|$)'
       or (record -> 'verificationRequired') is distinct from 'true'::jsonb
       or jsonb_typeof(record -> 'isNew') is distinct from 'boolean'
       or coalesce(record ->> 'matchScore','') !~ '^\d{1,3}$' then
      raise exception 'Invalid public job assessment' using errcode = '22023';
    end if;
    foreach supplied_key in array array['sponsorshipEvidence','matchReasons','exclusionReasons'] loop
      if jsonb_typeof(record -> supplied_key) is distinct from 'array' or jsonb_array_length(record -> supplied_key) > 50 then
        raise exception 'Invalid job evidence' using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_array_elements(record -> supplied_key) as x(value)
                  where jsonb_typeof(x.value) <> 'string' or length(x.value #>> '{}') > 4000) then
        raise exception 'Invalid job evidence text' using errcode = '22023';
      end if;
    end loop;
  end loop;
  for extra_source in select value from jsonb_array_elements(report -> 'additionalSources') loop
    if jsonb_typeof(extra_source) is distinct from 'object'
       or extra_source - array['title','url','note'] <> '{}'::jsonb then
      raise exception 'Invalid additional source' using errcode = '22023';
    end if;
    foreach supplied_key in array array['title','url','note'] loop
      if jsonb_typeof(extra_source -> supplied_key) is distinct from 'string' or length(extra_source ->> supplied_key) > 4000 then
        raise exception 'Invalid additional source text' using errcode = '22023';
      end if;
    end loop;
    if (extra_source ->> 'url') !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?([/?#]|$)' then
      raise exception 'Invalid additional source URL' using errcode = '22023';
    end if;
  end loop;

  -- Serialize publication so concurrent runs preserve history and cannot regress.
  perform pg_advisory_xact_lock(hashtextextended('gmoney:research-publication', 0));
  select r.report, r.published_at into old_report, old_published_at
    from public.published_research_reports as r where r.slug = 'current' for update;
  if old_report #>> '{automation,runId}' = run_id then
    if old_report <> report then
      raise exception 'Research run ID was reused with different content' using errcode = '22023';
    end if;
    return jsonb_build_object('published', false, 'runId', run_id);
  end if;
  if old_report #>> '{automation,finishedAt}' is not null
     and (old_report #>> '{automation,finishedAt}')::timestamptz > finished_at then
    raise exception 'A newer research report is already published' using errcode = '22023';
  end if;
  if old_report is not null then
    insert into private.gmoney_research_report_archive(previous_published_at, report)
      values (old_published_at, old_report);
  end if;
  insert into public.published_research_reports(slug, report, published_at)
    values ('current', report, now())
    on conflict (slug) do update set report = excluded.report, published_at = excluded.published_at;
  return jsonb_build_object('published', true, 'runId', run_id);
end;
$function$;
revoke all on function public.publish_automated_research(jsonb) from public;
grant execute on function public.publish_automated_research(jsonb) to anon, authenticated;
comment on function public.publish_automated_research(jsonb) is
  'Publishes validated public employer research using a dedicated worker credential; no candidate-profile access.';
commit;
