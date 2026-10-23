-- Backward-compatible provider receipts under a signed canonical fixture.
begin;
\i supabase/tests/fixtures/external-canonical.sql
-- Separate receipt suite: no provider, all changes roll back.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000012","role":"authenticated"}',true);
select set_config('qa.account',public.creator_connect_context('acct_fixture',false)::text,true);
select pg_temp.reject('select public.ingest_creator_connect_event(''{}'')','browser cannot ingest provider evidence');
select pg_temp.reject('select * from public.creator_commercial_observations','browser cannot read pending merchant observations');
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select public.set_creator_connect_account(current_setting('qa.account')::jsonb||jsonb_build_object('connect_account_id','acct_creator','charges_enabled',false,'payouts_enabled',true,'transfers_enabled',true,'details_submitted',true,'requirements_due','[]'::jsonb,'disabled_reason',null,'verified_at',clock_timestamp()));
select set_config('qa.bank',jsonb_build_object('event_id','evt_bankfailed','event_type','payout.failed','platform_account_id','acct_fixture','livemode',false,'payload_sha256',repeat('b',64),'observed_at',clock_timestamp(),'account_key',current_setting('qa.account')::jsonb->>'account_key','bank_payout',jsonb_build_object('payout_id','po_fixture','connected_account_id','acct_creator','status','failed','amount_minor',1500,'currency','USD','arrival_date',null,'failure_code','account_closed'))::text,true);
select pg_temp.check_true(public.ingest_creator_connect_event(current_setting('qa.bank')::jsonb)->>'duplicate'='false','first bank observation accepted');
select pg_temp.check_true(public.ingest_creator_connect_event(current_setting('qa.bank')::jsonb)->>'duplicate'='true','exact replay no duplicate');
select pg_temp.reject('select public.ingest_creator_connect_event(current_setting(''qa.bank'')::jsonb||jsonb_build_object(''payload_sha256'',repeat(''c'',64)))','same event different signed body rejected');
select pg_temp.reject('select public.ingest_creator_connect_event(current_setting(''qa.bank'')::jsonb||jsonb_build_object(''event_id'',''evt_foreign'',''platform_account_id'',''acct_foreign''))','wrong merchant cannot access creator mapping');
select pg_temp.reject('select public.ingest_creator_connect_event(current_setting(''qa.bank'')::jsonb||jsonb_build_object(''event_id'',''evt_livemode'',''livemode'',true))','test mapping cannot accept live event');
select public.ingest_creator_connect_event(jsonb_set(current_setting('qa.bank')::jsonb||jsonb_build_object('event_id','evt_oldbank','observed_at',clock_timestamp()-interval '1 day'),'{bank_payout,status}','"paid"'));
reset role;
select pg_temp.check_true((select status='failed' from public.creator_bank_payouts where payout_id='po_fixture'),'out of order old status cannot replace current failed payout');
select pg_temp.check_true((select count(*)=2 from public.creator_connect_events),'replay and failed validation do not create event rows');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000012","role":"authenticated"}',true);
select pg_temp.check_true(jsonb_array_length(public.get_partner_creator_bank_payouts())=1,'creator sees own bank failure');
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000013","role":"authenticated"}',true);
select pg_temp.check_true(public.get_partner_creator_bank_payouts()='[]','other creator sees no bank details');
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
-- A provider refund can arrive before the attributed purchase. It must survive.
select set_config('qa.early',jsonb_build_object('event_id','evt_earlyrefund','event_type','charge.refunded','platform_account_id','acct_fixture','livemode',false,'payload_sha256',repeat('d',64),'observed_at',clock_timestamp(),'order_hold',jsonb_build_object('payment_intent_id','pi_settle41','amount_minor',10000,'currency','USD','hold_type','refund_full','verified_amount_minor',10000,'reason','Provider verified refund before attribution'))::text,true);
select public.ingest_creator_connect_event(current_setting('qa.early')::jsonb);
select pg_temp.check_true((select count(*)=1 from public.creator_commercial_observations where applied_at is null),'unbound negative evidence retained');
select pg_temp.reject('select public.ingest_creator_connect_event(jsonb_set(current_setting(''qa.early'')::jsonb||jsonb_build_object(''event_id'',''evt_badpartial''),''{order_hold,hold_type}'',''"refund_partial"''))','partial refund may not pretend full amount');
reset role;
select pg_temp.make_order(41);
set local role service_role;
select public.process_external_commissions();
reset role;
select pg_temp.check_true((select applied_at is not null and order_id=(select order_id from test_external_orders where n=41) from public.creator_commercial_observations where payment_intent_id='pi_settle41'),'later order binds prior refund atomically');
select pg_temp.check_true(not exists(select 1 from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=41) and status='eligible'),'refunded-before-attribution order never eligible');
select pg_temp.check_true((select coalesce(sum(amount_minor),0)=0 from public.external_commission_ledger),'early full refund leaves zero creator liability');
select pg_temp.check_true((select status='reversed' from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=41)),'early refund audit retains earned and matching reversal');
select pg_temp.check_true((select count(*)=0 from public.external_settlement_jobs),'early refund never creates a payable transfer');
-- Dispute also remains held, including a later closed/won observation.
set local role service_role;
select public.ingest_creator_connect_event(jsonb_set(jsonb_set(current_setting('qa.early')::jsonb||jsonb_build_object('event_id','evt_earlydispute','event_type','charge.dispute.closed'),'{order_hold,payment_intent_id}','"pi_settle42"'),'{order_hold,hold_type}','"dispute"'));
reset role;
select pg_temp.make_order(42);
set local role service_role;
select public.process_external_commissions();
reset role;
select pg_temp.check_true(not exists(select 1 from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=42) and status='eligible'),'closed dispute never auto-restores commissions');
select pg_temp.check_true((select count(*)=0 from public.payouts),'provider evidence never activates legacy payouts');
rollback;
