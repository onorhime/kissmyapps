begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_table('public', 'commercial_fact_processing', 'durable commercial fact queue exists');
select has_table('public', 'commercial_dispute_balance_evidence', 'Stripe dispute money is deduplicated by balance transaction');
select has_table('public', 'commercial_source_applications', 'commercial calculations retain an immutable explanation');
select has_table('public', 'commercial_metric_refresh_queue', 'durable metrics refresh queue exists');
select has_table('public', 'commercial_reconciliation_evidence', 'independent reconciliation evidence is persisted');
select has_function('public', 'process_commercial_fact', array['uuid','uuid'], 'atomic commercial calculation RPC exists');
select has_function('public', 'process_commercial_metric_refresh', array['uuid','uuid'], 'idempotent metrics refresh RPC exists');
select has_function('public', 'process_commercial_reconciliation', array['uuid','uuid'], 'evidence-backed reconciliation RPC exists');
select has_function('public', 'perform_admin_payout_action', array['jsonb'], 'versioned and idempotent payout workflow RPC exists');
select ok(
  not has_function_privilege('authenticated', 'public.advance_admin_payout_period(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.prepare_admin_payout_statements(jsonb)', 'EXECUTE'),
  'legacy payout writers remain unavailable to browser operators'
);

-- Use the same public version token and action boundary as the current Admin UI.
-- These temporary helpers are invoker functions, with no table/grant bypass.
create function pg_temp.commercial_period(target uuid) returns jsonb language sql as $$
  select period from jsonb_array_elements(public.get_admin_payout_workspace(target)->'periods') period
  where period->>'id'=target::text;
$$;
create function pg_temp.commercial_payout_action(action text,target uuid) returns jsonb language sql as $$
  select public.perform_admin_payout_action(jsonb_build_object(
    'request_id',gen_random_uuid(),'action',action,'reason','Rollback-only commercial reconciliation test',
    'id',target,'expected_updated_at',pg_temp.commercial_period(target)->'updated_at'
  ));
$$;
grant execute on function pg_temp.commercial_period(uuid),pg_temp.commercial_payout_action(text,uuid) to authenticated;

select ok(
  has_function_privilege('service_role', 'public.claim_commercial_facts(text,integer,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.process_commercial_fact(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.process_commercial_fact(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.process_commercial_fact(uuid,uuid)', 'EXECUTE'),
  'only the Edge service role can mutate the commercial ledger'
);
select ok(
  not has_table_privilege('service_role', 'public.commercial_transaction_states', 'SELECT')
  and not has_table_privilege('service_role', 'public.commercial_dispute_balance_evidence', 'SELECT')
  and not has_table_privilege('authenticated', 'public.commercial_source_applications', 'SELECT'),
  'commercial state is only reachable through constrained security-definer RPCs'
);
select is(
  public.commercial_commission_amount('cpl', 500, null, 10000),
  null::bigint,
  'non-transaction CPL calculation remains unsupported and fail-closed'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '10000000-0000-4000-8000-000000000101',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'commercial-finance@example.test', '', now(),
  '{}', '{"full_name":"Commercial Finance"}', now(), now()
);
insert into public.admin_users (user_id, role, active) values
  ('10000000-0000-4000-8000-000000000101', 'finance', true);

insert into public.platform_settings (singleton, tracking_base_url)
values (true, 'https://go.kissmyapps.dev')
on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url;
insert into public.products (id, slug, name, status) values
  ('20000000-0000-4000-8000-000000000101', 'commercial-product', 'Commercial Product', 'active');
insert into public.affiliates (
  id, public_name, legal_name, slug, entity_type, reporting_timezone,
  preferred_currency, status
) values (
  '30000000-0000-4000-8000-000000000101', 'Commercial Partner',
  'Commercial Partner LLC', 'commercial-partner', 'company', 'UTC', 'USD', 'active'
);
insert into public.funnels (id, product_id, key, name, destination_url, status, is_default)
values (
  '50000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101',
  'commercial-funnel', 'Commercial Funnel', 'https://product.kissmyapps.dev/start', 'live', true
);
insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url, status
) values (
  '60000000-0000-4000-8000-000000000101',
  '30000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101',
  '50000000-0000-4000-8000-000000000101',
  'Commercial link', 'commerciallink101',
  'https://go.kissmyapps.dev/r/commercial-partner/commerciallink101', 'paused'
);
insert into public.accounts (id, external_key) values
  ('70000000-0000-4000-8000-000000000101', 'commercial-account-101');
