-- Canonical signatures, source-verified basis, dated refunds and merchant/funding isolation.
begin;
select set_config('qa.policy.cutoff','2',true);
select set_config('qa.policy.basis','net_after_fees',true);
select set_config('qa.funding','acct_funding',true);
\i supabase/tests/fixtures/external-canonical.sql
create function pg_temp.cost(n integer,fee bigint default 100) returns jsonb language sql as $$select public.record_external_commission_basis(jsonb_build_object('external_order_id',core#>>'{input,order_id}','stripe_account_id','acct_fixture','livemode',false,'eligible_basis_minor',8000,'total_minor',10000,'currency','USD','basis_policy','post_discount_excluding_tax_shipping','verified_at',clock_timestamp(),'tax_minor',1000,'shipping_minor',1000,'fee_verified',true,'fee_minor',fee,'fee_currency','USD','balance_transaction_id','txn_fixture'||n,'provider_charge_id','ch_fixture'||n)) from test_external_orders where test_external_orders.n=$1;$$;
create function pg_temp.adjust(n integer,obj text,kind_value text,amount bigint,at_value timestamptz,event_name text default null) returns jsonb language sql as $$select public.record_external_commission_adjustment(jsonb_build_object('order_id',order_id,'provider_event_id',coalesce(event_name,'evt_'||replace(obj||kind_value,'_','')),'kind',kind_value,'amount_minor',amount,'occurred_at',at_value,case when kind_value='refund' then 'refund_id' else 'dispute_id' end,obj)) from test_external_orders where test_external_orders.n=$1;$$;
create function pg_temp.purchase_at(n integer) returns timestamptz language sql as $$select (core->>'provider_occurred_at')::timestamptz from test_external_orders where test_external_orders.n=$1;$$;
select pg_temp.check_true((select terms_snapshot#>>'{rules,0,refund_cutoff_days}'='2' and terms_snapshot#>>'{rules,0,external_refund_calculation}'='proportional_commission' and terms_sha256=encode(extensions.digest(terms_snapshot::text,'sha256'),'hex') from public.documents where id=(current_setting('qa.document')::jsonb->>'id')::uuid),'signed v2 includes cutoff, basis and external refund formula');
select pg_temp.check_true((select agreement_version=1 and commission_rule_version=1 and validation_window_hours=1 and refund_cutoff_days=2 and platform_account_id='acct_funding' and stripe_account_id='acct_fixture' from public.external_commission_terms where id=(current_setting('qa.terms')::jsonb->>'id')::uuid),'binding derives canonical policy and keeps merchant separate');
select pg_temp.reject('update public.commission_rules set refund_cutoff_days=3 where id=''ac570000-0000-4000-8000-000000000022''','signed policy cannot change');
select pg_temp.reject('update public.external_commission_terms set basis_points=9999','binding snapshot immutable');
set local role authenticated;
select pg_temp.reject('select public.configure_admin_external_commission_terms(current_setting(''qa.terms.input'')::jsonb||''{"rate_basis_points":9000}'')','operational editor cannot override signed rates');
select pg_temp.reject('select public.configure_admin_external_commission_terms(current_setting(''qa.terms.input'')::jsonb||jsonb_build_object(''request_id'',gen_random_uuid(),''expected_version'',1,''affiliate_id'',''ac570000-0000-4000-8000-000000000014''))','agreement cannot be rebound to another creator');
select pg_temp.reject('select public.record_external_commission_adjustment(''{}'')','adjustment evidence is service only');
select pg_temp.reject('select * from public.external_commission_fee_diagnostics','fee diagnostic private');
reset role;
-- Legacy signatures retain their v1 serialized shape; null cutoff means unlimited.
insert into public.agreements(id,affiliate_id,product_id,version,model,status) values('ac570000-0000-4000-8000-000000000031','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000001',2,'revenue_share','draft');
insert into public.commission_rules(id,agreement_id,name,model,trigger_event,rate_basis_points,status) values('ac570000-0000-4000-8000-000000000032','ac570000-0000-4000-8000-000000000031','Historical v1','revenue_share','purchase.completed',2500,'active');
select pg_temp.check_true(not(public.agreement_terms_snapshot('ac570000-0000-4000-8000-000000000031')#>'{rules,0}' ? 'refund_cutoff_days'),'v1 signed hash shape remains unchanged');
select pg_temp.reject('update public.commission_rules set refund_cutoff_days=2 where id=''ac570000-0000-4000-8000-000000000032''','v1 cannot hide unsigned cutoff');
-- Missing provider cost evidence never means a zero fee. Retry can enrich later.
select pg_temp.make_order(1,8000,false,clock_timestamp()-interval '5 days');
select public.process_external_commissions();
select pg_temp.check_true((select blocker='verified_fee_evidence_missing' and commission_minor=0 from public.external_commission_awards),'net basis requires provider fee proof');
select public.record_external_commission_basis(jsonb_build_object('external_order_id',(select core#>>'{input,order_id}' from test_external_orders where n=1),'stripe_account_id','acct_fixture','livemode',false,'eligible_basis_minor',8000,'total_minor',10000,'currency','USD','basis_policy','post_discount_excluding_tax_shipping','verified_at',clock_timestamp(),'fee_verified',false,'fee_unavailable_reason','settlement_currency_mismatch'));
select public.process_external_commissions();
select pg_temp.check_true((select blocker='settlement_currency_mismatch' from public.external_commission_awards),'FX basis exposes honest held reason');
select pg_temp.cost(1);select pg_temp.cost(1);select public.process_external_commissions();
select pg_temp.check_true((select basis_minor=8900 and original_commission_minor=2225 and status='eligible' from public.external_commission_awards),'net basis preserves gross less verified tax and fee');
select pg_temp.check_true((select count(*)=1 from public.external_commission_ledger where kind='earned' and platform_account_id='acct_funding'),'one earning attributed to reviewed funding platform');
select pg_temp.reject('select pg_temp.cost(1,200)','verified fee evidence immutable');
-- Exact UTC cutoff included, ingestion may be much later; one second late excluded.
select pg_temp.adjust(1,'re_boundary','refund',2000,pg_temp.purchase_at(1)+interval '48 hours');
select pg_temp.adjust(1,'re_late','refund',2000,pg_temp.purchase_at(1)+interval '48 hours 1 second');
select pg_temp.check_true((select commission_minor=1780 and reversed_minor=445 from public.external_commission_awards),'only occurrence inside cutoff affects commission');
select pg_temp.check_true(pg_temp.adjust(1,'re_boundary','refund',2000,pg_temp.purchase_at(1)+interval '48 hours')->>'duplicate'='true','same refund replay idempotent');
select pg_temp.reject('select pg_temp.adjust(1,''re_boundary'',''refund'',2001,pg_temp.purchase_at(1)+interval ''48 hours'')','same refund cannot mutate');
select pg_temp.adjust(1,'re_batcha','refund',1000,pg_temp.purchase_at(1)+interval '1 day','evt_multirefund');
select pg_temp.adjust(1,'re_batchb','refund',1000,pg_temp.purchase_at(1)+interval '1 day','evt_multirefund');
select pg_temp.check_true((select reversed_minor=890 and commission_minor=1335 from public.external_commission_awards),'one provider event may contain distinct refund identities');
-- Lost disputes do not use ordinary-refund cutoff; overlap is capped, never negative.
select pg_temp.adjust(1,'dp_open','dispute_open',1000,clock_timestamp());
select pg_temp.check_true((select status='held' and blocker='dispute_open' from public.external_commission_awards),'open dispute holds');
select pg_temp.adjust(1,'dp_open','dispute_won',1000,clock_timestamp());
select pg_temp.adjust(1,'dp_open','dispute_open',1000,clock_timestamp(),'evt_staleopen');
select pg_temp.check_true((select status='eligible' and commission_minor=1335 from public.external_commission_awards),'won dispute releases hold and late open cannot downgrade');
select pg_temp.adjust(1,'dp_lost','dispute_lost',10000,clock_timestamp());
select pg_temp.check_true((select status='reversed' and reversed_minor=2225 and commission_minor=0 from public.external_commission_awards),'lost-dispute recovery plus refunds capped at original award');
-- A newer canonical approval is prospective and cannot redefine the old award.
set local role authenticated;
select pg_temp.admin();
select set_config('qa.next',public.configure_admin_external_commission_terms(current_setting('qa.terms.input')::jsonb||jsonb_build_object('request_id',gen_random_uuid(),'expected_version',1,'effective_from',clock_timestamp()+interval '1 day','reason','Future reviewed funding binding'))::text,true);
select public.perform_admin_external_settlement_action(jsonb_build_object('request_id',gen_random_uuid(),'action','approve_terms','id',current_setting('qa.next')::jsonb->>'id','expected_revision',1,'reason','Approve only signed canonical snapshot'));
reset role;
select pg_temp.check_true((select terms_id=(current_setting('qa.terms')::jsonb->>'id')::uuid and original_commission_minor=2225 from public.external_commission_awards),'historical policy snapshot preserved');
-- Current agreement termination bounds new facts, but delayed prior purchases retain rights.
update public.agreements set status='terminated',ends_at=clock_timestamp()-interval '1 day' where id='ac570000-0000-4000-8000-000000000021';
select pg_temp.make_order(2);select pg_temp.cost(2);
select pg_temp.make_order(3,8000,false,clock_timestamp());select pg_temp.cost(3);
select public.process_external_commissions();
select pg_temp.check_true((select commission_minor=2225 from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=2)),'pre-termination late purchase honored');
select pg_temp.check_true((select commission_minor=0 and terms_id is null from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=3)),'post-termination purchase cannot use historical null end');
select pg_temp.ready_account('acct_funding');
select set_config('qa.batch',pg_temp.prepare_approved('acct_funding')::text,true);
select pg_temp.check_true((select count(*)=0 from public.claim_creator_transfer_jobs('acct_fixture',false)),'merchant account cannot claim centrally funded transfer');
select set_config('qa.job',(select value::text from public.claim_creator_transfer_jobs('acct_funding',false) value),true);
select public.begin_creator_transfer_attempt(jsonb_build_object('id',current_setting('qa.job')::jsonb->>'id','lease_token',current_setting('qa.job')::jsonb->>'lease_token'));
select public.finish_creator_transfer_job(current_setting('qa.job')::jsonb||jsonb_build_object('status','succeeded','provider_id','tr_canonical'));
-- Incremental partial refunds after transfer produce separate immutable recoveries.
select pg_temp.adjust(2,'re_firstpartial','refund',1000,pg_temp.purchase_at(2)+interval '1 hour');
select pg_temp.adjust(2,'re_secondpartial','refund',2000,pg_temp.purchase_at(2)+interval '2 hours');
select pg_temp.check_true((select reversed_minor=667 and commission_minor=1558 from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=2)),'partial refund rounds cumulative proportion once');
select pg_temp.check_true((select count(*)=2 and sum(amount_minor)=667 from public.external_settlement_jobs where kind='reversal'),'additional partial refund creates incremental immutable recovery');
select pg_temp.check_true(kma_internal.external_debt('ac570000-0000-4000-8000-000000000003','acct_funding',false,'USD')=667,'unrecovered proportional debt cannot disappear');
-- Open dispute after transfer freezes unrelated future payouts until final outcome.
select pg_temp.adjust(2,'dp_aftertransfer','dispute_open',5000,clock_timestamp());
select pg_temp.check_true(kma_internal.external_scope_review_frozen('ac570000-0000-4000-8000-000000000003','acct_funding',false,'USD'),'open dispute after payment freezes funding scope');
select pg_temp.adjust(2,'dp_aftertransfer','dispute_won',5000,clock_timestamp());
select pg_temp.check_true(not kma_internal.external_scope_review_frozen('ac570000-0000-4000-8000-000000000003','acct_funding',false,'USD'),'verified win clears only dispute freeze');
select pg_temp.check_true(kma_internal.external_debt('ac570000-0000-4000-8000-000000000003','acct_funding',false,'USD')=667,'won dispute does not erase refund debt');
select pg_temp.check_true((select count(*)=0 from public.transactions) and (select count(*)=0 from public.commission_entries),'external history never fabricates subscription conversion');
rollback;
