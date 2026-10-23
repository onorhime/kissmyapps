-- Disposable, rollback-only fixtures. No provider, money, emails or hosted data.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

insert into auth.users(id,email,email_confirmed_at) values
 ('10000000-0000-4000-8000-000000000054','link-owner@example.invalid',now()),
 ('10000000-0000-4000-8000-000000000055','link-partner@example.invalid',now());
insert into public.admin_users(user_id,role,active) values
 ('10000000-0000-4000-8000-000000000054','owner',true);
insert into public.affiliates(id,public_name,slug,status) values
 ('30000000-0000-4000-8000-000000000054','Link readiness partner','link-readiness-fixture','active');
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at) values
 ('30000000-0000-4000-8000-000000000054','10000000-0000-4000-8000-000000000055','owner',true,false,now());
insert into public.products(id,slug,name,status) values
 ('20000000-0000-4000-8000-000000000054','managed-link-fixture','Managed link fixture','active');
insert into public.funnels(id,product_id,key,name,destination_url,status,is_default) values
 ('70000000-0000-4000-8000-000000000054','20000000-0000-4000-8000-000000000054','marathon','Marathon','https://marathon.speaksix.com/','live',true);
insert into public.platform_settings(singleton,tracking_base_url,tracking_enabled)
 values(true,'https://go.kissmyapps.dev',false);
insert into public.agreements(id,affiliate_id,product_id,version,model,status) values
 ('40000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000054','20000000-0000-4000-8000-000000000054',1,'cpa','draft');
insert into public.commission_rules(id,agreement_id,name,model,trigger_event,fixed_amount_minor,currency,status) values
 ('50000000-0000-4000-8000-000000000054','40000000-0000-4000-8000-000000000054','Existing signed settings','cpa','purchase.completed',100,'USD','active');
insert into storage.objects(id,bucket_id,name,metadata,version) values
 ('60000000-0000-4000-8000-000000000054','affiliate-private-documents','30000000-0000-4000-8000-000000000054/agreements/terms.pdf','{"mimetype":"application/pdf","size":100,"eTag":"fixture"}','fixture-version');
create function pg_temp.link_admin() returns text language sql as $$
 select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000054","role":"authenticated","amr":[{"method":"password"}]}',true);
