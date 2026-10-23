-- Appended to fixtures 24/25 inside BEGIN/ROLLBACK only. No provider request.
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.check_true(not has_function_privilege('anon','public.normalize_stripe_zero_total_event(uuid,uuid,jsonb)','EXECUTE'),'anonymous cannot normalize free checkout');
select pg_temp.check_true(not has_function_privilege('authenticated','public.normalize_stripe_zero_total_event(uuid,uuid,jsonb)','EXECUTE'),'browser cannot normalize free checkout');

create function pg_temp.free_provider(p_type text,p_object jsonb,p_verified boolean default true) returns jsonb language plpgsql as $$
declare eid uuid:=gen_random_uuid(); token uuid:=gen_random_uuid(); external_id text:='evt_RollbackFree_'||replace(eid::text,'-','');
begin
 insert into public.provider_events(id,provider,provider_event_id,event_type,payload,signature_verified)
 values(eid,'stripe',external_id,p_type,jsonb_build_object('id',external_id,'type',p_type,'livemode',true,
   'created',extract(epoch from now())::bigint,'data',jsonb_build_object('object',p_object)),p_verified);
 insert into public.provider_event_processing(provider_event_id) values(eid) on conflict do nothing;
 update public.provider_event_processing set status='processing',claim_token=token,claimed_by='rollback-only',
   claimed_at=now(),lease_expires_at=now()+interval '5 minutes' where provider_event_id=eid;
 return jsonb_build_object('id',eid,'token',token);
end $$;
create function pg_temp.normalize_free(evidence jsonb,input_value jsonb) returns jsonb language sql as $$
 select public.normalize_stripe_zero_total_event((evidence->>'id')::uuid,(evidence->>'token')::uuid,input_value);
$$;
insert into audit_values select 'free-session',jsonb_build_object(
 'id',a.stripe_checkout_session_id,'object','checkout.session','mode','subscription','status','complete',
 'payment_status','no_payment_required','amount_total',0,'amount_subtotal',a.unit_amount_minor,'currency','usd',
 'total_details',jsonb_build_object('amount_discount',a.unit_amount_minor,'amount_tax',0,'amount_shipping',0),
 'client_reference_id',a.public_attempt_id,'customer','cus_RollbackFree9501','subscription','sub_RollbackFree9501',
 'metadata',jsonb_build_object('kma_attempt_id',a.id,'kma_public_attempt_id',a.public_attempt_id,
 'kma_offer_id',a.billing_offer_id,'kma_product_id',a.product_id,'kma_acquisition_id',a.acquisition_id,
 'kma_click_id',a.click_record_id,'kma_expected_amount_minor',a.unit_amount_minor::text,'kma_expected_currency',a.currency))
 from public.checkout_attempts a where a.id=(select (value->>'attempt_id')::uuid from audit_values where key='context-attempt');
insert into audit_values values('free-input',jsonb_build_object('kind','checkout_subscription_free','object_id','cs_live_RollbackFixture9501',
 'subscription_id','sub_RollbackFree9501','subscription_customer_id','cus_RollbackFree9501',
 'subscription_attempt_id',(select value->>'attempt_id' from audit_values where key='context-attempt'),
 'subscription_status','active','subscription_currency','USD','period_start',extract(epoch from now())::bigint,
 'period_end',extract(epoch from now()+interval '1 month')::bigint,'cancelled_at',null,'subscription_livemode',true));
