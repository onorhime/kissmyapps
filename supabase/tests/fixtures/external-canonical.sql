-- Disposable database only. Provider verification is covered by injected edge
-- tests; SQL verifies authority, idempotency, immutable scope and held accounting.
create function pg_temp.check_true(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAIL: %',label;end if;end $$;
create function pg_temp.reject(q text,label text) returns void language plpgsql as $$begin begin execute q;exception when others then return;end;raise exception 'FAIL accepted: %',label;end $$;
grant execute on function pg_temp.check_true(boolean,text),pg_temp.reject(text,text) to authenticated,service_role;
insert into public.platform_settings(singleton,tracking_base_url) values(true,'https://tracking.example.invalid') on conflict(singleton) do update set tracking_base_url=excluded.tracking_base_url;
insert into public.products(id,slug,name) values('ac570000-0000-4000-8000-000000000001','external-marathon-fixture','Fixture marathon');
insert into public.funnels(id,product_id,key,name,destination_url) values('ac570000-0000-4000-8000-000000000002','ac570000-0000-4000-8000-000000000001','marathon','Fixture funnel','https://marathon.example.invalid');
insert into public.affiliates(id,public_name,slug) values('ac570000-0000-4000-8000-000000000003','Fixture partner','external-fixture');
insert into public.affiliate_links(id,affiliate_id,product_id,funnel_id,name,public_code,tracking_url,sub1,status) values('ac570000-0000-4000-8000-000000000004','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','Fixture link','external_fixture_link','https://tracking.example.invalid/r/external-fixture/external_fixture_link','fixture','paused');
insert into public.clicks(id,public_click_id,affiliate_link_id,affiliate_id,product_id,funnel_id,sub1,destination_url_snapshot,occurred_at,created_at) values('ac570000-0000-4000-8000-000000000005','opaque_fixture_click_123456','ac570000-0000-4000-8000-000000000004','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','fixture','https://marathon.example.invalid',clock_timestamp()-interval '20 days',clock_timestamp()-interval '20 days');
insert into public.acquisitions(id,product_id,affiliate_id,click_record_id,funnel_id,attribution_method,created_at) values('ac570000-0000-4000-8000-000000000006','ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000005','ac570000-0000-4000-8000-000000000002','deterministic_web',clock_timestamp()-interval '20 days');

-- All actors and financial evidence are synthetic and rolled back.
insert into auth.users(id,email) values('ac570000-0000-4000-8000-000000000011','settlement-owner@example.invalid'),('ac570000-0000-4000-8000-000000000012','settlement-partner@example.invalid'),('ac570000-0000-4000-8000-000000000013','settlement-other@example.invalid');
insert into public.admin_users(user_id,role) values('ac570000-0000-4000-8000-000000000011','owner');
update public.affiliates set status='active' where id='ac570000-0000-4000-8000-000000000003';
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at) values('ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000012','owner',true,false,now());
insert into public.affiliates(id,public_name,slug,status) values('ac570000-0000-4000-8000-000000000014','Other','settlement-other','active');
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at) values('ac570000-0000-4000-8000-000000000014','ac570000-0000-4000-8000-000000000013','owner',true,false,now());
insert into public.external_commerce_merchants(product_id,funnel_id,stripe_account_id,livemode,enabled) values('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','acct_fixture',false,true),('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','acct_fixture',true,true);
update public.products set status='active' where id='ac570000-0000-4000-8000-000000000001';
update public.funnels set status='live' where id='ac570000-0000-4000-8000-000000000002';
create temp table test_external_orders(n integer primary key,core jsonb,order_id uuid);
create function pg_temp.make_order(number integer,basis bigint default 8000,live boolean default false,purchase_at timestamptz default clock_timestamp()-interval '2 days') returns uuid language plpgsql as $$
declare payload jsonb;oid uuid:=gen_random_uuid();internal uuid;
begin
 payload:=jsonb_build_object('product_id','ac570000-0000-4000-8000-000000000001','funnel_id','ac570000-0000-4000-8000-000000000002','attribution_sha256',repeat('a',64),'provider_occurred_at',purchase_at,'input',jsonb_build_object('event_id',gen_random_uuid(),'kind','purchase','click_id','opaque_fixture_click_123456','occurred_at',purchase_at,'order_id',oid,'checkout_session_id','cs_test_settle'||number,'payment_intent_id','pi_settle'||number,'account_id','acct_fixture','livemode',live,'amount_minor',10000,'currency','USD','attribution',jsonb_build_object('kmaClick','opaque_fixture_click_123456','status','unverified')));
 perform public.ingest_external_commerce(payload);select id into internal from public.external_commerce_orders where external_order_id=oid;
 insert into test_external_orders values(number,payload,internal);
 if basis is not null then perform public.record_external_commission_basis(jsonb_build_object('external_order_id',oid,'stripe_account_id','acct_fixture','livemode',live,'eligible_basis_minor',basis,'total_minor',10000,'currency','USD','basis_policy','post_discount_excluding_tax_shipping','verified_at',clock_timestamp()));end if;
 return internal;
