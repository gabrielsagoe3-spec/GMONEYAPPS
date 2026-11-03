-- One-use invocation tests; no fixture values survive rollback.
begin;
insert into private.gmoney_automation_credentials(name,key_sha256)
 values('publisher',encode(sha256(convert_to('test-only-invocation-key-never-use-live-0001','UTF8')),'hex'))
 on conflict(name) do update set key_sha256=excluded.key_sha256;
insert into private.gmoney_research_invocations(nonce_sha256,expires_at)
 values(encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'),now()+interval '5 minutes'),
 (encode(sha256(convert_to(repeat('b',64),'UTF8')),'hex'),now()-interval '1 minute');
set local role anon;
do $$ begin
 begin perform public.consume_research_invocation(repeat('a',64)); raise exception 'Unauthorized nonce consumption allowed';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.headers','{"x-gmoney-research-key":"test-only-invocation-key-never-use-live-0001"}',true);
do $$ begin
 if public.consume_research_invocation(repeat('a',64)) <> '{"accepted":true}'::jsonb then raise exception 'Valid invocation denied'; end if;
 if public.consume_research_invocation(repeat('a',64)) <> '{"accepted":false}'::jsonb then raise exception 'Invocation replay accepted'; end if;
 if public.consume_research_invocation(repeat('b',64)) <> '{"accepted":false}'::jsonb then raise exception 'Expired invocation accepted'; end if;
 begin perform nonce_sha256 from private.gmoney_research_invocations; raise exception 'Anonymous nonce-table read allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
select 'passed: authenticated nonce consumption, replay rejection, expiration, private-table isolation; fixtures rolled back' as result;