insert into public.clicks (
  id, public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id,
  session_id_hash, destination_url_snapshot, is_bot, occurred_at
) values (
  '61000000-0000-4000-8000-000000000101', 'commercialclick101',
  '60000000-0000-4000-8000-000000000101',
  '30000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101',
  '50000000-0000-4000-8000-000000000101',
  repeat('a', 64), 'https://product.kissmyapps.dev/start', false,
  '2026-08-20 01:00:00+00'
);
insert into public.acquisitions (
  id, product_id, affiliate_id, click_record_id, account_id, funnel_id,
  attribution_method, status, resolved_at, created_at
) values (
  '62000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101',
  '30000000-0000-4000-8000-000000000101',
  '61000000-0000-4000-8000-000000000101',
  '70000000-0000-4000-8000-000000000101',
  '50000000-0000-4000-8000-000000000101',
  'deterministic_web', 'resolved', '2026-08-20 01:01:00+00', '2026-08-20 01:00:00+00'
);
insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  attribution_window_days, payout_frequency_days, payout_currency, minimum_payout_minor
) values (
  '40000000-0000-4000-8000-000000000101',
  '30000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101',
  1, 'revenue_share', 'draft', '2026-08-01', 30, 7, 'USD', 1000
);
insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event, rate_basis_points, refund_cutoff_days, validation_window_hours, policy_version
) values (
  '41000000-0000-4000-8000-000000000101',
  '40000000-0000-4000-8000-000000000101',
  'Verified purchase revenue share', 1, 'active', 'revenue_share', 'purchase.completed', 2000, 2, 8760, 2
);
update public.agreements set status = 'active'
where id = '40000000-0000-4000-8000-000000000101';

insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at
) values
(
  '80000000-0000-4000-8000-000000000101',
  '2026-08-20 00:00:00+00', '2026-08-20 06:00:00+00',
  '2026-08-20 06:00:00+00', '2026-08-23 00:00:00+00'
),
(
  '80000000-0000-4000-8000-000000000104',
  '2026-08-20 06:00:00+00', '2026-08-27 00:00:00+00',
  '2026-08-27 00:00:00+00', '2026-08-30 00:00:00+00'
),
(
  '80000000-0000-4000-8000-000000000103',
  '2026-08-27 00:00:00+00', '2099-01-01 00:00:00+00',
  '2099-01-01 00:00:00+00', '2099-01-04 00:00:00+00'
);
select throws_ok(
  $$insert into public.payout_periods (starts_at,ends_at,review_starts_at,payout_due_at) values ('2026-08-26','2026-08-28','2026-08-28','2026-08-29')$$,
  '23P01', 'payout periods cannot overlap',
  'overlapping open payout periods are rejected before calculations become ambiguous'
);

insert into public.provider_events (
  id, provider, provider_event_id, event_type, payload, signature_verified
) values (
  '90000000-0000-4000-8000-000000000101', 'stripe', 'evt_live_commercial_101',
  'invoice.paid', '{"id":"evt_live_commercial_101","livemode":true}', true
);
insert into public.subscriptions (
  id, account_id, product_id, acquisition_id, stripe_customer_id,
  stripe_subscription_id, status, currency
) values (
  '71000000-0000-4000-8000-000000000101',
  '70000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101',
  '62000000-0000-4000-8000-000000000101',
  'cus_commercial_101', 'sub_commercial_101', 'active', 'USD'
);
insert into public.events (
  id, source, source_event_id, event_name, product_id, affiliate_id,
  acquisition_id, account_id, funnel_id, provider_event_id, properties,
  occurred_at, trust, commercial_eligible
) values (
  '92000000-0000-4000-8000-000000000101', 'stripe', 'invoice:commercial-101:paid',
  'purchase.completed', '20000000-0000-4000-8000-000000000101',
  '30000000-0000-4000-8000-000000000101',
  '62000000-0000-4000-8000-000000000101',
  '70000000-0000-4000-8000-000000000101',
  '50000000-0000-4000-8000-000000000101',
  '90000000-0000-4000-8000-000000000101',
  '{"transaction_id":"91000000-0000-4000-8000-000000000101"}',
  '2026-08-20 03:00:00+00', 'provider', true
);
insert into public.transactions (
  id, subscription_id, acquisition_id, provider_event_id, stripe_invoice_id,
  balance_transaction_id, kind, gross_minor, fee_minor, tax_minor,
  eligible_net_minor, currency, settled_currency, occurred_at
) values (
  '91000000-0000-4000-8000-000000000101',
  '71000000-0000-4000-8000-000000000101',
  '62000000-0000-4000-8000-000000000101',
  '90000000-0000-4000-8000-000000000101',
  'in_commercial_101', 'txn_commercial_101', 'first_purchase',
  10000, 500, 500, 9000, 'USD', 'USD', '2026-08-20 03:00:00+00'
);

