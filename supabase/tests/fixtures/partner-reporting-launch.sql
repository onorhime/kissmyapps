-- Synthetic launch chain for database tests 28, 31 and 33 only. No provider,
-- Auth API or delivery calls. The caller must own a disposable database and
-- wrap this file and the assertions in one rollback transaction.
do $$ begin
  if current_setting('kma.test.disposable_database', true) is distinct from 'true' then
    raise exception 'Partner reporting fixtures require the disposable database harness';
  end if;
end $$;

insert into public.platform_settings(singleton,tracking_base_url,tracking_enabled)
values(true,'https://go.kissmyapps.dev',true);
insert into auth.users(id,email,email_confirmed_at) values
 ('aa280000-0000-4000-8000-000000000011','report-owner@example.invalid',now()),
 ('aa280000-0000-4000-8000-000000000012','report-partner@example.invalid',now());
insert into public.admin_users(user_id,role) values('aa280000-0000-4000-8000-000000000011','owner');
insert into public.affiliates(id,public_name,slug,status,reporting_timezone)
values('aa280000-0000-4000-8000-000000000003','Reporting fixture partner','reporting-fixture','active','UTC');
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at)
values('aa280000-0000-4000-8000-000000000003','aa280000-0000-4000-8000-000000000012','owner',true,false,now());
insert into public.products(id,slug,name,status)
values('aa280000-0000-4000-8000-000000000001','reporting-fixture','Reporting fixture product','draft');
insert into public.funnels(id,product_id,key,name,destination_url,status,is_default)
values('aa280000-0000-4000-8000-000000000002','aa280000-0000-4000-8000-000000000001','primary','Reporting fixture funnel','https://bc-learn-funnel.vercel.app/','live',true);
insert into public.sources(id,key,name)
values('aa280000-0000-4000-8000-000000000004','reporting-fixture','Reporting fixture source');
insert into public.agreements(id,affiliate_id,product_id,version,model,status,starts_at)
values('aa280000-0000-4000-8000-000000000021','aa280000-0000-4000-8000-000000000003','aa280000-0000-4000-8000-000000000001',1,'cpa','draft',now()-interval '3 days');
insert into public.commission_rules(id,agreement_id,name,model,trigger_event,fixed_amount_minor,currency,status)
values('aa280000-0000-4000-8000-000000000022','aa280000-0000-4000-8000-000000000021','Reporting fixture commission','cpa','purchase.completed',100,'USD','active');
insert into storage.objects(id,bucket_id,name,metadata,version)
values('aa280000-0000-4000-8000-000000000023','affiliate-private-documents','aa280000-0000-4000-8000-000000000003/agreements/reporting.pdf','{"mimetype":"application/pdf","size":100,"eTag":"reporting-fixture"}','fixture-version');

-- Use the real document/signature/activation RPCs; do not bypass readiness.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa280000-0000-4000-8000-000000000011","role":"authenticated","amr":[{"method":"password"}]}',true);
select set_config('qa.reporting.document',public.create_admin_agreement_document(jsonb_build_object(
 'agreement_id','aa280000-0000-4000-8000-000000000021','name','Reporting fixture signed terms',
 'file_path','aa280000-0000-4000-8000-000000000003/agreements/reporting.pdf','content_sha256',repeat('b',64)))::text,true);
select set_config('request.jwt.claims','{"sub":"aa280000-0000-4000-8000-000000000012","role":"authenticated","amr":[{"method":"password"}]}',true);
select public.partner_sign_agreement_document(jsonb_build_object('document_id',current_setting('qa.reporting.document')::jsonb->>'id','legal_name','Reporting fixture creator','acknowledged',true));
select set_config('request.jwt.claims','{"sub":"aa280000-0000-4000-8000-000000000011","role":"authenticated","amr":[{"method":"password"}]}',true);
select public.admin_countersign_agreement_document(jsonb_build_object('document_id',current_setting('qa.reporting.document')::jsonb->>'id'));
select public.activate_admin_agreement('{"agreement_id":"aa280000-0000-4000-8000-000000000021"}');
select set_config('qa.reporting.offer',public.create_admin_billing_offer('{
 "product_id":"aa280000-0000-4000-8000-000000000001","key":"monthly","name":"Reporting fixture offer","billing_mode":"subscription",
 "stripe_price_id":"price_ReportingFixture28","currency":"USD","unit_amount_minor":100,
 "success_url_template":"https://bc-learn-funnel.vercel.app/complete?session_id={CHECKOUT_SESSION_ID}",
 "cancel_url":"https://bc-learn-funnel.vercel.app/cancel"}')::text,true);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
-- These URLs and verification evidence exercise production-shape guards only.
-- They remain rollback-only database values; no network request is made.
select public.record_billing_offer_stripe_verification(jsonb_build_object(
 'billing_offer_id',current_setting('qa.reporting.offer')::jsonb->>'id',
 'stripe_price_id','price_ReportingFixture28','livemode',true,'active',true,'currency','USD','unit_amount_minor',100,'billing_mode','subscription'));
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa280000-0000-4000-8000-000000000011","role":"authenticated","amr":[{"method":"password"}]}',true);
select public.activate_admin_product('{"product_id":"aa280000-0000-4000-8000-000000000001"}');
select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',current_setting('qa.reporting.offer')::jsonb->>'id','status','active'));
select set_config('qa.reporting.link',public.issue_admin_main_link('{"affiliate_id":"aa280000-0000-4000-8000-000000000003","product_id":"aa280000-0000-4000-8000-000000000001"}')::text,true);
reset role;
