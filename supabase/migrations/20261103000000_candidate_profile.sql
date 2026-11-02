-- Extend the existing owner-protected preferences table; no public profile data.
begin;
alter table public.agent_preferences
  add column full_name text not null default '' check (length(full_name) <= 200),
  add column preferred_roles text not null default '' check (length(preferred_roles) <= 1000),
  add column sponsorship_need text not null default 'unspecified'
    check (sponsorship_need in ('unspecified','required_now','required_future','not_required')),
  add column resume_text text not null default '' check (length(resume_text) <= 50000);
-- Existing owner-only RLS policies and grants apply to these columns.
commit;
