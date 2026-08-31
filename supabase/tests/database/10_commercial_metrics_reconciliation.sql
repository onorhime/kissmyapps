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
select has_function('public', 'prepare_admin_payout_statements', array['jsonb'], 'manual statement preparation RPC exists');

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
  id, agreement_id, name, version, status, model, trigger_event, rate_basis_points
) values (
  '41000000-0000-4000-8000-000000000101',
  '40000000-0000-4000-8000-000000000101',
  'Verified purchase revenue share', 1, 'active', 'revenue_share', 'purchase.completed', 2000
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

insert into public.provider_events (id, provider, provider_event_id, event_type, payload, signature_verified)
values
  ('90000000-0000-4000-8000-000000000102','stripe','evt_live_refund_102','refund.created','{"livemode":true}',true),
  ('90000000-0000-4000-8000-000000000103','stripe','evt_live_dispute_103','charge.dispute.created','{"created":1787202000,"livemode":true,"data":{"object":{"id":"dp_commercial_103","balance_transactions":[{"id":"txn_dispute_withdraw_103","amount":-1500,"fee":500,"net":-2000,"currency":"usd","created":1787202000}]}}}',true),
  ('90000000-0000-4000-8000-000000000108','stripe','evt_live_dispute_108','charge.dispute.updated','{"created":1787203800,"livemode":true,"data":{"object":{"id":"dp_commercial_103","balance_transactions":[{"id":"txn_dispute_withdraw_103","amount":-1500,"fee":500,"net":-2000,"currency":"usd","created":1787202000}]}}}',true),
  ('90000000-0000-4000-8000-000000000104','stripe','evt_live_dispute_104','charge.dispute.closed','{"created":1787205600,"livemode":true,"data":{"object":{"id":"dp_commercial_103","balance_transactions":[{"id":"txn_dispute_withdraw_103","amount":-1500,"fee":500,"net":-2000,"currency":"usd","created":1787202000},{"id":"txn_dispute_recovery_104","amount":1500,"fee":0,"net":1500,"currency":"usd","created":1787205600}]}}}',true),
  ('90000000-0000-4000-8000-000000000109','stripe','evt_live_dispute_109','charge.dispute.updated','{"created":1787207400,"livemode":true,"data":{"object":{"id":"dp_commercial_103","balance_transactions":[{"id":"txn_dispute_withdraw_103","amount":-1500,"fee":500,"net":-2000,"currency":"usd","created":1787202000},{"id":"txn_dispute_recovery_104","amount":1500,"fee":0,"net":1500,"currency":"usd","created":1787205600}]}}}',true),
  ('90000000-0000-4000-8000-000000000105','stripe','evt_live_refund_105','refund.created','{"livemode":true}',true);
insert into public.refunds (
  id, transaction_id, provider_event_id, stripe_refund_id, amount_minor,
  balance_impact_minor, currency, occurred_at
) values
  ('93000000-0000-4000-8000-000000000102','91000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000102','re_commercial_102',3000,-3000,'USD','2026-08-20 04:00:00+00'),
  ('93000000-0000-4000-8000-000000000105','91000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000105','re_commercial_105',7000,-7000,'USD','2026-08-20 07:00:00+00');
insert into public.disputes (
  id, transaction_id, provider_event_id, stripe_dispute_id, status,
  disputed_minor, fee_minor, balance_impact_minor, currency, occurred_at
) values
  ('94000000-0000-4000-8000-000000000103','91000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000103','dp_commercial_103','open',1500,500,-2000,'USD','2026-08-20 05:00:00+00'),
  ('94000000-0000-4000-8000-000000000108','91000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000108','dp_commercial_103','open',1500,500,-2000,'USD','2026-08-20 05:00:00+00'),
  ('94000000-0000-4000-8000-000000000104','91000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000104','dp_commercial_103','won',1500,0,1500,'USD','2026-08-20 05:00:00+00'),
  ('94000000-0000-4000-8000-000000000109','91000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000109','dp_commercial_103','won',1500,0,1500,'USD','2026-08-20 05:00:00+00');

truncate commercial_claims;
set local role service_role;
insert into commercial_claims select * from public.claim_commercial_facts('commercial-worker', 10, 180);
select lives_ok(
  $$select public.process_commercial_fact(processing_id,claim_token) from commercial_claims order by occurred_at,processing_id$$,
  'refund and dispute lifecycle facts recalculate the same immutable rule deterministically'
);
reset role;
select is(
  (select amount_minor from public.commission_entries where source_key = 'commercial:refund:93000000-0000-4000-8000-000000000102'),
  -600::bigint,
  'a partial refund reverses only the revenue-share delta'
);
select is(
  (select amount_minor from public.commission_entries where source_key = 'commercial:dispute-balance:txn_dispute_withdraw_103'),
  -400::bigint,
  'a verified dispute withdrawal reduces commission from exact eligible money'
);
select is(
  (select amount_minor from public.commission_entries where source_key = 'commercial:dispute-balance:txn_dispute_recovery_104'),
  300::bigint,
  'a verified dispute recovery restores only the exact commission delta'
);
select is(
  (select count(*) from public.commercial_source_applications where source_kind = 'dispute' and source_id = '94000000-0000-4000-8000-000000000108'),
  0::bigint,
  'a repeated open snapshot of the same Stripe balance transaction creates no second application'
);
select is(
  (select count(*) from public.commercial_source_applications where source_kind = 'dispute' and source_id = '94000000-0000-4000-8000-000000000109'),
  0::bigint,
  'a repeated won snapshot of the same Stripe balance transactions creates no second application'
);
select is(
  (select count(*) from public.commercial_dispute_balance_evidence where stripe_dispute_id = 'dp_commercial_103'),
  2::bigint,
  'one withdrawal and one recovery are retained by global Stripe balance transaction ID'
);
select is(
  (select occurred_at from public.commercial_dispute_balance_evidence where stripe_balance_transaction_id = 'txn_dispute_recovery_104'),
  '2026-08-20 06:00:00+00'::timestamptz,
  'recovery money keeps the balance transaction created time rather than the dispute object created time'
);
select is(
  (select payout_period_id from public.commission_entries where source_key = 'commercial:dispute-balance:txn_dispute_recovery_104'),
  '80000000-0000-4000-8000-000000000104'::uuid,
  'a recovery posts to the open period containing its own balance transaction time'
);
select is(
  (select amount_minor from public.commission_entries where source_key = 'commercial:refund:93000000-0000-4000-8000-000000000105'),
  -1100::bigint,
  'the final refund reaches zero without over-reversing the original commission'
);
select is(
  (select current_commission_minor from public.commercial_transaction_states where transaction_id = '91000000-0000-4000-8000-000000000101'),
  0::bigint,
  'cumulative refund and dispute deltas never leave a negative commission balance'
);

delete from public.commercial_metric_refresh_queue where metric_date <> '2026-08-20';
create temporary table metric_claims (
  refresh_id uuid, affiliate_id uuid, product_id uuid, metric_date date,
  claim_token uuid, attempt_count integer
);
grant all on metric_claims to service_role;
set local role service_role;
insert into metric_claims select * from public.claim_commercial_metric_refreshes('metrics-worker', 1, 180);
select lives_ok(
  $$select public.process_commercial_metric_refresh((select refresh_id from metric_claims limit 1),(select claim_token from metric_claims limit 1))$$,
  'the metrics worker derives a partner/link/day row from canonical facts'
);
reset role;
select is(
  (select earnings_minor from public.affiliate_daily_metrics where affiliate_link_id = '60000000-0000-4000-8000-000000000101' and metric_date = '2026-08-20'),
  0::bigint,
  'daily earnings equal the exact net of commission and reversal applications'
);
select is(
  (select completeness from public.affiliate_daily_metrics where affiliate_link_id = '60000000-0000-4000-8000-000000000101' and metric_date = '2026-08-20'),
  'partial'::public.metric_completeness,
  'missing Singular install evidence is explicit instead of reported as complete zero data'
);
select is(
  (select disputes from public.affiliate_daily_metrics where affiliate_link_id = '60000000-0000-4000-8000-000000000101' and metric_date = '2026-08-20'),
  1::bigint,
  'the dispute KPI counts the created dispute once, not every lifecycle snapshot'
);
select public.queue_commercial_metric(
  '30000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101',
  '2026-08-20 08:00:00+00'
);
truncate metric_claims;
set local role service_role;
insert into metric_claims select * from public.claim_commercial_metric_refreshes('metrics-worker', 1, 180);
select lives_ok(
  $$select public.process_commercial_metric_refresh((select refresh_id from metric_claims limit 1),(select claim_token from metric_claims limit 1))$$,
  'the same metric date can be recomputed idempotently'
);
reset role;
select is(
  (select count(*) from public.affiliate_daily_metrics where affiliate_link_id = '60000000-0000-4000-8000-000000000101' and metric_date = '2026-08-20'),
  1::bigint,
  'metric refresh replaces rather than duplicates a dimensional row'
);

-- A second transaction proves that an adjustment arriving before its commission
-- is safely retried, not silently dropped or applied to an inferred rule.
insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at
)
values (
  '80000000-0000-4000-8000-000000000102','2026-08-18','2026-08-19',
  '2026-08-19','2026-08-20'
);
update public.payout_periods set status = 'review'
where id = '80000000-0000-4000-8000-000000000102';
update public.payout_periods set status = 'closed', closed_at = now()
where id = '80000000-0000-4000-8000-000000000102';
insert into public.clicks (
  id, public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id,
  destination_url_snapshot, is_bot, occurred_at
) values (
  '61000000-0000-4000-8000-000000000102','commercialclick102',
  '60000000-0000-4000-8000-000000000101','30000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101','50000000-0000-4000-8000-000000000101',
  'https://product.kissmyapps.dev/start',false,'2026-08-18 01:00:00+00'
);
insert into public.acquisitions (
  id, product_id, affiliate_id, click_record_id, account_id, funnel_id,
  attribution_method, status, resolved_at, created_at
) values (
  '62000000-0000-4000-8000-000000000102','20000000-0000-4000-8000-000000000101',
  '30000000-0000-4000-8000-000000000101','61000000-0000-4000-8000-000000000102',
  '70000000-0000-4000-8000-000000000101','50000000-0000-4000-8000-000000000101',
  'deterministic_web','resolved','2026-08-18 01:01:00+00','2026-08-18 01:00:00+00'
);
insert into public.provider_events (id,provider,provider_event_id,event_type,payload,signature_verified) values
  ('90000000-0000-4000-8000-000000000106','stripe','evt_live_commercial_106','invoice.paid','{"livemode":true}',true),
  ('90000000-0000-4000-8000-000000000107','stripe','evt_live_refund_107','refund.created','{"livemode":true}',true);