$$;
grant execute on function pg_temp.link_admin() to authenticated, service_role;
select pg_temp.link_admin();
set local role authenticated;
select set_config('qa.link.document',public.create_admin_agreement_document(jsonb_build_object(
 'agreement_id','40000000-0000-4000-8000-000000000054','name','Creator terms',
 'file_path','30000000-0000-4000-8000-000000000054/agreements/terms.pdf','content_sha256',repeat('a',64)))::text,true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000055","role":"authenticated","amr":[{"method":"password"}]}',true);
select public.partner_sign_agreement_document(jsonb_build_object('document_id',current_setting('qa.link.document')::jsonb->>'id','legal_name','Fixture creator','acknowledged',true));
select pg_temp.link_admin();
select public.admin_countersign_agreement_document(jsonb_build_object('document_id',current_setting('qa.link.document')::jsonb->>'id'));
select public.activate_admin_agreement('{"agreement_id":"40000000-0000-4000-8000-000000000054"}');
select set_config('qa.link.offer',public.create_admin_billing_offer(jsonb_build_object(
 'product_id','20000000-0000-4000-8000-000000000054','key','marathon','name','Marathon payment',
 'billing_mode','payment','stripe_price_id','price_LinkConfigured54','currency','USD','unit_amount_minor',16900,
 'success_url_template','https://marathon.speaksix.com/complete?session_id={CHECKOUT_SESSION_ID}',
 'cancel_url','https://marathon.speaksix.com/checkout'))::text,true);
reset role;
insert into public.managed_payment_products(product_id,enabled) values('20000000-0000-4000-8000-000000000054',true);
set local role service_role;
select public.record_managed_price_verification(jsonb_build_object(
 'billing_offer_id',current_setting('qa.link.offer')::jsonb->>'id',
 'product_id','20000000-0000-4000-8000-000000000054','offer_version',1,
 'configured_price_id','price_LinkConfigured54','account_id','acct_LivePlatform54',
 'stripe_price_id','price_LinkActualLive54','livemode',true,'currency','USD','unit_amount_minor',16900));
reset role;
select is(public.product_has_launch_ready_billing_offer('20000000-0000-4000-8000-000000000054'),false,'a verified draft offer cannot unlock links');
set local role authenticated;
select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',current_setting('qa.link.offer')::jsonb->>'id','status','active'));
select is(public.get_admin_product_configuration('20000000-0000-4000-8000-000000000054') #>> '{billing_offers,0,main_link_ready}','true','server offer projection accepts exact LIVE platform verification');
select is(public.configure_admin_tracking(jsonb_build_object('base_url','https://go.kissmyapps.dev','enabled',true,
 'expected_updated_at',public.get_admin_platform_settings() #>> '{tracking,updated_at}')) #>> '{tracking,enabled}','true','one-time commercial chain enables canonical tracking through its normal RPC');
reset role;

-- Test every consumer before issuing a link: invalid proof must be rejected by
-- the actual issuance INSERT triggers, rather than a mocked/helper-only path.
create function pg_temp.assert_link_closed(label text) returns setof text language plpgsql as $$
begin
 return next is(public.product_has_launch_ready_billing_offer('20000000-0000-4000-8000-000000000054'),false,label||': shared readiness fails closed');
 return next is(public.get_admin_product_configuration('20000000-0000-4000-8000-000000000054') #>> '{readiness,has_active_billing_offer}','false',label||': product readiness fails closed');
 return next is(public.get_admin_product_configuration('20000000-0000-4000-8000-000000000054') #>> '{billing_offers,0,main_link_ready}','false',label||': per-offer readiness fails closed');
 return next is(public.get_admin_platform_settings() #>> '{readiness,verified_active_offer_count}','0',label||': platform count excludes the offer');
 return next is(public.get_admin_data_health() #>> '{catalog,verified_active_offer_count}','0',label||': health count excludes the offer');
 return next throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')$q$,'P0001',null,label||': real main-link issuance is rejected');
end;
$$;
create function pg_temp.assert_link_ready(label text) returns setof text language plpgsql as $$
begin
 return next is(public.product_has_launch_ready_billing_offer('20000000-0000-4000-8000-000000000054'),true,label||': shared readiness passes');
 return next is(public.get_admin_product_configuration('20000000-0000-4000-8000-000000000054') #>> '{readiness,has_active_billing_offer}','true',label||': product readiness passes');
 return next is(public.get_admin_product_configuration('20000000-0000-4000-8000-000000000054') #>> '{billing_offers,0,main_link_ready}','true',label||': per-offer readiness passes');
 return next is(public.get_admin_platform_settings() #>> '{readiness,verified_active_offer_count}','1',label||': platform count includes the offer');
 return next is(public.get_admin_data_health() #>> '{catalog,verified_active_offer_count}','1',label||': health count includes the offer');
end;
$$;
select * from pg_temp.assert_link_ready('exact live platform proof');
update public.managed_payment_offer_prices set livemode=false;
select * from pg_temp.assert_link_closed('TEST-only proof');
update public.managed_payment_offer_prices set livemode=true;
update public.managed_payment_offer_prices set offer_version=2;
select * from pg_temp.assert_link_closed('stale offer version');
update public.managed_payment_offer_prices set offer_version=1;
update public.managed_payment_offer_prices set configured_price_id='price_WrongConfig54';
select * from pg_temp.assert_link_closed('stale configured Price');
update public.managed_payment_offer_prices set configured_price_id='price_LinkConfigured54';
update public.managed_payment_offer_prices set currency='EUR';
select * from pg_temp.assert_link_closed('wrong currency');
update public.managed_payment_offer_prices set currency='USD';
update public.managed_payment_offer_prices set unit_amount_minor=17000;
select * from pg_temp.assert_link_closed('wrong amount');
update public.managed_payment_offer_prices set unit_amount_minor=16900;
update public.managed_payment_products set enabled=false;
select * from pg_temp.assert_link_closed('managed integration disabled');
update public.managed_payment_products set enabled=true;
set local role authenticated;
select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',current_setting('qa.link.offer')::jsonb->>'id','status','paused'));
reset role;
select * from pg_temp.assert_link_closed('paused offer');
set local role authenticated;
select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',current_setting('qa.link.offer')::jsonb->>'id','status','active'));
reset role;
insert into public.merchant_businesses(id,business_name,email,created_by) values
 ('80000000-0000-4000-8000-000000000054','Fixture merchant','merchant@example.invalid','10000000-0000-4000-8000-000000000054');
insert into public.merchant_connections(id,merchant_id,platform_account_id,livemode,account_id,status,charges_enabled,details_submitted) values
 ('81000000-0000-4000-8000-000000000054','80000000-0000-4000-8000-000000000054','acct_Funding54',false,'acct_TestMerchant54','active',true,true),
 ('81000000-0000-4000-8000-000000000055','80000000-0000-4000-8000-000000000054','acct_Funding54',true,'acct_LiveMerchant54','active',true,true);
insert into public.product_merchant_connections(product_id,livemode,connection_id,assigned_by) values
 ('20000000-0000-4000-8000-000000000054',false,'81000000-0000-4000-8000-000000000054','10000000-0000-4000-8000-000000000054');
select * from pg_temp.assert_link_ready('test merchant assignment does not invalidate LIVE platform evidence');
set local role authenticated;
select public.assign_admin_product_merchant('{"product_id":"20000000-0000-4000-8000-000000000054","merchant_id":"80000000-0000-4000-8000-000000000054","livemode":true}');
reset role;
select * from pg_temp.assert_link_closed('old platform proof cannot authorize the newly assigned live merchant');
update public.managed_payment_offer_prices set account_id='acct_LiveMerchant54';
select * from pg_temp.assert_link_ready('exact current live merchant proof');
update public.merchant_connections set status='revoked' where id='81000000-0000-4000-8000-000000000055';
select * from pg_temp.assert_link_closed('revoked merchant');
update public.merchant_connections set status='active' where id='81000000-0000-4000-8000-000000000055';
update public.merchant_connections set status='pending' where id='81000000-0000-4000-8000-000000000055';
select * from pg_temp.assert_link_closed('pending merchant');
update public.merchant_connections set status='active' where id='81000000-0000-4000-8000-000000000055';
update public.merchant_connections set charges_enabled=false where id='81000000-0000-4000-8000-000000000055';
select * from pg_temp.assert_link_closed('merchant cannot charge');
update public.merchant_connections set charges_enabled=true where id='81000000-0000-4000-8000-000000000055';
update public.merchant_connections set details_submitted=false where id='81000000-0000-4000-8000-000000000055';
select * from pg_temp.assert_link_closed('merchant details incomplete');
update public.merchant_connections set details_submitted=true where id='81000000-0000-4000-8000-000000000055';
update public.merchant_connections set account_id='acct_Reassigned54' where id='81000000-0000-4000-8000-000000000055';
select * from pg_temp.assert_link_closed('merchant receiving account changed');
update public.merchant_connections set account_id='acct_LiveMerchant54' where id='81000000-0000-4000-8000-000000000055';
update public.product_merchant_connections set connection_id='81000000-0000-4000-8000-000000000054' where livemode;
select * from pg_temp.assert_link_closed('LIVE assignment points to TEST connection');
update public.product_merchant_connections set connection_id='81000000-0000-4000-8000-000000000055' where livemode;
-- A stale row must not hide a separate correct attestation.
insert into public.managed_payment_offer_prices(offer_id,account_id,livemode,stripe_price_id,currency,unit_amount_minor,offer_version,configured_price_id)
 select offer_id,'acct_StaleOther54',livemode,stripe_price_id,currency,unit_amount_minor,offer_version,configured_price_id from public.managed_payment_offer_prices;
select * from pg_temp.assert_link_ready('correct proof among unrelated account rows');
select ok(not has_function_privilege('authenticated','kma_internal.billing_offer_is_launch_ready(uuid)','EXECUTE')
 and not has_function_privilege('anon','public.get_admin_platform_settings_before_managed_link_readiness()','EXECUTE')
 and not has_function_privilege('authenticated','public.get_admin_platform_settings_before_managed_link_readiness()','EXECUTE')
 and not has_function_privilege('authenticated','public.get_admin_data_health_before_managed_link_readiness()','EXECUTE')
 and not has_function_privilege('anon','public.get_admin_data_health_before_managed_link_readiness()','EXECUTE'),
 'private readiness internals cannot be called directly by browsers');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000055","role":"authenticated","amr":[{"method":"password"}]}',true);
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')$q$,'42501',null,'creator cannot issue their own admin main link');
select throws_ok($q$select public.get_admin_platform_settings()$q$,'42501',null,'new projection wrapper preserves admin-only access');
select pg_temp.link_admin();
select set_config('qa.link.issued',public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')::text,true);
select is(current_setting('qa.link.issued')::jsonb->>'status','active','normal owner RPC issues an active managed-payment main link through all INSERT triggers');
select is(current_setting('qa.link.issued')::jsonb->>'commercial_eligible','true','the new link is commercial, not a tracking-only bypass');
select is(public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')->>'id',current_setting('qa.link.issued')::jsonb->>'id','repeated issuance is idempotent');
select is(public.get_admin_platform_settings() #>> '{readiness,fully_live_product_count}','1','platform projection recognizes the complete one-time commercial chain');
set local role service_role;
select set_config('qa.link.click',(select to_jsonb(r)::text from public.register_tracking_click('link-readiness-fixture',current_setting('qa.link.issued')::jsonb->>'public_code',jsonb_build_object('session_id_hash',repeat('c',64))) r),true);
select ok(length(current_setting('qa.link.click')::jsonb->>'click_id')>0,'issued link serves a real attributed tracking click');
select throws_ok($q$select * from public.prepare_checkout_attempt(jsonb_build_object('click_id',current_setting('qa.link.click')::jsonb->>'click_id','offer_key','marathon','idempotency_key','managed_link_fixture_54'))$q$,'P0002','billing offer is unavailable','creator link does not bypass managed checkout using the legacy subscription endpoint');
reset role;
select is((select count(*) from public.clicks where product_id='20000000-0000-4000-8000-000000000054' and commercial_eligible),1::bigint,'one-time launch records one commercial click');
-- Product, partner, default-funnel and signed-agreement gates remain in place,
-- including when the existing link would otherwise be returned idempotently.
update public.products set status='paused' where id='20000000-0000-4000-8000-000000000054';
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')$q$,'P0001',null,'inactive product still rejects issuance');
update public.products set status='active' where id='20000000-0000-4000-8000-000000000054';
update public.affiliates set status='paused' where id='30000000-0000-4000-8000-000000000054';
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')$q$,'P0001',null,'inactive creator still rejects issuance');
update public.affiliates set status='active' where id='30000000-0000-4000-8000-000000000054';
update public.funnels set status='paused' where id='70000000-0000-4000-8000-000000000054';
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')$q$,'P0001',null,'non-live default funnel still rejects issuance');
update public.funnels set status='live' where id='70000000-0000-4000-8000-000000000054';
-- Pausing a managed offer remains an intentional emergency stop. Existing
-- links are retained, but no fresh redirect may bypass the same live proof gate.
set local role authenticated;
select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',current_setting('qa.link.offer')::jsonb->>'id','status','paused'));
reset role;
select is(public.product_has_launch_ready_billing_offer('20000000-0000-4000-8000-000000000054'),false,'paused managed offer closes new commercial traffic without deleting its link');
set local role service_role;
select throws_ok($q$select * from public.register_tracking_click('link-readiness-fixture',current_setting('qa.link.issued')::jsonb->>'public_code',jsonb_build_object('session_id_hash',repeat('d',64)))$q$,null,null,'stopped commercial chain rejects further redirect clicks');
reset role;
insert into public.affiliates(id,public_name,slug,status) values
 ('30000000-0000-4000-8000-000000000056','Unsigned creator','unsigned-link-fixture','active');
insert into public.agreements(id,affiliate_id,product_id,version,model,status) values
 ('40000000-0000-4000-8000-000000000056','30000000-0000-4000-8000-000000000056','20000000-0000-4000-8000-000000000054',1,'cpa','draft');
insert into public.commission_rules(id,agreement_id,name,model,trigger_event,fixed_amount_minor,currency,status) values
 ('50000000-0000-4000-8000-000000000056','40000000-0000-4000-8000-000000000056','Unsigned commission','cpa','purchase.completed',100,'USD','active');
set local role authenticated;
select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',current_setting('qa.link.offer')::jsonb->>'id','status','active'));
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000056","product_id":"20000000-0000-4000-8000-000000000054"}')$q$,'P0001','commercial main links require a signed agreement and purchase rule','verified one-time offer cannot bypass bilateral signing and agreement activation');
reset role;
select * from finish();
rollback;
