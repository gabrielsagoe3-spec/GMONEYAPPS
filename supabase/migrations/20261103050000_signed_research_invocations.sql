-- pg_net may expose its queue to SQL client roles. Queue signatures, never keys.
begin;
create table private.gmoney_research_invocations (
 nonce_sha256 text primary key check(nonce_sha256 ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
alter table private.gmoney_research_invocations enable row level security;
revoke all on private.gmoney_research_invocations from public,anon,authenticated;

create function public.consume_research_invocation(nonce text)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $consume$
declare supplied_key text; expected_digest text; consumed integer;
begin
 supplied_key:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-gmoney-research-key';
 select key_sha256 into expected_digest from private.gmoney_automation_credentials where name='publisher';
 if supplied_key is null or length(supplied_key) not between 32 and 256 or expected_digest is null
  or encode(sha256(convert_to(supplied_key,'UTF8')),'hex') is distinct from expected_digest then
  raise exception 'Invocation validation is not authorized' using errcode='42501';
 end if;
 if nonce is null or nonce !~ '^[a-f0-9]{64}$' then return jsonb_build_object('accepted',false); end if;
 delete from private.gmoney_research_invocations
  where nonce_sha256=encode(sha256(convert_to(nonce,'UTF8')),'hex') and expires_at>now();
 get diagnostics consumed=row_count;
 return jsonb_build_object('accepted',consumed=1);
end;
$consume$;
revoke all on function public.consume_research_invocation(text) from public;
grant execute on function public.consume_research_invocation(text) to anon,authenticated;

create or replace function private.gmoney_trigger_research(request_trigger text default 'scheduled')
returns bigint language plpgsql security definer set search_path=pg_catalog
as $function$
declare trigger_key text; function_url text; public_key text; request_id bigint;
 request_nonce text; issued_at bigint; signature text;
begin
 if request_trigger not in ('manual','scheduled') then raise exception 'Invalid research trigger'; end if;
 select decrypted_secret into trigger_key from vault.decrypted_secrets where name='gmoney_research_trigger_key';
 select value into function_url from private.gmoney_research_runtime_settings where name='function_url';
 select value into public_key from private.gmoney_research_runtime_settings where name='publishable_key';
 if trigger_key is null or function_url is null or public_key is null then raise exception 'Research runtime is not configured'; end if;
 request_nonce:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 issued_at:=floor(extract(epoch from now()))::bigint;
 signature:=encode(extensions.hmac(convert_to(request_nonce||'.'||issued_at::text||'.'||request_trigger,'UTF8'),convert_to(trigger_key,'UTF8'),'sha256'),'hex');
 delete from private.gmoney_research_invocations where expires_at<now();
 insert into private.gmoney_research_invocations(nonce_sha256,expires_at)
  values(encode(sha256(convert_to(request_nonce,'UTF8')),'hex'),now()+interval '5 minutes');
 select net.http_post(url:=function_url,headers:=jsonb_build_object('Content-Type','application/json','apikey',public_key,'x-gmoney-run-signature',signature),
  body:=jsonb_build_object('nonce',request_nonce,'issuedAt',issued_at,'trigger',request_trigger),timeout_milliseconds:=120000) into request_id;
 update public.research_automation_status set
  schedule_enabled=exists(select 1 from cron.job where jobname='gmoney-job-research' and active),updated_at=now() where slug='current';
 return request_id;
end;
$function$;
revoke all on function private.gmoney_trigger_research(text) from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;
