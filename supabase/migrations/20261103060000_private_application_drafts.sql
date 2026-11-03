-- Application preparation is private. Drafts are not submission records.
begin;
create function private.gmoney_draft_text_array_valid(items jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $validation$
declare item jsonb;
begin
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 50 then return false; end if;
  for item in select value from jsonb_array_elements(items) loop
    if jsonb_typeof(item) <> 'string' or length(item #>> '{}') > 4000 then return false; end if;
  end loop;
  return true;
end;
$validation$;
revoke all on function private.gmoney_draft_text_array_valid(jsonb) from public, anon, authenticated;

create table private.gmoney_application_drafts (
  id uuid primary key default gen_random_uuid(),
  document_sha256 text not null references private.gmoney_candidate_documents(document_sha256) on delete cascade,
  job_id text not null check (length(job_id) between 1 and 300),
  company text not null check (length(company) between 1 and 500),
  title text not null check (length(title) between 1 and 500),
  location text not null default '' check (length(location) <= 1000),
  source_url text not null check (length(source_url) <= 4000 and source_url ~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?([/?#]|$)'),
  status text not null default 'needs_input' check (status = 'needs_input'),
  tailored_summary text not null default '' check (length(tailored_summary) <= 6000),
  cover_letter text not null default '' check (length(cover_letter) <= 20000),
  match_notes jsonb not null default '[]' check (private.gmoney_draft_text_array_valid(match_notes)),
  missing_answers jsonb not null default '[]' check (private.gmoney_draft_text_array_valid(missing_answers)),
  created_at timestamptz not null default now(),
  unique(document_sha256,job_id)
);
alter table private.gmoney_application_drafts enable row level security;
revoke all on private.gmoney_application_drafts from public, anon, authenticated;

create function public.list_candidate_application_drafts()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $listing$
declare
  current_user_id uuid := auth.uid();
  verified_email text;
  drafts jsonb;
begin
  select u.email into verified_email from auth.users as u
    where u.id = current_user_id and u.email_confirmed_at is not null;
  if current_user_id is null or verified_email is null then
    raise exception 'Verified sign-in is required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',d.id,'job_id',d.job_id,'company',d.company,'title',d.title,'location',d.location,
    'source_url',d.source_url,'status',d.status,'tailored_summary',d.tailored_summary,
    'cover_letter',d.cover_letter,'match_notes',d.match_notes,'missing_answers',d.missing_answers,
    'created_at',d.created_at
  ) order by d.created_at desc,d.id),'[]'::jsonb) into drafts
  from (
    select a.* from private.gmoney_application_drafts as a
    join private.gmoney_candidate_documents as c on c.document_sha256 = a.document_sha256
    where c.owner_user_id = current_user_id and lower(c.contact_email) = lower(verified_email)
    order by a.created_at desc,a.id
    limit 50
  ) as d;
  return drafts;
end;
$listing$;
revoke all on function public.list_candidate_application_drafts() from public, anon;
grant execute on function public.list_candidate_application_drafts() to authenticated;
comment on function public.list_candidate_application_drafts() is
  'Lists prepared drafts for the verified owner of a private candidate document; does not submit applications.';
notify pgrst, 'reload schema';
commit;