create temporary table commercial_claims (
  processing_id uuid, source_kind text, source_id uuid, claim_token uuid,
  attempt_count integer, occurred_at timestamptz
);
grant all on commercial_claims to service_role;
set local role service_role;
insert into commercial_claims select * from public.claim_commercial_facts('commercial-worker', 1, 180);
select throws_ok(
  $$select public.process_commercial_fact((select processing_id from commercial_claims limit 1),(select claim_token from commercial_claims limit 1))$$,
  'P0001', 'transaction requires one effective active signed agreement',
  'an operationally active but unsigned agreement cannot generate money'
);
select is(
  public.fail_commercial_fact(
    (select processing_id from commercial_claims limit 1),
    (select claim_token from commercial_claims limit 1),
    'signed_agreement_unavailable', 0, false
  ),
  'pending'::public.processing_status,
  'missing legal evidence remains retryable instead of becoming payable or disappearing'
);
reset role;

insert into public.documents (
  id, affiliate_id, agreement_id, name, document_type, version, file_path,
  status, effective_at, signed_by_partner_at, signed_by_kissmyapps_at
) values (
  '42000000-0000-4000-8000-000000000101',
  '30000000-0000-4000-8000-000000000101',
  '40000000-0000-4000-8000-000000000101',
  'Commercial agreement', 'affiliate_agreement', 1,
  '30000000-0000-4000-8000-000000000101/agreement-v1.pdf',
  'active', '2026-08-01', '2026-08-01', '2026-08-01'
);

truncate commercial_claims;
set local role service_role;
insert into commercial_claims select * from public.claim_commercial_facts('commercial-worker', 1, 180);
select lives_ok(
  $$select public.process_commercial_fact((select processing_id from commercial_claims limit 1),(select claim_token from commercial_claims limit 1))$$,
  'exact signed evidence lets the transaction post atomically'
);
reset role;
select is(
  (select amount_minor from public.commission_entries where source_key = 'commercial:transaction:91000000-0000-4000-8000-000000000101'),
  1800::bigint,
  'the immutable 20 percent rule applies to exact 9000-minor eligible net'
);
select is(
  (select count(*) from public.commission_entries where transaction_id = '91000000-0000-4000-8000-000000000101' and entry_type = 'commission'),
  1::bigint,
  'transaction retries can post the original commission only once'
);


-- Explicit local-only two-day refund cutoff. Late arrival never changes provider time.
select is((select commission_policy_snapshot->>'refund_cutoff_days' from public.commercial_transaction_states), '2', 'original commission freezes its refund cutoff');
select throws_ok($q$update public.commercial_transaction_states set commission_policy_snapshot='{}'::jsonb$q$, '55000', 'Recorded commission policy is immutable', 'recorded policy cannot be changed');
select throws_ok($q$update public.commission_rules set refund_cutoff_days=1 where id='41000000-0000-4000-8000-000000000101'$q$, 'P0001', 'rules on active or historical agreements are immutable', 'active signed rule cutoff cannot be edited');

create function pg_temp.process_refund_fixture(suffix text,amount_value bigint,occurred_value timestamptz) returns void language plpgsql as $$
declare provider_id uuid:=gen_random_uuid(); refund_id uuid:=gen_random_uuid(); claim record;
begin
 insert into public.provider_events(id,provider,provider_event_id,event_type,payload,signature_verified)
 values(provider_id,'stripe','evt_refund_policy_'||suffix,'refund.created','{"livemode":true}',true);
 insert into public.refunds(id,transaction_id,provider_event_id,stripe_refund_id,amount_minor,balance_impact_minor,currency,occurred_at)
 values(refund_id,'91000000-0000-4000-8000-000000000101',provider_id,'re_policy_'||suffix,amount_value,-amount_value,'USD',occurred_value);
 for claim in select * from public.claim_commercial_facts('refund-policy',20,180) loop
  perform public.process_commercial_fact(claim.processing_id,claim.claim_token);
 end loop;
