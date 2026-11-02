-- Run in your Supabase SQL editor. The result is a NEW private worker key.
-- Copy it directly into GitHub Actions secret GMONEY_RESEARCH_KEY.
-- Do not commit the result or share it in chat. Re-running rotates the key.
with generated as materialized (
 select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') as worker_key
), saved as (
 insert into private.gmoney_automation_credentials(name,key_sha256)
 select 'publisher', encode(sha256(convert_to(worker_key,'UTF8')),'hex') from generated
 on conflict(name) do update set key_sha256=excluded.key_sha256, updated_at=now()
 returning name
)
select worker_key from generated cross join saved;
