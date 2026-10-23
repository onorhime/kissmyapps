-- Actual profile source and durable creation snapshot. No provider requests.
begin;
\i supabase/tests/fixtures/external-canonical.sql
update auth.users set email_confirmed_at=clock_timestamp()
 where id='ac570000-0000-4000-8000-000000000012';
update public.affiliates set entity_type='company',legal_name='Known Company Ltd',
 website_url='https://known-creator.example.invalid'
 where id='ac570000-0000-4000-8000-000000000003';
update public.external_settlement_platforms set enabled=true
 where platform_account_id='acct_fixture' and not livemode;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000012","role":"authenticated"}',true);
select set_config('qa.account',public.creator_connect_context('acct_fixture',false)::text,true);
select pg_temp.reject('select public.reserve_creator_connect_account(current_setting(''qa.account'')::jsonb||jsonb_build_object(''country'',''US''))','browser cannot choose reservation actor or profile');
reset role;
select set_config('qa.reserve',(current_setting('qa.account')::jsonb||jsonb_build_object('country','US','actor_user_id','ac570000-0000-4000-8000-000000000012'))::text,true);
set local role service_role;
select pg_temp.reject('select public.reserve_creator_connect_account(current_setting(''qa.reserve'')::jsonb||jsonb_build_object(''actor_user_id'',''ac570000-0000-4000-8000-000000000013''))','unrelated actor cannot source another creator profile');
reset role;
select pg_temp.check_true((select first_account_attempt_at is null and account_creation_prefill='{}'::jsonb from public.external_creator_accounts where id=(current_setting('qa.account')::jsonb->>'account_key')::uuid),'rejected first attempt did not freeze a timestamp or profile');
update public.affiliate_users set role='member' where user_id='ac570000-0000-4000-8000-000000000012';
set local role service_role;
select pg_temp.reject('select public.reserve_creator_connect_account(current_setting(''qa.reserve'')::jsonb)','ordinary member cannot reserve profile data');
reset role;
update public.affiliate_users set role='owner' where user_id='ac570000-0000-4000-8000-000000000012';
set local role service_role;
select set_config('qa.reserved',public.reserve_creator_connect_account(current_setting('qa.reserve')::jsonb||jsonb_build_object('account_creation_prefill',jsonb_build_object('email','injected@example.invalid')))::text,true);
select pg_temp.check_true(current_setting('qa.reserved')::jsonb->'account_creation_prefill'=jsonb_build_object('email','settlement-partner@example.invalid','business_type','company','company_name','Known Company Ltd','website_url','https://known-creator.example.invalid'),'snapshot uses exact database fields, not caller supplied profile');
reset role;
update auth.users set email='changed@example.invalid' where id='ac570000-0000-4000-8000-000000000012';
update public.affiliates set legal_name='Changed Name Ltd',website_url='https://changed.example.invalid',entity_type='individual'
 where id='ac570000-0000-4000-8000-000000000003';
insert into auth.users(id,email,email_confirmed_at) values('ac570000-0000-4000-8000-000000000015','finance@example.invalid',clock_timestamp());
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at)
 values('ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000015','finance',true,false,clock_timestamp());
set local role service_role;
select pg_temp.check_true(public.reserve_creator_connect_account(current_setting('qa.reserve')::jsonb)->'account_creation_prefill'=current_setting('qa.reserved')::jsonb->'account_creation_prefill','verified email and profile edits cannot change retry payload');
select pg_temp.check_true(public.reserve_creator_connect_account(current_setting('qa.reserve')::jsonb||jsonb_build_object('actor_user_id','ac570000-0000-4000-8000-000000000015'))->'account_creation_prefill'=current_setting('qa.reserved')::jsonb->'account_creation_prefill','finance retry keeps original owner contact snapshot');
select pg_temp.reject('select public.reserve_creator_connect_account(current_setting(''qa.reserve'')::jsonb||jsonb_build_object(''country'',''GB''))','reserved country cannot change');
reset role;
-- Model a pre-migration first attempt: the provider payload was empty. Never
-- attach new fields to that existing Stripe idempotency key.
update public.external_creator_accounts set account_creation_prefill='{}',first_account_attempt_at=clock_timestamp()-interval '1 hour'
 where id=(current_setting('qa.account')::jsonb->>'account_key')::uuid;
set local role service_role;
select pg_temp.check_true(public.reserve_creator_connect_account(current_setting('qa.reserve')::jsonb)->'account_creation_prefill'='{}'::jsonb,'existing legacy reservation remains empty');
reset role;
-- A brand-new individual has no reliable split legal names. Even the contact
-- email is omitted until auth, not user-controlled profile metadata, verifies it.
update public.external_creator_accounts set first_account_attempt_at=null,country=null
 where id=(current_setting('qa.account')::jsonb->>'account_key')::uuid;
update auth.users set email_confirmed_at=null,raw_user_meta_data='{"email":"metadata@example.invalid","first_name":"Guessed","last_name":"Identity"}'
 where id='ac570000-0000-4000-8000-000000000012';
update public.affiliates set website_url=null where id='ac570000-0000-4000-8000-000000000003';
set local role service_role;
select pg_temp.check_true(public.reserve_creator_connect_account(current_setting('qa.reserve')::jsonb)->'account_creation_prefill'='{"business_type":"individual"}'::jsonb,'individual identity and unverified email are not fabricated');
reset role;
update public.external_creator_accounts set first_account_attempt_at=null,country=null,account_creation_prefill='{}'
 where id=(current_setting('qa.account')::jsonb->>'account_key')::uuid;
update public.affiliates set entity_type=null where id='ac570000-0000-4000-8000-000000000003';
set local role service_role;
select pg_temp.check_true(public.reserve_creator_connect_account(current_setting('qa.reserve')::jsonb)->'account_creation_prefill'='{}'::jsonb,'missing entity type is not guessed from legal or public name');
reset role;
-- Existing connected-account details remain untouched even without a recorded
-- first-attempt timestamp (legacy/imported account).
update public.external_creator_accounts set first_account_attempt_at=null,country=null,account_creation_prefill='{}',connect_account_id='acct_existing'
 where id=(current_setting('qa.account')::jsonb->>'account_key')::uuid;
update auth.users set email_confirmed_at=clock_timestamp() where id='ac570000-0000-4000-8000-000000000012';
set local role service_role;
select pg_temp.check_true(public.reserve_creator_connect_account(current_setting('qa.reserve')::jsonb)->'account_creation_prefill'='{}'::jsonb,'existing connected account does not receive fresh profile snapshot');
reset role;
rollback;