end $$;

-- Deliver a late, excluded refund FIRST; subsequent in-window refunds still apply.
select pg_temp.process_refund_fixture('late',8000,'2026-08-22T03:00:01Z');
select is((select current_commission_minor from public.commercial_transaction_states),1800::bigint,'refund one second after cutoff preserves commission');
select is((select refund_policy->>'excluded' from public.commercial_source_applications where source_kind='refund'),'true','late refund decision is retained');
select is((select refund_policy->>'provider_balance_impact_minor' from public.commercial_source_applications where source_kind='refund'),'-8000','excluded refund keeps actual financial evidence for audit');
select is((select count(*) from public.commission_entries where entry_type='refund_reversal'),0::bigint,'excluded refund creates no reversal');
select pg_temp.process_refund_fixture('before',1000,'2026-08-22T02:59:59Z');
select is((select current_commission_minor from public.commercial_transaction_states),1600::bigint,'delayed delivery of in-window refund still reduces commission');
select pg_temp.process_refund_fixture('boundary',1000,'2026-08-22T03:00:00Z');
select is((select current_commission_minor from public.commercial_transaction_states),1400::bigint,'refund exactly on cutoff is included');
select is((select applied_balance_impact_minor from public.commercial_transaction_states),-2000::bigint,'excluded refund never poisons later commission calculations');
select is((select count(*) from public.claim_commercial_facts('duplicate-poll',20,180)),0::bigint,'processed refund queue cannot be claimed twice');
select is((select count(*) from public.commercial_source_applications where source_kind='refund'),3::bigint,'each provider refund has one immutable calculation record');

-- A dispute after the cutoff is independent of the ordinary-refund exclusion.
insert into public.provider_events(id,provider,provider_event_id,event_type,payload,signature_verified)
values('90000000-0000-4000-8000-000000000444','stripe','evt_policy_dispute_444','charge.dispute.created',
 jsonb_build_object('created',extract(epoch from '2026-08-24T03:00:00Z'::timestamptz)::bigint,'livemode',true,'data',jsonb_build_object('object',jsonb_build_object('id','dp_policy_444','balance_transactions',jsonb_build_array(jsonb_build_object('id','txn_policy_dispute_444','amount',-2000,'fee',0,'net',-2000,'currency','usd','created',extract(epoch from '2026-08-24T03:00:00Z'::timestamptz)::bigint))))),true);
insert into public.disputes(id,transaction_id,provider_event_id,stripe_dispute_id,status,disputed_minor,fee_minor,balance_impact_minor,currency,occurred_at)
values('94000000-0000-4000-8000-000000000444','91000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000444','dp_policy_444','open',2000,0,-2000,'USD','2026-08-24T03:00:00Z');
select public.process_commercial_fact(processing_id,claim_token) from public.claim_commercial_facts('policy-dispute',20,180);
select is((select current_commission_minor from public.commercial_transaction_states),1000::bigint,'ordinary-refund cutoff does not shield chargeback impact');
select is((select count(*) from public.commercial_source_applications where source_kind='dispute' and refund_policy is not null),0::bigint,'dispute policy is not represented as an ordinary refund');

-- The one-year synthetic validation wait is unrelated to the two-day cutoff.
insert into public.payouts(id,affiliate_id,product_id,payout_period_id,currency)
values('88000000-0000-4000-8000-000000000444','30000000-0000-4000-8000-000000000101','20000000-0000-4000-8000-000000000101','80000000-0000-4000-8000-000000000101','USD');
select ok(kma_internal.payout_review_state('88000000-0000-4000-8000-000000000444')->'common_blockers' ? 'validation_window_pending','payout approval honors original validation wait separately from refund cutoff');
select ok(not has_column_privilege('authenticated','public.commercial_source_applications','refund_policy','SELECT'),'refund decision internals are not exposed by direct browser table access');
select * from finish();
rollback;
