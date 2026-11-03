-- All synthetic identities and rows are rolled back; no email is sent.
begin;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000101','gmoney-rls-one@example.invalid'),
 ('00000000-0000-4000-8000-000000000102','gmoney-rls-two@example.invalid');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000101';
insert into public.agent_preferences(user_id,full_name,resume_text,sponsorship_need)
 values ('00000000-0000-4000-8000-000000000101','Synthetic test profile','Synthetic resume','required_future');
do $$ begin
 if (select full_name from public.agent_preferences where user_id='00000000-0000-4000-8000-000000000101') <> 'Synthetic test profile' then raise exception 'Owner read failed'; end if;
 update public.agent_preferences set preferred_roles='Business analyst' where user_id='00000000-0000-4000-8000-000000000101';
 begin
  update public.agent_preferences set user_id='00000000-0000-4000-8000-000000000102' where user_id='00000000-0000-4000-8000-000000000101';
  raise exception 'Ownership reassignment was accepted';
 exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000102';
do $$ declare touched integer; begin
 if exists(select 1 from public.agent_preferences where user_id='00000000-0000-4000-8000-000000000101') then raise exception 'Cross-account read allowed'; end if;
 update public.agent_preferences set full_name='Unauthorized' where user_id='00000000-0000-4000-8000-000000000101';
 get diagnostics touched = row_count;
 if touched <> 0 then raise exception 'Cross-account update allowed'; end if;
end $$;
set local role anon;
do $$ begin
 begin
  perform user_id from public.agent_preferences;
  raise exception 'Anonymous private read allowed';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'passed: owner read/write, ownership protection, cross-account isolation, anonymous denial; synthetic data rolled back' as result;
