-- ALL candidate DDL and synthetic ledger/destination/reconciliation fixtures roll back.
-- These fixtures prove workflow rules, NOT real provider verification or payment.
create temporary table payout_checks(label text);
grant select,insert on payout_checks to authenticated;
create function pg_temp.p_assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Payout assertion failed: %',label;end if;insert into payout_checks values(label);end $$;
create function pg_temp.p_error(statement text,code text,label text) returns void language plpgsql as $$
begin begin execute statement;exception when others then if sqlstate<>code then raise;end if;insert into payout_checks values(label);return;end;raise exception 'Expected rejection: %',label;end $$;
create function pg_temp.p_action(action text,target uuid,extra jsonb default '{}') returns jsonb language sql as $$
select public.perform_admin_payout_action(jsonb_build_object('request_id',gen_random_uuid(),'action',action,'reason','Rollback-only workflow assertion','id',target,'expected_updated_at',coalesce((select updated_at from public.payouts where id=target),(select updated_at from public.payout_periods where id=target)))||extra);
$$;
grant execute on function pg_temp.p_assert(boolean,text),pg_temp.p_error(text,text,text) to authenticated;
select pg_temp.p_assert(not has_function_privilege('anon','public.perform_admin_payout_action(jsonb)','execute'),'anonymous writes denied');
select pg_temp.p_assert(not has_function_privilege('service_role','public.perform_admin_payout_action(jsonb)','execute'),'service cannot impersonate browser operators');
select pg_temp.p_assert(not has_function_privilege('authenticated','public.create_admin_payout_period(jsonb)','execute'),'legacy period writer closed');
select pg_temp.p_assert(not has_function_privilege('authenticated','public.advance_admin_payout_period(jsonb)','execute'),'legacy transition writer closed');
select pg_temp.p_assert(not has_function_privilege('authenticated','public.prepare_admin_payout_statements(jsonb)','execute'),'legacy preparation writer closed');
select pg_temp.p_assert(not has_table_privilege('authenticated','kma_internal.payout_workflow_requests','select'),'idempotency cache private');
do $$ declare owner_id uuid; w jsonb; v text;
begin
  select user_id into strict owner_id from public.admin_users where role='owner' and active limit 1;
  perform set_config('kma_test.payout_owner',owner_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'amr',jsonb_build_array(jsonb_build_object('method','password')))::text,true);
  w:=public.get_admin_payout_workspace();
  perform pg_temp.p_assert(w->>'external_transfer_enabled'='false','transfer disabled');
  perform pg_temp.p_assert((w->>'total')::integer=(select count(*) from public.payouts where payout_period_id=(w->>'selected_period_id')::uuid),'real empty state exact');
  perform pg_temp.p_assert(w->>'processing_attention'=(not kma_internal.payout_processing_ready())::text,'real processing health projection');
  foreach v in array array['p_limit=>0','p_limit=>101','p_limit=>null','p_offset=>-1',$q$p_status=>'invented'$q$,$q$p_query=>repeat('x',121)$q$] loop
    perform pg_temp.p_error('select public.get_admin_payout_workspace('||v||')','22023','invalid filters '||v);
  end loop;