do $$ declare change jsonb; ev jsonb; input_value jsonb:=(select value from audit_values where key='free-input');
begin
 for change in select v from (values ('{"amount_total":1}'::jsonb),('{"amount_subtotal":99}'::jsonb),
   ('{"total_details":{"amount_discount":50,"amount_tax":0,"amount_shipping":0}}'::jsonb),
   ('{"client_reference_id":null}'::jsonb),('{"currency":"eur"}'::jsonb)) changes(v) loop
   ev:=pg_temp.free_provider('checkout.session.completed',(select value||change from audit_values where key='free-session'));
   perform pg_temp.expect_error(format('select pg_temp.normalize_free(%L,%L)',ev,input_value),'23514','incorrect free checkout evidence rejected');
 end loop;
 ev:=pg_temp.free_provider('checkout.session.completed',(select value from audit_values where key='free-session'),false);
 perform pg_temp.expect_error(format('select pg_temp.normalize_free(%L,%L)',ev,input_value),'P0002','unsigned free checkout rejected');
 ev:=pg_temp.free_provider('checkout.session.completed',(select value from audit_values where key='free-session'));
 perform pg_temp.expect_error(format('select pg_temp.normalize_free(%L,%L)',ev||jsonb_build_object('token',gen_random_uuid()),input_value),'P0002','wrong worker claim rejected');
 perform pg_temp.expect_error(format('select pg_temp.normalize_free(%L,%L)',ev,input_value||'{"subscription_customer_id":"cus_ForeignCustomer9501"}'::jsonb),'23514','foreign customer rejected');
 perform pg_temp.expect_error(format('select pg_temp.normalize_free(%L,%L)',ev,input_value||'{"subscription_status":"trialing"}'::jsonb),'23514','future-charge trial is not a free coupon');
 perform pg_temp.check_true(pg_temp.normalize_free(ev,input_value)->>'status'='processed','valid zero-total checkout normalizes');
 perform pg_temp.expect_error(format('select pg_temp.normalize_free(%L,%L)',ev,input_value),'P0002','processed claim cannot be replayed');
 ev:=pg_temp.free_provider('checkout.session.completed',(select value from audit_values where key='free-session'));
 perform pg_temp.check_true(pg_temp.normalize_free(ev,input_value)->>'status'='processed','distinct provider delivery preserves existing free subscription');
end $$;
select pg_temp.check_true((select count(*)=1 from public.subscriptions where stripe_subscription_id='sub_RollbackFree9501'),'exactly one real subscription fact');
select pg_temp.check_true(public.get_funnel_checkout_context((select value from audit_values where key='status-input'),
 '20000000-0000-4000-8000-000000009501','70000000-0000-4000-8000-000000009501')->>'status'='no_payment_required','receipt distinguishes free from paid');
insert into audit_values values('free-invoice','{"id":"in_RollbackFree9501","object":"invoice","status":"paid","paid":true,"amount_paid":0,"amount_due":0,"amount_remaining":0,"total":0,"total_excluding_tax":0,"currency":"usd","customer":"cus_RollbackFree9501","subscription":"sub_RollbackFree9501"}');
insert into audit_values values('free-invoice-input','{"kind":"invoice_no_payment_required","object_id":"in_RollbackFree9501","customer_id":"cus_RollbackFree9501","subscription_id":"sub_RollbackFree9501"}');
do $$ declare ev jsonb; input_value jsonb:=(select value from audit_values where key='free-invoice-input');
begin
 ev:=pg_temp.free_provider('invoice.paid',(select value||'{"total":100}'::jsonb from audit_values where key='free-invoice'));
 perform pg_temp.expect_error(format('select pg_temp.normalize_free(%L,%L)',ev,input_value),'23514','uncollected positive invoice is not free');
 ev:=pg_temp.free_provider('invoice.paid',(select value from audit_values where key='free-invoice'));
 perform pg_temp.check_true(pg_temp.normalize_free(ev,input_value)->>'status'='processed','zero invoice normalizes without PaymentIntent');
end $$;
select pg_temp.check_true(not exists(select 1 from public.transactions t join public.subscriptions s on s.id=t.subscription_id where s.product_id='20000000-0000-4000-8000-000000009501'),'free checkout creates no cash transactions');
select pg_temp.check_true(not exists(select 1 from public.conversions where product_id='20000000-0000-4000-8000-000000009501'),'free checkout creates no paid conversions');
select pg_temp.check_true(not exists(select 1 from public.commission_entries where product_id='20000000-0000-4000-8000-000000009501'),'free checkout creates no commissions');
select pg_temp.check_true(not exists(select 1 from public.events where product_id='20000000-0000-4000-8000-000000009501'
 and event_name in ('checkout.no_payment_required','invoice.no_payment_required') and commercial_eligible),'free facts never enter commercial processing');
select count(*) as passed_combined_assertions from audit_checks;
