-- Synthetic merchant connection in an isolated local database only. This runs
-- inside the canonical fixture transaction and uses its real signing helpers.
update auth.users set email_confirmed_at=now();
insert into auth.users(id,email,email_confirmed_at) values('ac570000-0000-4000-8000-000000000080','merchant-crossapp@example.invalid',now());
set local role authenticated;
select pg_temp.admin();
select set_config('qa.merchant.invite',public.create_admin_merchant_invitation(jsonb_build_object('business_name','Cross-app merchant','email','merchant-crossapp@example.invalid','platform_account_id','acct_platformFixture','livemode',false,'token_sha256',repeat('b',64),'expires_at',clock_timestamp()+interval '1 day'))::text,true);
reset role;set local role service_role;
select public.claim_merchant_invitation(jsonb_build_object('token_sha256',repeat('b',64),'user_id','ac570000-0000-4000-8000-000000000080'));
select set_config('qa.merchant.actor',(current_setting('qa.merchant.invite')::jsonb||jsonb_build_object('user_id','ac570000-0000-4000-8000-000000000080'))::text,true);
select public.begin_merchant_oauth(current_setting('qa.merchant.actor')::jsonb||jsonb_build_object('state_sha256',repeat('d',64),'expires_at',clock_timestamp()+interval '5 minutes'));
select public.consume_merchant_oauth(jsonb_build_object('state_sha256',repeat('d',64),'user_id','ac570000-0000-4000-8000-000000000080'));
select public.record_merchant_connection_candidate(jsonb_build_object('state_sha256',repeat('d',64),'account_id','acct_fixture','platform_account_id','acct_platformFixture','livemode',false,'business_name','Verified cross-app merchant','country','US','charges_enabled',true,'payouts_enabled',true,'details_submitted',true,'provider_verified_at',clock_timestamp()));
select public.confirm_merchant_connection(current_setting('qa.merchant.actor')::jsonb||'{"account_id":"acct_fixture"}');
reset role;set local role authenticated;
select pg_temp.admin();
select public.assign_admin_product_merchant(jsonb_build_object('product_id','ac570000-0000-4000-8000-000000000001','merchant_id',current_setting('qa.merchant.invite')::jsonb->>'merchant_id','livemode',false));
select set_config('qa.fee.terms',public.configure_admin_external_commission_terms(current_setting('qa.terms.input')::jsonb||jsonb_build_object('request_id',gen_random_uuid(),'expected_version',1,'funding_model','application_fee','effective_from',clock_timestamp()-interval '1 day'))::text,true);
reset role;
-- Fixture-only elapsed approval time, as in external-canonical.sql.
update public.external_commission_terms set status='approved',approved_at=clock_timestamp()-interval '1 minute',approved_by='ac570000-0000-4000-8000-000000000011',revision=revision+1 where id=(current_setting('qa.fee.terms')::jsonb->>'id')::uuid;
reset role;