insert into public.subscriptions (
  id,account_id,product_id,acquisition_id,stripe_customer_id,stripe_subscription_id,status,currency
) values (
  '71000000-0000-4000-8000-000000000102','70000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000101','62000000-0000-4000-8000-000000000102',
  'cus_commercial_102','sub_commercial_102','active','USD'
);
insert into public.events (
  id,source,source_event_id,event_name,product_id,affiliate_id,acquisition_id,
  account_id,funnel_id,provider_event_id,properties,occurred_at,trust,commercial_eligible
) values (
  '92000000-0000-4000-8000-000000000106','stripe','invoice:commercial-106:paid','purchase.completed',
  '20000000-0000-4000-8000-000000000101','30000000-0000-4000-8000-000000000101',
  '62000000-0000-4000-8000-000000000102','70000000-0000-4000-8000-000000000101',
  '50000000-0000-4000-8000-000000000101','90000000-0000-4000-8000-000000000106',
  '{"transaction_id":"91000000-0000-4000-8000-000000000106"}',
  '2026-08-18 02:00:00+00','provider',true
);
insert into public.transactions (
  id,subscription_id,acquisition_id,provider_event_id,stripe_invoice_id,balance_transaction_id,
  kind,gross_minor,fee_minor,tax_minor,eligible_net_minor,currency,settled_currency,occurred_at
) values (
  '91000000-0000-4000-8000-000000000106','71000000-0000-4000-8000-000000000102',
  '62000000-0000-4000-8000-000000000102','90000000-0000-4000-8000-000000000106',
  'in_commercial_106','txn_commercial_106','renewal',1000,0,0,1000,'USD','USD','2026-08-18 02:00:00+00'
);
insert into public.refunds (
  id,transaction_id,provider_event_id,stripe_refund_id,amount_minor,balance_impact_minor,currency,occurred_at
) values (
  '93000000-0000-4000-8000-000000000107','91000000-0000-4000-8000-000000000106',
  '90000000-0000-4000-8000-000000000107','re_commercial_107',1000,-1000,'USD','2026-08-18 03:00:00+00'
);
update public.commercial_fact_processing set status = 'failed', processing_error = 'test_deferred'
where source_kind = 'transaction' and source_id = '91000000-0000-4000-8000-000000000106';
truncate commercial_claims;
set local role service_role;
insert into commercial_claims select * from public.claim_commercial_facts('commercial-worker',1,180);
select throws_ok(
  $$select public.process_commercial_fact((select processing_id from commercial_claims limit 1),(select claim_token from commercial_claims limit 1))$$,
  'P0002', 'commercial adjustment is waiting for its transaction commission',
  'an out-of-order refund fails closed until its transaction commission exists'
);
select is(
  public.fail_commercial_fact((select processing_id from commercial_claims limit 1),(select claim_token from commercial_claims limit 1),'transaction_commission_pending',0,false),
  'pending'::public.processing_status,
  'the out-of-order adjustment is retained for retry'
);
reset role;
update public.commercial_fact_processing set status = 'pending', processing_error = null, next_attempt_at = now()
where source_kind = 'transaction' and source_id = '91000000-0000-4000-8000-000000000106';
truncate commercial_claims;
set local role service_role;
insert into commercial_claims select * from public.claim_commercial_facts('commercial-worker',1,180);
select lives_ok(
  $$select public.process_commercial_fact((select processing_id from commercial_claims limit 1),(select claim_token from commercial_claims limit 1))$$,
  'the prerequisite transaction can process after the dependency recovers'
);
truncate commercial_claims;
insert into commercial_claims select * from public.claim_commercial_facts('commercial-worker',1,180);
select lives_ok(
  $$select public.process_commercial_fact((select processing_id from commercial_claims limit 1),(select claim_token from commercial_claims limit 1))$$,
  'the retained refund then applies exactly once'
);
reset role;
select is(
  (select payout_period_id from public.commission_entries where source_key = 'commercial:transaction:91000000-0000-4000-8000-000000000106'),
  '80000000-0000-4000-8000-000000000103'::uuid,
  'a delayed transaction never mutates its closed historical period and posts to the current open period'
);
select is(
  (select payout_period_id from public.commission_entries where source_key = 'commercial:refund:93000000-0000-4000-8000-000000000107'),
  '80000000-0000-4000-8000-000000000103'::uuid,
  'a delayed adjustment also posts append-only to the current open period'
);

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000101',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated","amr":[{"method":"password","timestamp":1787952000}]}',true);
select is(
  public.advance_admin_payout_period('{"payout_period_id":"80000000-0000-4000-8000-000000000101","status":"review"}'::jsonb) ->> 'status',
  'review',
  'a fully processed ended period can enter review'
);
select throws_ok(
  $$select public.advance_admin_payout_period('{"payout_period_id":"80000000-0000-4000-8000-000000000101","status":"closed"}'::jsonb)$$,
  'P0001', 'payout period requires passed exact-window reconciliation for every currency',
  'the period cannot close before exact provider reconciliation passes'
);
reset role;

