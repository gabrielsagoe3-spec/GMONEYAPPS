-- Resume documents remain private until their email owner verifies sign-in.
-- No candidate data or generated document values belong in this migration.
begin;
create schema if not exists private;

create function private.gmoney_import_preferences_valid(preferences jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $validation$
declare
  field text;
  location jsonb;
begin
  if preferences is null or jsonb_typeof(preferences) <> 'object'
     or preferences - array['preferred_roles','instructions','locations','minimum_salary','sponsorship_need'] <> '{}'::jsonb then
    return false;
  end if;
  foreach field in array array['preferred_roles','instructions'] loop
    if preferences ? field and
       (jsonb_typeof(preferences -> field) <> 'string'
        or length(preferences ->> field) > case when field = 'preferred_roles' then 1000 else 10000 end) then
      return false;
    end if;
  end loop;
  if preferences ? 'locations' then
    if jsonb_typeof(preferences -> 'locations') <> 'array' or jsonb_array_length(preferences -> 'locations') > 100 then
      return false;
    end if;
    for location in select value from jsonb_array_elements(preferences -> 'locations') loop
      if jsonb_typeof(location) <> 'string' or length(location #>> '{}') > 2000 then return false; end if;
    end loop;
  end if;
  if preferences ? 'minimum_salary' and preferences -> 'minimum_salary' <> 'null'::jsonb then
    if jsonb_typeof(preferences -> 'minimum_salary') <> 'number'
       or (preferences ->> 'minimum_salary') !~ '^\d{1,10}$' then return false; end if;
    if (preferences ->> 'minimum_salary')::numeric > 2147483647 then return false; end if;
  end if;
  if preferences ? 'sponsorship_need' and
     (jsonb_typeof(preferences -> 'sponsorship_need') <> 'string'
      or preferences ->> 'sponsorship_need' not in ('unspecified','required_now','required_future','not_required')) then
    return false;
  end if;
  return true;
end;
$validation$;
revoke all on function private.gmoney_import_preferences_valid(jsonb) from public, anon, authenticated;

create table private.gmoney_candidate_documents (
  document_sha256 text primary key check (document_sha256 ~ '^[a-f0-9]{64}$'),
  full_name text not null default '' check (length(full_name) <= 200),
  contact_email text not null check (length(contact_email) between 3 and 320
    and contact_email = btrim(contact_email) and contact_email !~ '\s' and position('@' in contact_email) > 1),
  resume_text text not null check (length(resume_text) <= 50000 and length(btrim(resume_text)) > 0),
  preferences jsonb not null default '{}' check (private.gmoney_import_preferences_valid(preferences)),
  owner_user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index gmoney_candidate_documents_email_idx on private.gmoney_candidate_documents(lower(contact_email));
alter table private.gmoney_candidate_documents enable row level security;
revoke all on private.gmoney_candidate_documents from public, anon, authenticated;

create function public.claim_candidate_profile()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $claim$
declare
  current_user_id uuid := auth.uid();
  verified_email text;
  candidate private.gmoney_candidate_documents%rowtype;
  imported_user_id uuid;
begin
  select u.email into verified_email from auth.users as u
    where u.id = current_user_id and u.email_confirmed_at is not null;
  if current_user_id is null or verified_email is null then
    raise exception 'Verified sign-in is required' using errcode = '42501';
  end if;
  select d.* into candidate from private.gmoney_candidate_documents as d
    where lower(d.contact_email) = lower(verified_email)
      and (d.owner_user_id is null or d.owner_user_id = current_user_id)
    order by d.created_at desc, d.document_sha256
    limit 1 for update;
  if not found then return jsonb_build_object('imported',false); end if;

  -- Import only into a missing profile or an empty resume. Preserve user edits.
  insert into public.agent_preferences as existing
    (user_id,full_name,resume_text,preferred_roles,instructions,locations,minimum_salary,sponsorship_need)
    values (
      current_user_id,candidate.full_name,candidate.resume_text,
      coalesce(candidate.preferences ->> 'preferred_roles',''),
      coalesce(candidate.preferences ->> 'instructions',''),
      array(select value from jsonb_array_elements_text(coalesce(candidate.preferences -> 'locations','[]'::jsonb)) as locations(value)),
      (candidate.preferences ->> 'minimum_salary')::integer,
      coalesce(candidate.preferences ->> 'sponsorship_need','unspecified')
    )
    on conflict (user_id) do update set
      full_name = case when btrim(existing.full_name) = '' then excluded.full_name else existing.full_name end,
      resume_text = excluded.resume_text,
      preferred_roles = case when btrim(existing.preferred_roles) = '' then excluded.preferred_roles else existing.preferred_roles end,
      instructions = case when btrim(existing.instructions) = '' then excluded.instructions else existing.instructions end,
      locations = case when cardinality(existing.locations) = 0 then excluded.locations else existing.locations end,
      minimum_salary = coalesce(existing.minimum_salary,excluded.minimum_salary),
      sponsorship_need = case when existing.sponsorship_need = 'unspecified' then excluded.sponsorship_need else existing.sponsorship_need end,
      updated_at = now()
    where btrim(existing.resume_text) = ''
    returning user_id into imported_user_id;
  update private.gmoney_candidate_documents set owner_user_id = current_user_id
    where document_sha256 = candidate.document_sha256;
  return jsonb_build_object('imported',imported_user_id is not null);
end;
$claim$;
revoke all on function public.claim_candidate_profile() from public, anon;
grant execute on function public.claim_candidate_profile() to authenticated;
comment on function public.claim_candidate_profile() is
  'Imports private staged resume data only for its verified email owner; preserves saved profiles.';
notify pgrst, 'reload schema';
commit;
