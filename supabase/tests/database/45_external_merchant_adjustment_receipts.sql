-- Merchant evidence must survive delayed attribution without inventing creator
-- ownership or using the funding platform as the receiving merchant.
begin;
\i supabase/tests/fixtures/external-canonical.sql
grant execute on function pg_temp.reject(text,text) to anon;
select pg_temp.make_order(51);
select public.process_external_commissions();
create function pg_temp.observation(n integer,event_name text,object_name text,kind_value text,amount_value bigint,when_at timestamptz default clock_timestamp()) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('provider_event_id',event_name,'stripe_account_id',o.stripe_account_id,'livemode',o.livemode,
   'product_id',o.product_id,'funnel_id',o.funnel_id,'payment_intent_id',o.stripe_payment_intent_id,'external_order_id',o.external_order_id,
   'order_amount_minor',o.amount_minor,'currency',o.currency,'kind',kind_value,'amount_minor',amount_value,'occurred_at',when_at,
   case when kind_value='refund' then 'refund_id' else 'dispute_id' end,object_name,'observed_at',clock_timestamp(),'payload_sha256',repeat('c',64))
 from public.external_commerce_orders o join pg_temp.test_external_orders t on t.order_id=o.id where t.n=$1
$$;
grant execute on function pg_temp.observation(integer,text,text,text,bigint,timestamptz) to service_role;
select set_config('qa.partial',pg_temp.observation(51,'evt_partial51','re_partial51','refund',1000)::text,true);
set local role anon;
select pg_temp.reject('select public.ingest_external_merchant_adjustment(''{}'')','anonymous cannot write merchant evidence');
reset role;
set local role authenticated;
select pg_temp.reject('select public.ingest_external_merchant_adjustment(''{}'')','browser cannot attest provider refunds');
select pg_temp.reject('select * from public.external_merchant_adjustment_receipts','browser cannot read unbound private merchant evidence');
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select pg_temp.reject('update public.external_merchant_adjustment_receipts set amount_minor=1','service cannot directly rewrite merchant facts');
select pg_temp.reject('delete from public.external_merchant_adjustment_receipts','service cannot delete merchant facts');
select pg_temp.check_true(public.ingest_external_merchant_adjustment(current_setting('qa.partial')::jsonb)->>'duplicate'='false','first partial refund accepted');
select pg_temp.check_true(public.ingest_external_merchant_adjustment(current_setting('qa.partial')::jsonb)->>'duplicate'='true','exact delivery replay idempotent');
select pg_temp.reject('select public.ingest_external_merchant_adjustment(current_setting(''qa.partial'')::jsonb||''{"amount_minor":2000}'')','same event cannot change verified refund amount');
select pg_temp.reject('select public.ingest_external_merchant_adjustment(current_setting(''qa.partial'')::jsonb||jsonb_build_object(''payload_sha256'',repeat(''d'',64)))','signed payload conflict rejected');
select pg_temp.reject('select public.ingest_external_merchant_adjustment(current_setting(''qa.partial'')::jsonb||''{"provider_event_id":"evt_foreign51","stripe_account_id":"acct_other"}'')','unconfigured receiving merchant rejected');
select pg_temp.reject('select public.ingest_external_merchant_adjustment(current_setting(''qa.partial'')::jsonb||''{"provider_event_id":"evt_scope51","currency":"EUR"}'')','order currency mismatch rejected');
select public.ingest_external_merchant_adjustment(current_setting('qa.partial')::jsonb||jsonb_build_object('provider_event_id','evt_second51','observed_at',clock_timestamp()));
reset role;
select pg_temp.check_true((select count(*)=1 from public.external_commission_adjustments where provider_object_id='re_partial51'),'new provider event for same refund never doubles deduction');
select pg_temp.check_true((select commission_minor=1800 and reversed_minor=200 and status='eligible' from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=51)),'partial refund uses frozen proportional commission');
select pg_temp.reject('update public.external_merchant_adjustment_receipts set amount_minor=2','even table owner evidence update is guarded');
select pg_temp.reject('delete from public.external_merchant_adjustment_receipts','append-only receipt history guarded');
select pg_temp.reject('update public.external_merchant_adjustment_receipts set applied_at=clock_timestamp()','completed binding cannot be rewritten');
-- One provider event can contain several successful refunds with unique IDs.
set local role service_role;
select public.ingest_external_merchant_adjustment(pg_temp.observation(51,'evt_multi51','re_multi51a','refund',500));
select public.ingest_external_merchant_adjustment(pg_temp.observation(51,'evt_multi51','re_multi51b','refund',500));
reset role;
select pg_temp.check_true((select count(*)=2 from public.external_commission_adjustments where provider_event_id='evt_multi51'),'multiple refunds in one event retained separately');
select pg_temp.check_true((select commission_minor=1600 and reversed_minor=400 from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=51)),'cumulative partial adjustment rounds once from original commission');
-- Fresh terminal provider evidence dominates delayed open snapshots.
select set_config('qa.dispute',pg_temp.observation(51,'evt_dispute51','dp_dispute51','dispute_open',1000)::text,true);
set local role service_role;
select public.ingest_external_merchant_adjustment(current_setting('qa.dispute')::jsonb);
reset role;
select pg_temp.check_true((select status='held' and blocker='dispute_open' from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=51)),'open dispute holds remaining commission');
set local role service_role;
select public.ingest_external_merchant_adjustment(current_setting('qa.dispute')::jsonb||'{"kind":"dispute_won"}');
select public.ingest_external_merchant_adjustment(current_setting('qa.dispute')::jsonb||'{"provider_event_id":"evt_delayedopen51"}');
reset role;
select pg_temp.check_true((select status='eligible' and commission_minor=1600 from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=51)),'won dispute releases without undoing verified refunds');
-- An observation before the purchase is retained and matched by all scope keys.
select set_config('qa.early.order',gen_random_uuid()::text,true);
select set_config('qa.early',(current_setting('qa.partial')::jsonb||jsonb_build_object('provider_event_id','evt_early52','external_order_id',current_setting('qa.early.order'),'payment_intent_id','pi_early52','refund_id','re_early52','amount_minor',10000,'occurred_at',clock_timestamp(),'observed_at',clock_timestamp()))::text,true);
set local role service_role;
select public.ingest_external_merchant_adjustment(current_setting('qa.early')::jsonb);
select public.ingest_external_merchant_adjustment(current_setting('qa.early')::jsonb||'{"provider_event_id":"evt_liveearly52","livemode":true}');
reset role;
select pg_temp.check_true((select count(*)=2 from public.external_merchant_adjustment_receipts where payment_intent_id='pi_early52' and applied_at is null),'both mode-scoped pending observations remain private');
select public.ingest_external_commerce((select core from test_external_orders where n=51)||jsonb_build_object('input',(select core->'input' from test_external_orders where n=51)||jsonb_build_object('event_id',gen_random_uuid(),'order_id',current_setting('qa.early.order'),'checkout_session_id','cs_test_early52','payment_intent_id','pi_early52')));
select public.record_external_commission_basis(jsonb_build_object('external_order_id',current_setting('qa.early.order'),'stripe_account_id','acct_fixture','livemode',false,'eligible_basis_minor',8000,'total_minor',10000,'currency','USD','basis_policy','post_discount_excluding_tax_shipping','verified_at',clock_timestamp()));
select public.process_external_commissions();
select pg_temp.check_true((select applied_at is not null from public.external_merchant_adjustment_receipts where provider_event_id='evt_early52'),'later exact purchase binds early refund');
select pg_temp.check_true((select applied_at is null from public.external_merchant_adjustment_receipts where provider_event_id='evt_liveearly52'),'live observation cannot bind same test payment');
select pg_temp.check_true((select a.status='reversed' and a.commission_minor=0 from public.external_commission_awards a join public.external_commerce_orders o on o.id=a.order_id where o.external_order_id=current_setting('qa.early.order')::uuid),'refunded-before-attribution never becomes payable');
select pg_temp.check_true((select count(*)=0 from public.external_settlement_jobs),'merchant evidence does not create a transfer');
select pg_temp.check_true((select count(*)=0 from public.payouts),'legacy payout subsystem stays untouched');
rollback;
