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


-- One commercial product and agreement; TEST verification must not unlock LIVE.
update public.managed_payment_offer_prices set livemode=false;
select is(public.product_has_launch_ready_billing_offer('20000000-0000-4000-8000-000000000054'),false,'TEST price does not make LIVE offer ready');
set local role authenticated;
select is(public.get_admin_product_configuration('20000000-0000-4000-8000-000000000054')#>>'{billing_offers,0,main_link_test_ready}','true','TEST readiness is projected separately');
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')$q$,'P0001',null,'default issuance retains LIVE price requirement');
select set_config('qa.test_link',public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054","environment":"test"}')::text,true);
select is(current_setting('qa.test_link')::jsonb->>'environment','test','TEST issuance is explicit');
select is(current_setting('qa.test_link')::jsonb->>'commercial_eligible','true','same commercial agreement applies; no tracking-only bypass');
select ok(current_setting('qa.test_link')::jsonb->>'short_url' like '%/test','TEST address reserves a distinct human-readable suffix');
select is(public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054","environment":"test"}')->>'id',current_setting('qa.test_link')::jsonb->>'id','TEST reissue is idempotent');
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054","environment":"preview"}')$q$,'22023',null,'unsupported modes rejected');
select public.configure_admin_funnel_journey('{"funnel_id":"70000000-0000-4000-8000-000000000054","environment":"live","conversion_window_days":30,"expected_updated_at":null}');
reset role;
select throws_ok(format('update public.affiliate_links set tracking_environment=''live'' where id=%L',(current_setting('qa.test_link')::jsonb->>'id')),'23514',null,'issued environment cannot change');
set local role service_role;
select set_config('qa.test_click',(select to_jsonb(c)::text from public.register_short_tracking_click(replace(current_setting('qa.test_link')::jsonb->>'short_url','https://go.kissmyapps.dev',''),'{}') c),true);
select set_config('qa.test_context',public.resolve_funnel_journey_click('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',current_setting('qa.test_click')::jsonb->>'click_id')::text,true);
select is(current_setting('qa.test_context')::jsonb->>'environment','test','trusted context uses TEST link even with LIVE funnel default');
select is(current_setting('qa.test_context')::jsonb->>'link_id',current_setting('qa.test_link')::jsonb->>'id','trusted context binds exact link');
select throws_ok($q$select public.resolve_funnel_journey_click('20000000-0000-4000-8000-000000000055','70000000-0000-4000-8000-000000000054',current_setting('qa.test_click')::jsonb->>'click_id')$q$,'P0002',null,'other product cannot resolve TEST click');
select throws_ok($q$select public.register_short_tracking_click(replace(current_setting('qa.test_link')::jsonb->>'short_url','https://go.kissmyapps.dev',''),'{"environment":"live"}')$q$,'22023',null,'client context cannot select mode');
select throws_ok($q$select public.ingest_funnel_metric_event('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',jsonb_build_object('click_id',current_setting('qa.test_click')::jsonb->>'click_id','schema_version','2','environment','live'))$q$,'22023',null,'TEST click cannot enter LIVE reporting');
select throws_ok($q$select public.ingest_funnel_metric_event('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',jsonb_build_object('click_id',current_setting('qa.test_click')::jsonb->>'click_id'))$q$,'22023',null,'TEST click cannot enter unscoped legacy metrics');
select set_config('qa.test_event',jsonb_build_object('schema_version','2','event_id','91000000-0000-4000-8000-000000000061','event_name','lead_created','click_id',current_setting('qa.test_click')::jsonb->>'click_id','subject_id','learner_test_context_61','environment','test','dedupe_key','lead:learner_test_context_61','occurred_at',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text,true);
select is(public.ingest_funnel_metric_event('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',current_setting('qa.test_event')::jsonb)->>'duplicate','false','a valid TEST event is accepted');
select is(public.ingest_funnel_metric_event('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',current_setting('qa.test_event')::jsonb)->>'duplicate','true','retry records the business event only once');
select throws_ok($q$select public.prepare_managed_checkout('{"livemode":true}',jsonb_build_object('click_id',current_setting('qa.test_click')::jsonb->>'click_id'),repeat('c',64))$q$,'22023','Checkout and creator link environments must match','LIVE checkout rejected before scope/provider work');
reset role;
select is((select environment from public.funnel_journey_clicks where click_record_id=(select id from public.clicks where public_click_id=current_setting('qa.test_click')::jsonb->>'click_id')),'test','persisted click classification is TEST');
-- Defense in depth: a mismatched verified order cannot enter the LIVE ledger.
select throws_ok($q$insert into public.external_commerce_orders(external_order_id,product_id,funnel_id,stripe_account_id,livemode,click_record_id,acquisition_id,affiliate_id,stripe_session_id,stripe_payment_intent_id,amount_minor,currency,attribution_sha256)
select '92000000-0000-4000-8000-000000000061',c.product_id,c.funnel_id,'acct_TestFixture61',true,c.id,a.id,c.affiliate_id,'cs_test_fixture61','pi_TestFixture61',16900,'USD',repeat('a',64) from public.clicks c join public.acquisitions a on a.click_record_id=c.id where c.public_click_id=current_setting('qa.test_click')::jsonb->>'click_id'$q$,'23514','Order and creator link environments must match','TEST click cannot create a LIVE verified order');
-- Existing TEST link stops when paused and when its creator agreement is not ready.
update public.affiliate_links set status='paused' where id=(current_setting('qa.test_link')::jsonb->>'id')::uuid;
set local role service_role;
select throws_ok($q$select public.resolve_funnel_journey_click('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',current_setting('qa.test_click')::jsonb->>'click_id')$q$,'P0002',null,'paused TEST link context rejected');
reset role;
update public.affiliate_links set status='active' where id=(current_setting('qa.test_link')::jsonb->>'id')::uuid;
-- Add LIVE proof without changing TEST link; both main links coexist.
insert into public.managed_payment_offer_prices(offer_id,account_id,livemode,stripe_price_id,currency,unit_amount_minor,offer_version,configured_price_id)
select offer_id,account_id,true,stripe_price_id,currency,unit_amount_minor,offer_version,configured_price_id from public.managed_payment_offer_prices;
set local role authenticated;
select pg_temp.link_admin();
select set_config('qa.live_link',public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054","environment":"live"}')::text,true);
select isnt(current_setting('qa.live_link')::jsonb->>'id',current_setting('qa.test_link')::jsonb->>'id','TEST and LIVE main links coexist');
select is(public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054"}')->>'id',current_setting('qa.live_link')::jsonb->>'id','omitted mode always resolves LIVE');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000055","role":"authenticated","amr":[{"method":"password"}]}',true);
select is((select test_main_link_id::text from public.partner_product_directory where id='20000000-0000-4000-8000-000000000054'),current_setting('qa.test_link')::jsonb->>'id','partner sees its own TEST main link separately');
select is((select main_link_id::text from public.partner_product_directory where id='20000000-0000-4000-8000-000000000054'),current_setting('qa.live_link')::jsonb->>'id','partner default main link stays LIVE');
select set_config('qa.child_link',(select to_jsonb(l)::text from public.create_partner_link(jsonb_build_object('product_id','20000000-0000-4000-8000-000000000054','funnel_id','70000000-0000-4000-8000-000000000054','name','Test video','sub1','video','parent_link_id',current_setting('qa.test_link')::jsonb->>'id')) l),true);
select is(current_setting('qa.child_link')::jsonb->>'environment','test','creator child link inherits TEST parent');
select throws_ok($q$select public.resolve_funnel_journey_click('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',current_setting('qa.test_click')::jsonb->>'click_id')$q$,'42501',null,'browser cannot resolve trusted context directly');
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054","environment":"test"}')$q$,'42501',null,'partner cannot issue admin TEST link');
reset role;
-- Revocation applies to both issuance and existing TEST click context.
update public.managed_payment_offer_prices set offer_version=99 where not livemode;
set local role authenticated;select pg_temp.link_admin();
select throws_ok($q$select public.issue_admin_main_link('{"affiliate_id":"30000000-0000-4000-8000-000000000054","product_id":"20000000-0000-4000-8000-000000000054","environment":"test"}')$q$,'P0001',null,'stale TEST proof rejects reissue');
set local role service_role;
select throws_ok($q$select public.resolve_funnel_journey_click('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',current_setting('qa.test_click')::jsonb->>'click_id')$q$,'P0002',null,'stale proof cannot authorize trusted context');
reset role;
update public.managed_payment_offer_prices set offer_version=1 where not livemode;
update public.affiliate_links set status='archived' where id=(current_setting('qa.test_link')::jsonb->>'id')::uuid;
set local role service_role;
select throws_ok($q$select public.resolve_funnel_journey_click('20000000-0000-4000-8000-000000000054','70000000-0000-4000-8000-000000000054',current_setting('qa.test_click')::jsonb->>'click_id')$q$,'P0002',null,'archived TEST link cannot authorize a new visit');
reset role;
select is((select count(*) from public.funnel_metric_events where journey_environment='test'),1::bigint,'one TEST event persisted after its retry');
select is((select count(*) from public.funnel_metric_events where journey_environment='live'),0::bigint,'no TEST evidence leaked into LIVE');
select is((select count(*) from public.managed_checkout_orders),0::bigint,'link tests create no checkout');
select is((select count(*) from public.external_commerce_orders),0::bigint,'link tests create no purchases or commission');
select * from finish();rollback;
