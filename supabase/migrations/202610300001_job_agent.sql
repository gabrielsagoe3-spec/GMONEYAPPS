-- Prepared migration; NOT applied to any Supabase project.
-- Research and application records are written only by a trusted backend.
begin;
create table public.agent_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  instructions text not null default '',
  locations text[] not null default '{}',
  minimum_salary integer check (minimum_salary >= 0),
  updated_at timestamptz not null default now()
);
create table public.research_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  scope text not null,
  summary text not null default '',
  status text not null check (status in ('running','completed','failed')),
  unique (id, user_id)
);
create table public.job_findings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  company text not null,
  title text not null,
  location text,
  source_url text not null check (source_url ~ '^https://'),
  checked_at timestamptz not null,
  decision text not null check (decision in ('verify','ready','excluded','closed')),
  sponsorship_status text not null check (sponsorship_status in ('stated','not_offered','unknown')),
  sponsorship_evidence text not null default '',
  fit_assessment text not null,
  finding text not null,
  next_action text not null,
  unique (id, user_id),
  unique (user_id, source_url),
  foreign key (run_id, user_id) references public.research_runs(id, user_id) on delete cascade
);
create table public.application_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  finding_id uuid not null,
  status text not null check (status in ('preparing','needs_input','ready_for_review','submitted','failed')),
  submission_confirmation text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, finding_id),
  foreign key (finding_id, user_id) references public.job_findings(id, user_id) on delete cascade,
  check (status <> 'submitted' or (submitted_at is not null and length(trim(submission_confirmation)) > 0 and submission_confirmation is not null))
);
alter table public.agent_preferences enable row level security;
alter table public.research_runs enable row level security;
alter table public.job_findings enable row level security;
alter table public.application_records enable row level security;
revoke all on public.agent_preferences, public.research_runs, public.job_findings, public.application_records from anon, authenticated;
grant select, insert, update on public.agent_preferences to authenticated;
grant select on public.research_runs, public.job_findings, public.application_records to authenticated;
grant all on public.agent_preferences, public.research_runs, public.job_findings, public.application_records to service_role;
create policy preferences_read on public.agent_preferences for select to authenticated using ((select auth.uid()) = user_id);
create policy preferences_insert on public.agent_preferences for insert to authenticated with check ((select auth.uid()) = user_id);
create policy preferences_update on public.agent_preferences for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy runs_read on public.research_runs for select to authenticated using ((select auth.uid()) = user_id);
create policy findings_read on public.job_findings for select to authenticated using ((select auth.uid()) = user_id);
create policy applications_read on public.application_records for select to authenticated using ((select auth.uid()) = user_id);
create index research_runs_owner on public.research_runs(user_id);
create index job_findings_owner on public.job_findings(user_id);
create index application_records_owner on public.application_records(user_id);
commit;