end $$;
-- Candidate helper only: controlled health for isolated rollback fixture cases.
-- No existing scheduler function, config, cron or worker is modified.
create or replace function kma_internal.payout_processing_ready() returns boolean language sql stable security definer set search_path='' as $$select true$$;
insert into public.affiliates(id,public_name,slug,status) values('39000000-0000-4000-8000-000000000001','Payout rollback fixture','payout-rollback-fixture','active');
insert into public.products(id,slug,name) values('29000000-0000-4000-8000-000000000001','payout-rollback-fixture','Payout rollback fixture');
insert into public.agreements(id,affiliate_id,product_id,version,model,minimum_payout_minor) values('49000000-0000-4000-8000-000000000001','39000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000001',1,'revenue_share',2000);
do $$ declare input jsonb; receipt jsonb; first_id uuid; second_id uuid; payout_id uuid; v text; w jsonb;
begin
  input:=jsonb_build_object('request_id',gen_random_uuid(),'action','create_period','reason','Rollback-only setup','starts_at','2025-01-01T00:00:00Z','ends_at','2025-01-15T00:00:00Z','review_starts_at','2025-01-15T00:00:00Z','payout_due_at','2025-01-16T00:00:00Z');
  receipt:=public.perform_admin_payout_action(input);first_id:=(receipt->>'id')::uuid;
  perform pg_temp.p_assert(public.perform_admin_payout_action(input)=receipt,'creation retry returns original receipt');
  perform pg_temp.p_assert((select count(*) from public.payout_periods where id=first_id)=1,'retry no duplicate period');
  perform pg_temp.p_error(format('select public.perform_admin_payout_action(%L::jsonb)',input||'{"reason":"Conflicting input"}'),'40001','request key cannot change payload');
  perform pg_temp.p_error(format('select public.perform_admin_payout_action(%L::jsonb)',input||jsonb_build_object('request_id',gen_random_uuid(),'final_payout_minor',1)),'22023','forged amount rejected');
  perform pg_temp.p_error(format('select public.perform_admin_payout_action(%L::jsonb)',input||jsonb_build_object('request_id',gen_random_uuid(),'starts_at',null)),'22023','null period date rejected');
  perform pg_temp.p_error(format('select public.perform_admin_payout_action(%L::jsonb)',input||jsonb_build_object('request_id',gen_random_uuid(),'ends_at','2025-01-16T00:00:00Z')),'22023','non-14-day period rejected');
  perform pg_temp.p_error(format('select pg_temp.p_action(%L,%L,%L::jsonb)','review_period',first_id,'{"expected_updated_at":"2020-01-01T00:00:00Z"}'),'40001','stale version rejected');
  perform pg_temp.p_error(format('select pg_temp.p_action(%L,%L)','prepare_statements',first_id),'P0001','open period preparation denied');
  second_id:=(public.perform_admin_payout_action(input||jsonb_build_object('request_id',gen_random_uuid(),'starts_at','2025-01-15T00:00:00Z','ends_at','2025-01-29T00:00:00Z','review_starts_at','2025-01-29T00:00:00Z','payout_due_at','2025-01-30T00:00:00Z'))->>'id')::uuid;
  perform set_config('kma_test.payout_period',first_id::text,true);perform set_config('kma_test.payout_next',second_id::text,true);
  insert into public.commission_entries(affiliate_id,product_id,agreement_id,payout_period_id,entry_type,amount_minor,currency,source_key,partner_visible_description)
    values('39000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000001','49000000-0000-4000-8000-000000000001',first_id,'adjustment',2500,'USD','rollback-payout-positive','Synthetic rollback-only adjustment');
  perform pg_temp.p_action('review_period',first_id);perform pg_temp.p_action('close_period',first_id);perform pg_temp.p_action('prepare_statements',first_id);
  select id into strict payout_id from public.payouts where payout_period_id=first_id;
  perform set_config('kma_test.payout',payout_id::text,true);
  w:=public.get_admin_payout_statement(payout_id);
  perform pg_temp.p_assert(w#>>'{payout,final_payout_minor}'='2500','prepared amount equals ledger');
  perform pg_temp.p_assert(jsonb_array_length(w->'agreements')=1,'agreement snapshot included');
  perform pg_temp.p_assert(jsonb_array_length(w->'ledger')=1,'immutable ledger included');
  perform pg_temp.p_assert(w::text !~ '(provider_reference|internal_note|bank_account|client_secret)','statement excludes sensitive fields');
  perform pg_temp.p_assert(w#>'{payout,approval_blockers}' ? 'verified_destination_required','missing destination explained');
  perform pg_temp.p_assert(w#>'{payout,approval_blockers}' ? 'reconciliation_required','missing reconciliation explained');
  perform pg_temp.p_error(format('select pg_temp.p_action(%L,%L)','approve',payout_id),'P0001','unreviewed approval denied');
  perform pg_temp.p_action('review',payout_id);
  perform pg_temp.p_error(format('select pg_temp.p_action(%L,%L)','approve',payout_id),'P0001','missing evidence approval denied');
  perform pg_temp.p_action('hold',payout_id);
  perform pg_temp.p_assert((select status='on_hold' and held_from_status='review' from public.payouts where id=payout_id),'hold preserves status');
  perform pg_temp.p_action('resume',payout_id);
  perform pg_temp.p_assert((select status='review' from public.payouts where id=payout_id),'resume restores reviewed state');
  foreach v in array array['paid','scheduled','send_transfer','edit_amount'] loop
    perform pg_temp.p_error(format('select pg_temp.p_action(%L,%L)',v,payout_id),'22023','unsupported money operation '||v);
  end loop;
end $$;
-- Backdated, synthetic destination evidence only within rollback transaction.
insert into public.payout_destinations(id,affiliate_id,version,method,display_label,currency,provider_reference,created_by,created_at,reauthenticated_at,email_confirmed_at,hold_until)
values('59000000-0000-4000-8000-000000000001','39000000-0000-4000-8000-000000000001',1,'bank','Synthetic masked bank','USD','rollback-not-a-provider-reference',current_setting('kma_test.payout_owner')::uuid,now()-interval '3 days',now()-interval '3 days',now()-interval '3 days',now()-interval '1 day');
update public.payout_destinations set status='verification_pending' where id='59000000-0000-4000-8000-000000000001';
update public.payout_destinations set status='pending_hold',verification_status='passed',verification_method='rollback-fixture',verified_at=now()-interval '2 days' where id='59000000-0000-4000-8000-000000000001';
update public.payout_destinations set status='active',effective_at=now() where id='59000000-0000-4000-8000-000000000001';
insert into public.reconciliation_runs(id,starts_at,ends_at,currency,idempotency_key,scheduled_for)
values('69000000-0000-4000-8000-000000000001','2025-01-01','2025-01-15','USD','rollback-payout-reconciliation',now());
update public.reconciliation_runs set status='running',started_at=now() where id='69000000-0000-4000-8000-000000000001';
update public.reconciliation_runs set status='passed',completed_at=now(),provider_total_minor=0,internal_total_minor=0,unexplained_difference_minor=0 where id='69000000-0000-4000-8000-000000000001';
do $$ declare payout_id uuid:=current_setting('kma_test.payout')::uuid; input jsonb; receipt jsonb; w jsonb;
begin
  w:=public.get_admin_payout_statement(payout_id);
  perform pg_temp.p_assert(w#>'{payout,approval_blockers}'='[]'::jsonb,'complete fixture evidence makes approval ready');
  input:=jsonb_build_object('request_id',gen_random_uuid(),'action','approve','reason','Rollback-only approval','id',payout_id,'expected_updated_at',(select updated_at from public.payouts where id=payout_id));
  receipt:=public.perform_admin_payout_action(input);
  perform pg_temp.p_assert(public.perform_admin_payout_action(input)=receipt,'approval retry idempotent');
  perform pg_temp.p_assert((select status='approved' and paid_at is null and payment_reference is null and destination_version_snapshot=1 and calculation_finalized_at is not null from public.payouts where id=payout_id),'approval freezes evidence but does not pay');
  perform pg_temp.p_error(format('update public.payouts set adjustments_minor=2600,final_payout_minor=2600 where id=%L',payout_id),'P0001','finalized arithmetic immutable');
  perform pg_temp.p_action('hold',payout_id);perform pg_temp.p_action('resume',payout_id);
  perform pg_temp.p_assert((select status='approved' from public.payouts where id=payout_id),'approved hold can resume original valid evidence');
  perform pg_temp.p_action('prepare_statements',current_setting('kma_test.payout_period')::uuid);
  perform pg_temp.p_assert((select status='approved' from public.payouts where id=payout_id),'repeat preparation never recalculates finalized statement');
  perform pg_temp.p_assert((select count(*)=1 from kma_internal.payout_workflow_requests where request_id=(receipt->>'request_id')::uuid),'single approval request persisted in rollback fixture');
  perform pg_temp.p_assert((select count(*)=1 from public.audit_logs where action='payout_workflow_approve' and after_data->>'request_id'=input->>'request_id'),'one approval audit for retry');
end $$;
-- Below-minimum signed carry-forward, including debt. Neither path sends money.
insert into public.products(id,slug,name) values('29000000-0000-4000-8000-000000000002','payout-negative-fixture','Negative rollback fixture');
insert into public.agreements(id,affiliate_id,product_id,version,model,minimum_payout_minor) values('49000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000002',1,'revenue_share',2000);
insert into public.commission_entries(affiliate_id,product_id,agreement_id,payout_period_id,entry_type,amount_minor,currency,source_key,partner_visible_description)
values('39000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000001','49000000-0000-4000-8000-000000000001',current_setting('kma_test.payout_next')::uuid,'adjustment',1000,'USD','rollback-carry-positive','Synthetic positive adjustment'),
('39000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000002','49000000-0000-4000-8000-000000000002',current_setting('kma_test.payout_next')::uuid,'adjustment',-500,'USD','rollback-carry-negative','Synthetic negative adjustment');
insert into public.reconciliation_runs(id,starts_at,ends_at,currency,idempotency_key,scheduled_for)
values('69000000-0000-4000-8000-000000000002','2025-01-15','2025-01-29','USD','rollback-carry-reconciliation',now());
update public.reconciliation_runs set status='running',started_at=now() where id='69000000-0000-4000-8000-000000000002';
update public.reconciliation_runs set status='passed',completed_at=now(),provider_total_minor=0,internal_total_minor=0,unexplained_difference_minor=0 where id='69000000-0000-4000-8000-000000000002';
do $$ declare second_id uuid:=current_setting('kma_test.payout_next')::uuid; third_id uuid; p record; input jsonb; receipt jsonb;
begin
  third_id:=(public.perform_admin_payout_action(jsonb_build_object('request_id',gen_random_uuid(),'action','create_period','reason','Rollback carry destination','starts_at','2025-01-29T00:00:00Z','ends_at','2025-02-12T00:00:00Z','review_starts_at','2025-02-12T00:00:00Z','payout_due_at','2025-02-13T00:00:00Z'))->>'id')::uuid;
  perform pg_temp.p_action('review_period',second_id);perform pg_temp.p_action('close_period',second_id);perform pg_temp.p_action('prepare_statements',second_id);
  for p in select * from public.payouts where payout_period_id=second_id loop
    perform pg_temp.p_action('review',p.id);
    perform pg_temp.p_error(format('select pg_temp.p_action(%L,%L)','approve',p.id),'P0001','below minimum cannot approve '||p.currency||p.adjustments_minor);
    perform pg_temp.p_error(format('select pg_temp.p_action(%L,%L,%L::jsonb)','carry_forward',p.id,jsonb_build_object('next_period_id',second_id)),'P0001','closed carry destination rejected');
    input:=jsonb_build_object('request_id',gen_random_uuid(),'action','carry_forward','reason','Rollback signed carry proof','id',p.id,'expected_updated_at',(select updated_at from public.payouts where id=p.id),'next_period_id',third_id);
    receipt:=public.perform_admin_payout_action(input);
    perform pg_temp.p_assert(public.perform_admin_payout_action(input)=receipt,'carry retry returns original receipt');
    perform pg_temp.p_assert((select status='carried_forward' and final_payout_minor=0 and carry_out_minor=p.adjustments_minor from public.payouts where id=p.id),'entire signed balance carried');
    perform pg_temp.p_assert((select count(*)=1 and sum(amount_minor)=p.adjustments_minor from public.commission_entries where source_payout_id=p.id and payout_period_id=third_id),'one exact immutable carry entry');
  end loop;
end $$;
-- Existing immutable passed-window policy and revoked destinations fail closed.
-- A different agreement cadence is visible but cannot accidentally finalize on a 14-day policy.
insert into public.products(id,slug,name) values('29000000-0000-4000-8000-000000000003','payout-cadence-fixture','Cadence rollback fixture');
insert into public.agreements(id,affiliate_id,product_id,version,model,minimum_payout_minor,payout_frequency_days) values('49000000-0000-4000-8000-000000000003','39000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000003',1,'revenue_share',2000,30);
do $$ declare period_id uuid; p_id uuid;
begin
  select id into strict period_id from public.payout_periods where starts_at='2025-01-29T00:00:00Z';
  insert into public.commission_entries(affiliate_id,product_id,agreement_id,payout_period_id,entry_type,amount_minor,currency,source_key,partner_visible_description)
    values('39000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000003','49000000-0000-4000-8000-000000000003',period_id,'adjustment',2500,'USD','rollback-cadence','Synthetic cadence assertion');
  perform pg_temp.p_action('review_period',period_id);perform pg_temp.p_action('close_period',period_id);perform pg_temp.p_action('prepare_statements',period_id);
  select id into strict p_id from public.payouts where payout_period_id=period_id and product_id='29000000-0000-4000-8000-000000000003';
  perform pg_temp.p_assert(kma_internal.payout_review_state(p_id)->'common_blockers' ? 'cadence_policy_required','non-14-day terms require policy');
end $$;
select pg_temp.p_action('hold',current_setting('kma_test.payout')::uuid);
select pg_temp.p_error($q$insert into public.reconciliation_runs(starts_at,ends_at,currency,idempotency_key,scheduled_for) values('2025-01-01','2025-01-15','USD','rollback-duplicate-window',now())$q$,'23505','existing passed reconciliation window cannot be duplicated');
update public.payout_destinations set status='revoked' where id='59000000-0000-4000-8000-000000000001';
select pg_temp.p_assert(kma_internal.payout_review_state(current_setting('kma_test.payout')::uuid)->'approval_blockers' ? 'verified_destination_required','revoked destination reported');
select pg_temp.p_error(format('select pg_temp.p_action(%L,%L)','resume',current_setting('kma_test.payout')),'P0001','revoked destination blocks approved resume');
-- Controlled unhealthy state tests candidate helper, not the production scheduler.
create or replace function kma_internal.payout_processing_ready() returns boolean language sql stable security definer set search_path='' as $$select false$$;
select pg_temp.p_assert(kma_internal.payout_review_state(current_setting('kma_test.payout')::uuid)->'common_blockers' ? 'processing_not_ready','unhealthy processing blocks approval');
select pg_temp.p_assert(public.get_admin_payout_workspace()->>'processing_attention'='true','unhealthy state visible');
-- Browser role execution and all role gates, changes roll back.
set local role authenticated;
select pg_temp.p_assert(public.get_admin_payout_workspace() ? 'items','authenticated owner workspace');
select pg_temp.p_assert(public.perform_admin_payout_action(jsonb_build_object('request_id',gen_random_uuid(),'action','create_period','reason','Actual authenticated role rollback check','starts_at','2025-02-12T00:00:00Z','ends_at','2025-02-26T00:00:00Z','review_starts_at','2025-02-26T00:00:00Z','payout_due_at','2025-02-27T00:00:00Z'))->>'external_transfer'='false','authenticated role executes protected wrapper');
select pg_temp.p_error('select kma_internal.payout_review_state(null)','42501','internal helper unavailable to browser');
select set_config('request.jwt.claims','{}',true);
select pg_temp.p_error('select public.get_admin_payout_workspace()','28000','missing session denied');
reset role;
do $$ declare v text; owner_id uuid:=current_setting('kma_test.payout_owner')::uuid;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'amr',jsonb_build_array(jsonb_build_object('method','recovery')))::text,true);
  perform pg_temp.p_error('select public.get_admin_payout_workspace()','42501','recovery session denied');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'amr',jsonb_build_array(jsonb_build_object('method','password')))::text,true);
  foreach v in array array['operations','analyst','finance'] loop
    update public.admin_users set role=v where user_id=owner_id;
    perform pg_temp.p_assert(public.get_admin_payout_workspace() ? 'items','read role '||v);
    if v<>'finance' then perform pg_temp.p_error($q$select public.perform_admin_payout_action('{}')$q$,'42501','write denied '||v);end if;
  end loop;
  update public.admin_users set role='support' where user_id=owner_id;
  perform pg_temp.p_error('select public.get_admin_payout_workspace()','42501','support read denied');
  update public.admin_users set role='owner',active=false where user_id=owner_id;
  perform pg_temp.p_error('select public.get_admin_payout_workspace()','42501','inactive owner denied');
end $$;
select count(*) as passed_payout_assertions from payout_checks;