create temporary table reconciliation_context (run_id uuid, claim_token uuid);
grant all on reconciliation_context to service_role;
set local role service_role;
insert into reconciliation_context (run_id)
select (public.queue_commercial_reconciliation(
  '{"starts_at":"2026-08-20T00:00:00Z","ends_at":"2026-08-20T06:00:00Z","currency":"USD","idempotency_key":"commercial-period-101"}'::jsonb
) ->> 'reconciliation_run_id')::uuid;
select is(
  (select count(*) from public.claim_commercial_reconciliations('reconciliation-worker',1,180)),
  0::bigint,
  'a reconciliation without independent provider evidence is not claimable'
);
select ok(
  public.record_commercial_reconciliation_evidence(jsonb_build_object(
    'reconciliation_run_id',(select run_id from reconciliation_context),
    'provider_total_minor',4000,
    'evidence_sha256',repeat('a',64)
  )) ->> 'evidence_sha256' = repeat('a',64),
  'an immutable digest accompanies the independently supplied provider total'
);
update reconciliation_context as context set claim_token = claim.claim_token
from public.claim_commercial_reconciliations('reconciliation-worker',1,180) as claim
where context.run_id = claim.reconciliation_run_id;
select is(
  public.process_commercial_reconciliation(
    (select run_id from reconciliation_context),
    (select claim_token from reconciliation_context)
  ) ->> 'status',
  'passed',
  'exact provider and canonical totals reconcile with zero unexplained difference'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000101',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated","amr":[{"method":"password","timestamp":1787952001}]}',true);
select is(
  public.advance_admin_payout_period('{"payout_period_id":"80000000-0000-4000-8000-000000000101","status":"closed"}'::jsonb) ->> 'status',
  'closed',
  'the reconciled review period can close'
);
select is(
  public.prepare_admin_payout_statements('{"payout_period_id":"80000000-0000-4000-8000-000000000101"}'::jsonb) ->> 'external_transfer',
  'false',
  'statement preparation explicitly performs no external transfer'
);
reset role;
select ok(
  (select status = 'open' and calculation_finalized_at is null and approved_at is null
    and scheduled_at is null and paid_at is null and payout_destination_id is null
    from public.payouts where payout_period_id = '80000000-0000-4000-8000-000000000101'),
  'prepared statements remain open, unfinalized, unapproved, unscheduled, and unpaid'
);
select is(
  (select final_payout_minor from public.payouts where payout_period_id = '80000000-0000-4000-8000-000000000101'),
  800::bigint,
  'the statement contains only the commission and reversals economically posted in that closed period'
);

select * from finish();
rollback;
