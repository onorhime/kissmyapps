-- Runner inserts this first half after prepare_checkout_attempt and before
-- finalize_checkout_attempt, within synthetic fixture 24/25 BEGIN/ROLLBACK only.
reset role;
select pg_temp.check_true(not has_function_privilege('anon','public.stripe_webhook_owns_reference(text,text,jsonb)','EXECUTE'),'anonymous cannot query Stripe ownership');
select pg_temp.check_true(not has_function_privilege('authenticated','public.stripe_webhook_owns_reference(text,text,jsonb)','EXECUTE'),'partner/admin browser cannot query Stripe ownership');
select pg_temp.check_true(not has_table_privilege('service_role','public.checkout_attempts','SELECT'),'ingress adds no direct checkout table access');
insert into audit_values select 'ownership-metadata', jsonb_build_object(
 'kma_attempt_id',a.id::text,'kma_public_attempt_id',a.public_attempt_id,
 'kma_offer_id',a.billing_offer_id::text,'kma_product_id',a.product_id::text,
 'kma_acquisition_id',a.acquisition_id::text,'kma_click_id',a.click_record_id::text,
 'kma_expected_amount_minor',a.unit_amount_minor::text,'kma_expected_currency',a.currency)
 from public.checkout_attempts a where a.id=(select (value->>'attempt_id')::uuid from audit_values where key='context-attempt');
set local role service_role;
select pg_temp.check_true(public.stripe_webhook_owns_reference('checkout','cs_live_RollbackFixture9501',
 (select value from audit_values where key='ownership-metadata')),'full canonical metadata accepts checkout before finalize');
select pg_temp.check_true(not public.stripe_webhook_owns_reference('checkout','cs_live_RollbackFixture9501',
 jsonb_build_object('kma_product_id','20000000-0000-4000-8000-000000009501')),'product identifier alone is never ownership');
do $$ declare k text; m jsonb := (select value from audit_values where key='ownership-metadata');
begin
 for k in select jsonb_object_keys(m) loop
  perform pg_temp.check_true(not public.stripe_webhook_owns_reference('checkout','cs_live_RollbackFixture9501',m-k),'missing canonical metadata rejected: '||k);
 end loop;
end $$;
select pg_temp.check_true(public.stripe_webhook_owns_reference('subscription','sub_RollbackFree9501',
 (select jsonb_build_object('kma_attempt_id',value->>'attempt_id') from audit_values where key='context-attempt')),'subscription before checkout is retained for known attempt');
select pg_temp.check_true(not public.stripe_webhook_owns_reference('subscription','sub_ForeignFixture9501','{"kma_attempt_id":"malformed"}'),'invalid attempt metadata safely ignored');
select pg_temp.check_true(not public.stripe_webhook_owns_reference('charge','ch_ForeignFixture9501'),'unknown charge is not local evidence');
select pg_temp.expect_error($q$select public.stripe_webhook_owns_reference('customer','cus_ForeignFixture9501')$q$,'22023','customer-wide ownership is forbidden');

-- AFTER_NORMALIZATION
-- Appended after full fixtures 25/26; existing durable mappings now exist.
set local role service_role;
select pg_temp.check_true(public.stripe_webhook_owns_reference('checkout','cs_live_RollbackFixture9501'),'stored session identifies own event even if metadata changed');
select pg_temp.check_true(not public.stripe_webhook_owns_reference('checkout','cs_live_ForeignFixture9501',
 (select value from audit_values where key='ownership-metadata')),'metadata cannot replace finalized session identity');
select pg_temp.check_true(public.stripe_webhook_owns_reference('subscription','sub_RollbackFree9501'),'mapped subscription stays owned without metadata or active product');
select pg_temp.check_true(not public.stripe_webhook_owns_reference('subscription','sub_ForeignFixture9501',
 (select jsonb_build_object('kma_attempt_id',value->>'attempt_id') from audit_values where key='context-attempt')),'known attempt cannot claim a second mapped subscription');
reset role;
insert into audit_values values('ownership-provider',pg_temp.free_provider('invoice.paid','{"id":"in_OwnershipFixture9501"}'));
insert into public.transactions(id,subscription_id,acquisition_id,provider_event_id,stripe_invoice_id,kind,gross_minor,eligible_net_minor,currency,settled_currency,occurred_at)
 select '90000000-0000-4000-8000-000000009501',s.id,s.acquisition_id,
 (select (value->>'id')::uuid from audit_values where key='ownership-provider'),'in_OwnershipFixture9501','first_purchase',100,100,'USD','USD',now()
 from public.subscriptions s where stripe_subscription_id='sub_RollbackFree9501';
insert into public.stripe_transaction_evidence(transaction_id,checkout_attempt_id,stripe_charge_id)
 values('90000000-0000-4000-8000-000000009501',(select (value->>'attempt_id')::uuid from audit_values where key='context-attempt'),'ch_OwnershipFixture9501');
set local role service_role;
select pg_temp.check_true(public.stripe_webhook_owns_reference('charge','ch_OwnershipFixture9501'),'refund/dispute charge belongs to canonical transaction');
reset role;
select count(*) as passed_ownership_combined_assertions from audit_checks;