end $$;
create function pg_temp.refund_order(number integer) returns void language plpgsql as $$declare core jsonb;begin select t.core into core from test_external_orders t where n=number;perform public.ingest_external_commerce(jsonb_set(core||jsonb_build_object('provider_occurred_at',clock_timestamp()),'{input}',(core->'input')||jsonb_build_object('event_id',gen_random_uuid(),'kind','refund','refund_id','re_settle'||number)));end $$;
create function pg_temp.admin() returns text language sql as $$select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000011","role":"authenticated","amr":[{"method":"password"}]}',true)::text;$$;
grant execute on function pg_temp.admin() to authenticated,service_role;
select pg_temp.admin();

-- Actual signing RPCs create a canonical v2 snapshot. The disposable database
-- owner then places only the synthetic binding approval in the past, simulating
-- elapsed economic periods without sleeping or weakening production RPCs.
insert into public.agreements(id,affiliate_id,product_id,version,model,status,starts_at,payout_frequency_days,minimum_payout_minor) values('ac570000-0000-4000-8000-000000000021','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000001',1,'revenue_share','draft',clock_timestamp()-interval '30 days',coalesce(nullif(current_setting('qa.policy.cadence',true),'')::integer,1),coalesce(nullif(current_setting('qa.policy.minimum',true),'')::bigint,100));
insert into public.commission_rules(id,agreement_id,name,model,trigger_event,rate_basis_points,validation_window_hours,status,policy_version,commission_basis_policy,refund_cutoff_days,first_purchase_only,fulfilment_required) values('ac570000-0000-4000-8000-000000000022','ac570000-0000-4000-8000-000000000021','Canonical external test','revenue_share','purchase.completed',2500,1,'active',case when current_setting('qa.policy.eligibility',true)='true' then 3 else 2 end,coalesce(nullif(current_setting('qa.policy.basis',true),''),'subtotal_ex_tax_shipping'),nullif(current_setting('qa.policy.cutoff',true),'')::integer,coalesce(current_setting('qa.policy.eligibility',true)='true',false),coalesce(current_setting('qa.policy.eligibility',true)='true',false));
insert into storage.objects(id,bucket_id,name,metadata,version) values('ac570000-0000-4000-8000-000000000023','affiliate-private-documents','ac570000-0000-4000-8000-000000000003/agreements/canonical.pdf','{"mimetype":"application/pdf","size":100,"eTag":"canonical-fixture"}','fixture-version');
set local role authenticated;
select pg_temp.admin();
select set_config('qa.document',public.create_admin_agreement_document(jsonb_build_object('agreement_id','ac570000-0000-4000-8000-000000000021','name','Canonical signed test policy','file_path','ac570000-0000-4000-8000-000000000003/agreements/canonical.pdf','content_sha256',repeat('a',64)))::text,true);
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000012","role":"authenticated","amr":[{"method":"password"}]}',true);
select public.partner_sign_agreement_document(jsonb_build_object('document_id',current_setting('qa.document')::jsonb->>'id','legal_name','Fixture creator','acknowledged',true));
select pg_temp.admin();
select public.admin_countersign_agreement_document(jsonb_build_object('document_id',current_setting('qa.document')::jsonb->>'id'));
select public.activate_admin_agreement('{"agreement_id":"ac570000-0000-4000-8000-000000000021"}');
reset role;
-- Synthetic clock travel is confined to this disposable fixture.
alter table public.documents disable trigger documents_evidence_guard;
update public.documents set signed_by_partner_at=clock_timestamp()-interval '29 days',signed_by_kissmyapps_at=clock_timestamp()-interval '29 days',effective_at=clock_timestamp()-interval '29 days' where id=(current_setting('qa.document')::jsonb->>'id')::uuid;
alter table public.documents enable trigger documents_evidence_guard;
set local role authenticated;
select set_config('qa.terms.input',jsonb_build_object('request_id',gen_random_uuid(),'agreement_id','ac570000-0000-4000-8000-000000000021','commission_rule_id','ac570000-0000-4000-8000-000000000022','product_id','ac570000-0000-4000-8000-000000000001','funnel_id','ac570000-0000-4000-8000-000000000002','affiliate_id','ac570000-0000-4000-8000-000000000003','stripe_account_id','acct_fixture','platform_account_id',coalesce(nullif(current_setting('qa.funding',true),''),'acct_fixture'),'livemode',false,'currency','USD','funding_model',case when nullif(current_setting('qa.funding',true),'') is null then 'merchant_direct' else 'prefunded_platform' end,'effective_from',clock_timestamp()-interval '30 days','effective_until',null,'expected_version',0,'reason','Signed canonical synthetic binding')::text,true);
select set_config('qa.scope','{"product_id":"ac570000-0000-4000-8000-000000000001","funnel_id":"ac570000-0000-4000-8000-000000000002","affiliate_id":"ac570000-0000-4000-8000-000000000003","platform_account_id":"acct_fixture","livemode":false,"currency":"USD"}',true);
select set_config('qa.scope',(current_setting('qa.scope')::jsonb||jsonb_build_object('platform_account_id',coalesce(nullif(current_setting('qa.funding',true),''),'acct_fixture')))::text,true);
select set_config('qa.terms',public.configure_admin_external_commission_terms(current_setting('qa.terms.input')::jsonb)::text,true);
reset role;
update public.external_commission_terms set status='approved',approved_at=clock_timestamp()-interval '29 days',approved_by='ac570000-0000-4000-8000-000000000011',revision=revision+1 where id=(current_setting('qa.terms')::jsonb->>'id')::uuid;
select set_config('qa.terms',(select to_jsonb(t)::text from public.external_commission_terms t where id=(current_setting('qa.terms')::jsonb->>'id')::uuid),true);
-- Helpers below exist only in this transaction-owned fixture.
create function pg_temp.ready_account(platform text default 'acct_fixture') returns jsonb language plpgsql as $$declare a jsonb;begin
 perform set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000012","role":"authenticated","amr":[{"method":"password"}]}',true);
 a:=public.creator_connect_context(platform,false);perform pg_temp.admin();
 update public.external_settlement_platforms set enabled=true where platform_account_id=platform and not livemode;
 perform public.reserve_creator_connect_account(jsonb_build_object('account_key',a->>'account_key','country','US'));
 return public.set_creator_connect_account(a||jsonb_build_object('connect_account_id','acct_creator','charges_enabled',false,'payouts_enabled',true,'transfers_enabled',true,'details_submitted',true,'requirements_due','[]'::jsonb,'disabled_reason',null,'verified_at',clock_timestamp()));
end $$;
create function pg_temp.prepare_approved(platform text default 'acct_fixture') returns jsonb language plpgsql as $$declare b jsonb;begin
 perform pg_temp.admin();b:=public.perform_admin_external_settlement_action(current_setting('qa.scope')::jsonb||jsonb_build_object('platform_account_id',platform,'request_id',gen_random_uuid(),'action','prepare_batch','reason','Freeze synthetic eligible earnings'));
 b:=public.perform_admin_external_settlement_action(jsonb_build_object('request_id',gen_random_uuid(),'action','review_batch','id',b->>'id','expected_revision',b->>'revision','reason','Review exact synthetic batch'));
 return public.perform_admin_external_settlement_action(jsonb_build_object('request_id',gen_random_uuid(),'action','approve_batch','id',b->>'id','expected_revision',b->>'revision','reason','Approve exact synthetic batch'));
end $$;
