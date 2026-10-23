-- Signed minimum and cadence gate settlement independently of validation holds.
begin;
select set_config('qa.policy.minimum','3000',true);
select set_config('qa.policy.cadence','3',true);
\i supabase/tests/fixtures/external-canonical.sql
select pg_temp.make_order(1);select public.process_external_commissions();
select pg_temp.ready_account();
set local role authenticated;
select pg_temp.reject('select public.perform_admin_external_settlement_action(current_setting(''qa.scope'')::jsonb||jsonb_build_object(''request_id'',gen_random_uuid(),''action'',''prepare_batch'',''reason'',''Below signed minimum test''))','one earning below signed minimum cannot settle');
reset role;
select pg_temp.make_order(2);select pg_temp.make_order(3,8000,false,clock_timestamp());select public.process_external_commissions();
select pg_temp.check_true((select status='held' and blocker='validation_window' from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=3)),'new purchase remains inside signed validation hold');
select set_config('qa.batch',pg_temp.prepare_approved()::text,true);
select pg_temp.check_true((select amount_minor=4000 from public.external_settlement_batches),'only mature awards meet minimum');
select pg_temp.check_true((select count(*)=2 from public.external_settlement_items),'unvalidated purchase excluded from frozen batch');
select pg_temp.make_order(4);select public.process_external_commissions();
select pg_temp.check_true(not kma_internal.external_award_cadence_ready((select id from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=4))),'new late earnings wait until next agreed period');
set local role authenticated;
select pg_temp.reject('select public.perform_admin_external_settlement_action(current_setting(''qa.scope'')::jsonb||jsonb_build_object(''request_id'',gen_random_uuid(),''action'',''prepare_batch'',''reason'',''No second batch this period''))','same agreement period cannot pay twice');
reset role;
select set_config('qa.boundary',kma_internal.external_payout_boundary((current_setting('qa.terms')::jsonb->>'id')::uuid)::text,true);
set local time zone 'America/New_York';
select pg_temp.check_true(kma_internal.external_payout_boundary((current_setting('qa.terms')::jsonb->>'id')::uuid)=current_setting('qa.boundary')::timestamptz,'payout anchor invariant across session timezone');
-- An elapsed period is simulated only by the disposable database owner.
update public.external_settlement_batches set created_at=clock_timestamp()-interval '4 days';
select pg_temp.check_true(kma_internal.external_award_cadence_ready((select id from public.external_commission_awards where order_id=(select order_id from test_external_orders where n=4))),'carried earning becomes available in later period');
select pg_temp.make_order(5);select public.process_external_commissions();
select set_config('qa.batch2',pg_temp.prepare_approved()::text,true);
select pg_temp.check_true((select amount_minor=4000 from public.external_settlement_batches where id=(current_setting('qa.batch2')::jsonb->>'id')::uuid),'carried earnings still respect signed minimum');
-- A refund changes the frozen statement: reviewed approval cannot send stale amount.
select pg_temp.refund_order(4);
select pg_temp.check_true((select status='held' from public.external_settlement_batches where id=(current_setting('qa.batch2')::jsonb->>'id')::uuid),'refund immediately invalidates reviewed statement');
select set_config('qa.job',(select value::text from public.claim_creator_transfer_jobs('acct_fixture',false) value),true);
select pg_temp.check_true(current_setting('qa.job')::jsonb->>'batch_id'=current_setting('qa.batch')::jsonb->>'id','only unaffected earlier approved batch can be claimed');
select pg_temp.check_true((current_setting('qa.job')::jsonb->>'first_attempt_at') is null,'lease and account preflight are not provider mutation');
select public.finish_creator_transfer_job(jsonb_build_object('id',current_setting('qa.job')::jsonb->>'id','lease_token',current_setting('qa.job')::jsonb->>'lease_token','status','retry','safe_error','Creator account not ready'));
-- Age a purely read-only preflight: it must remain recoverable without a new key.
update public.external_settlement_jobs set created_at=clock_timestamp()-interval '30 days',next_attempt_at=clock_timestamp()-interval '1 second' where id=(current_setting('qa.job')::jsonb->>'id')::uuid;
select set_config('qa.job2',(select value::text from public.claim_creator_transfer_jobs('acct_fixture',false) value),true);
select pg_temp.check_true(current_setting('qa.job2')::jsonb->>'id'=current_setting('qa.job')::jsonb->>'id' and (current_setting('qa.job2')::jsonb->>'first_attempt_at') is null,'preflight can retry after days with unchanged provider identity');
select pg_temp.reject('select public.begin_creator_transfer_attempt(jsonb_build_object(''id'',current_setting(''qa.job2'')::jsonb->>''id'',''lease_token'',gen_random_uuid()))','forged provider mutation marker rejected');
select public.begin_creator_transfer_attempt(jsonb_build_object('id',current_setting('qa.job2')::jsonb->>'id','lease_token',current_setting('qa.job2')::jsonb->>'lease_token'));
select pg_temp.check_true((select first_attempt_at is not null from public.external_settlement_jobs where id=(current_setting('qa.job2')::jsonb->>'id')::uuid),'first possible POST starts bounded provider retry clock');
update public.external_settlement_jobs set first_attempt_at=clock_timestamp()-interval '24 hours' where id=(current_setting('qa.job2')::jsonb->>'id')::uuid;
select public.finish_creator_transfer_job(jsonb_build_object('id',current_setting('qa.job2')::jsonb->>'id','lease_token',current_setting('qa.job2')::jsonb->>'lease_token','status','retry','safe_error','Possible POST outcome unknown'));
update public.external_settlement_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where id=(current_setting('qa.job2')::jsonb->>'id')::uuid;
select pg_temp.check_true((select count(*)=0 from public.claim_creator_transfer_jobs('acct_fixture',false)),'uncertain old POST never resets provider retry clock');
select pg_temp.check_true((select state='reconcile' from public.external_settlement_jobs where id=(current_setting('qa.job2')::jsonb->>'id')::uuid),'uncertain old provider attempt requires read-only reconciliation');
select pg_temp.check_true(not has_function_privilege('authenticated','public.begin_creator_transfer_attempt(jsonb)','EXECUTE'),'browser cannot mark provider mutation');
rollback;
