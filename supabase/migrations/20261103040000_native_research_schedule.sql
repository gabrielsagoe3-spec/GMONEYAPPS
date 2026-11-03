-- Native scheduling; keys are provisioned separately in Supabase Vault/secrets.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
-- pg_net defaults may permit client roles to read queued request headers.
revoke all on net.http_request_queue, net._http_response from public,anon,authenticated;

create table public.research_automation_status (
 slug text primary key check (slug='current'),
 schedule_enabled boolean not null default false,
 schedule_expression text not null default '17 */6 * * *',
 backend text not null default 'supabase',
 updated_at timestamptz not null default now()
);
alter table public.research_automation_status enable row level security;
revoke all on public.research_automation_status from public, anon, authenticated;
grant select on public.research_automation_status to anon, authenticated;
create policy automation_status_read on public.research_automation_status for select to anon,authenticated using (true);
insert into public.research_automation_status(slug) values ('current');

create table private.gmoney_research_runtime_settings (
 name text primary key check(name in ('function_url','publishable_key')),
 value text not null
);
alter table private.gmoney_research_runtime_settings enable row level security;
revoke all on private.gmoney_research_runtime_settings from public,anon,authenticated;

create function private.gmoney_trigger_research(request_trigger text default 'scheduled')
returns bigint language plpgsql security definer set search_path=pg_catalog
as $function$
declare trigger_key text; function_url text; public_key text; request_id bigint;
begin
 if request_trigger not in ('manual','scheduled') then raise exception 'Invalid research trigger'; end if;
 select decrypted_secret into trigger_key from vault.decrypted_secrets where name='gmoney_research_trigger_key';
 select value into function_url from private.gmoney_research_runtime_settings where name='function_url';
 select value into public_key from private.gmoney_research_runtime_settings where name='publishable_key';
 if trigger_key is null or function_url is null or public_key is null then raise exception 'Research runtime is not configured'; end if;
 select net.http_post(url:=function_url,headers:=jsonb_build_object('Content-Type','application/json','apikey',public_key,'x-gmoney-run-key',trigger_key),
  body:=jsonb_build_object('trigger',request_trigger),timeout_milliseconds:=120000) into request_id;
 update public.research_automation_status set
  schedule_enabled=exists(select 1 from cron.job where jobname='gmoney-job-research' and active),updated_at=now() where slug='current';
 return request_id;
end;
$function$;
revoke all on function private.gmoney_trigger_research(text) from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;
