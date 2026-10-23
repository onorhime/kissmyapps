begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('10000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'money-partner@example.test', '', now(), '{}', '{"full_name":"Money Partner"}', now(), now()),
  ('10000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'finance-admin@example.test', '', now(), '{}', '{"full_name":"Finance Admin"}', now(), now()),
  ('10000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'support-admin@example.test', '', now(), '{}', '{"full_name":"Support Admin"}', now(), now()),
  ('10000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inactive-finance@example.test', '', now(), '{}', '{"full_name":"Inactive Finance"}', now(), now());

insert into public.products (id, slug, name, status)
values ('20000000-0000-0000-0000-000000000011', 'money-product', 'Money Product', 'active');
insert into public.affiliates (
  id, public_name, legal_name, slug, entity_type, reporting_timezone,
  preferred_currency, status
)
values (
  '30000000-0000-0000-0000-000000000011', 'Money Partner', 'Money Partner LLC',
  'money-partner', 'company', 'UTC', 'USD', 'active'
);
insert into public.affiliate_users (
  affiliate_id, user_id, role, active, activation_pending, activated_at
)
values (
  '30000000-0000-0000-0000-000000000011',
  '10000000-0000-0000-0000-000000000011',
  'owner', true, false, now()
);
insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000012', 'finance', true),
  ('10000000-0000-0000-0000-000000000013', 'support', true),
  ('10000000-0000-0000-0000-000000000014', 'finance', false);

insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  payout_frequency_days, payout_currency, minimum_payout_minor
)
values (
  '40000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  1, 'cpa', 'draft', '2026-01-01', 14, 'USD', 1000
);
select throws_ok(
  $$insert into public.agreements (id, affiliate_id, product_id, version, model, status, starts_at, payout_currency, minimum_payout_minor) values ('40000000-0000-0000-0000-000000000099', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', 99, 'cpa', 'active', '2026-01-01', 'USD', 1000)$$,
  'P0001', 'agreement versions must begin in draft or awaiting_signature',
  'an active agreement cannot bypass rule validation on direct insert'
);
insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values (
  '41000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000011',
  'Qualified purchase', 1, 'active', 'cpa', 'purchase', 2500, 'USD'
);
select throws_ok(
  $$insert into public.commission_rules (agreement_id, name, version, status, model, trigger_event, fixed_amount_minor, currency) values ('40000000-0000-0000-0000-000000000011', 'Wrong currency', 1, 'active', 'cpa', 'purchase', 2500, 'EUR')$$,
  '23514', 'fixed commission rule currency must match the agreement payout currency',
  'fixed commission rules cannot introduce implicit FX'
);
select throws_ok(
  $$update public.agreements set model = 'revenue_share', payout_currency = 'EUR', status = 'active' where id = '40000000-0000-0000-0000-000000000011'$$,
  'P0001', 'active commission rules must match the agreement model and payout currency',
  'activation cannot drift the agreement model or currency away from its rules'
);
select throws_ok(
  $$update public.agreements set version = 2, status = 'active' where id = '40000000-0000-0000-0000-000000000011'$$,
  'P0001', 'agreement version identity is immutable',
  'activation cannot rewrite agreement version identity'
);
insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values (
  '41000000-0000-0000-0000-000000000019',
  '40000000-0000-0000-0000-000000000011',
  'Renewal purchase', 1, 'active', 'cpa', 'renewal_purchase', 900, 'USD'
);
update public.agreements
set status = 'active'
where id = '40000000-0000-0000-0000-000000000011';

select throws_ok(
  $$update public.commission_rules set fixed_amount_minor = 9999 where id = '41000000-0000-0000-0000-000000000011'$$,
  'P0001', 'rules on active or historical agreements are immutable',
  'active commission rules cannot be rewritten'
);
select throws_ok(
  $$insert into public.commission_rules (agreement_id, name, status, model, trigger_event, fixed_amount_minor, currency) values ('40000000-0000-0000-0000-000000000011', 'Late rule', 'active', 'cpa', 'late_purchase', 100, 'USD')$$,
  'P0001', 'rules on active or historical agreements are immutable',
  'rules cannot be appended to an active agreement version'
);

insert into public.accounts (id, external_key)
values ('42000000-0000-0000-0000-000000000011', 'customer-external-11');
insert into public.acquisitions (
  id, product_id, affiliate_id, account_id, attribution_method, status, resolved_at, created_at
)
values (
  '43000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '42000000-0000-0000-0000-000000000011',
  'manual', 'resolved', '2026-05-05 00:01:00+00', '2026-05-05 00:00:00+00'
);
insert into public.accounts (id, external_key)
values ('42000000-0000-0000-0000-000000000099', 'customer-external-99');
insert into public.acquisitions (
  id, product_id, affiliate_id, account_id, attribution_method, status, created_at
)
values (
  '43000000-0000-0000-0000-000000000099',
  '20000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '42000000-0000-0000-0000-000000000011',
  'manual', 'open', '2026-05-05 00:00:00+00'
);
insert into public.subscriptions (
  id, account_id, product_id, acquisition_id, stripe_customer_id,
  stripe_subscription_id, status, currency
)
values (
  '47000000-0000-0000-0000-000000000099',
  '42000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '43000000-0000-0000-0000-000000000099',
  'cus_open_99', 'sub_open_99', 'active', 'USD'
);
select throws_ok(
  $$update public.acquisitions set status = 'resolved', account_id = '42000000-0000-0000-0000-000000000099', resolved_at = now() where id = '43000000-0000-0000-0000-000000000099'$$,
  '23514', 'acquisition resolution must match referencing subscriptions',
  'an open acquisition cannot resolve to a different account than its subscription'
);
select lives_ok(
  $$update public.acquisitions set status = 'resolved', resolved_at = now() where id = '43000000-0000-0000-0000-000000000099'$$,
  'an open acquisition can resolve safely when every downstream account remains coherent'
);
insert into public.acquisitions (
  id, product_id, affiliate_id, account_id, attribution_method, status,
  rejection_reason, created_at
)
values (
  '43000000-0000-0000-0000-000000000098',
  '20000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '42000000-0000-0000-0000-000000000011',
  'manual', 'rejected', 'fraud', '2026-05-05 00:00:00+00'
);
select throws_ok(
  $$insert into public.subscriptions (id, account_id, product_id, acquisition_id, stripe_customer_id, stripe_subscription_id, status, currency) values ('47000000-0000-0000-0000-000000000098', '42000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000098', 'cus_rejected_98', 'sub_rejected_98', 'active', 'USD')$$,
  '23514', 'subscription acquisition must match its account and product',
  'a rejected acquisition cannot gain a subscription while resolution writes race'
);
-- Synthetic trusted-server evidence is explicitly eligible. Browser events
-- remain noncommercial and cannot exercise the downstream money invariants.
insert into public.events (
  id, source, source_event_id, schema_version, event_name, product_id,
  affiliate_id, acquisition_id, account_id, occurred_at, trust, commercial_eligible
)
values (
  '44000000-0000-0000-0000-000000000011', 'first_party', 'purchase:11', 1,
  'purchase', '20000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '43000000-0000-0000-0000-000000000011',
  '42000000-0000-0000-0000-000000000011', '2026-05-10 00:00:00+00', 'funnel_server', true
);

insert into public.provider_events (
  id, provider, provider_event_id, event_type, schema_version, payload, signature_verified
)
values
  ('46000000-0000-0000-0000-000000000011', 'stripe', 'evt_test_11', 'invoice.paid', 1, '{"id":"evt_test_11","livemode":true}', true),
  ('46000000-0000-0000-0000-000000000012', 'stripe', 'evt_refund_11', 'charge.refunded', 1, '{"id":"evt_refund_11","livemode":true}', true),
  (
    '46000000-0000-0000-0000-000000000013', 'stripe', 'evt_dispute_11',
    'charge.dispute.created', 1,
    '{"id":"evt_dispute_11","created":1778371200,"livemode":true,"data":{"object":{"id":"dp_test_11","object":"dispute","balance_transactions":[{"id":"txn_dispute_test_11","amount":-1000,"fee":0,"net":-1000,"currency":"usd","created":1778371200}]}}}',
    true
  ),
  ('46000000-0000-0000-0000-000000000014', 'stripe', 'evt_test_12', 'invoice.paid', 1, '{"id":"evt_test_12","livemode":true}', true),
  ('46000000-0000-0000-0000-000000000015', 'stripe', 'evt_test_13', 'invoice.paid', 1, '{"id":"evt_test_13","livemode":true}', true),
  ('46000000-0000-0000-0000-000000000016', 'stripe', 'evt_test_14', 'invoice.paid', 1, '{"id":"evt_test_14","livemode":true}', true),
  ('46000000-0000-0000-0000-000000000017', 'stripe', 'evt_bad_net_11', 'invoice.paid', 1, '{"id":"evt_bad_net_11","livemode":true}', true);
insert into public.subscriptions (
  id, account_id, product_id, acquisition_id, stripe_customer_id,
  stripe_subscription_id, status, currency
)
values (
  '47000000-0000-0000-0000-000000000011',
  '42000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '43000000-0000-0000-0000-000000000011',
  'cus_test_11', 'sub_test_11', 'active', 'USD'
);
insert into public.transactions (
  id, subscription_id, acquisition_id, provider_event_id, stripe_invoice_id,
  kind, gross_minor, fee_minor, tax_minor, eligible_net_minor,
  currency, settled_currency, occurred_at
)
values (
  '48000000-0000-0000-0000-000000000011',
  '47000000-0000-0000-0000-000000000011',
  '43000000-0000-0000-0000-000000000011',
  '46000000-0000-0000-0000-000000000011',
  'in_test_11', 'first_purchase', 10000, 500, 0, 9500, 'USD', 'USD', '2026-05-10 00:00:00+00'
);
select throws_ok(
  $$insert into public.transactions (subscription_id, acquisition_id, provider_event_id, stripe_invoice_id, kind, gross_minor, fee_minor, tax_minor, eligible_net_minor, currency, settled_currency, occurred_at) values ('47000000-0000-0000-0000-000000000011', null, '46000000-0000-0000-0000-000000000011', 'in_mismatched_acquisition', 'first_purchase', 10000, 500, 0, 9500, 'USD', 'USD', '2026-05-10 00:00:00+00')$$,
  '23514', 'noncommercial tracking cannot create transactions',
  'canonical transactions cannot detach from the subscription acquisition'
);
select throws_ok(
  $$insert into public.transactions (subscription_id, acquisition_id, provider_event_id, stripe_invoice_id, kind, gross_minor, fee_minor, tax_minor, eligible_net_minor, currency, settled_currency, occurred_at) values ('47000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000011', '46000000-0000-0000-0000-000000000017', 'in_bad_net_11', 'first_purchase', 10000, 500, 0, 9999, 'USD', 'USD', '2026-05-10 00:00:00+00')$$,
  '23514', 'transaction eligible net must equal gross less fees and tax plus settlement adjustment',
  'canonical transaction net revenue cannot be caller-chosen'
);
insert into public.refunds (
  id, transaction_id, provider_event_id, stripe_refund_id, amount_minor,
  balance_impact_minor, currency, occurred_at
)
values (
  '49000000-0000-0000-0000-000000000011',
  '48000000-0000-0000-0000-000000000011',
  '46000000-0000-0000-0000-000000000012',
  're_test_11', 1000, -1000, 'USD', now()
);
select throws_ok(
  $$insert into public.refunds (transaction_id, provider_event_id, stripe_refund_id, amount_minor, balance_impact_minor, currency, occurred_at) values ('48000000-0000-0000-0000-000000000011', '46000000-0000-0000-0000-000000000011', 're_bad_event_11', 100, -100, 'USD', now())$$,
  '23514', 'refund requires a signature-verified Stripe refund event',
  'an invoice event cannot be reused as canonical refund evidence'
);
insert into public.disputes (
  id, transaction_id, provider_event_id, stripe_dispute_id, status,
  disputed_minor, fee_minor, balance_impact_minor, currency, occurred_at
)
values (
  '4a000000-0000-0000-0000-000000000011',
  '48000000-0000-0000-0000-000000000011',
  '46000000-0000-0000-0000-000000000013',
  'dp_test_11', 'open', 1000, 0, -1000, 'USD', now()
);
select throws_ok(
  $$insert into public.disputes (transaction_id, provider_event_id, stripe_dispute_id, status, disputed_minor, fee_minor, balance_impact_minor, currency, occurred_at) values ('48000000-0000-0000-0000-000000000011', '46000000-0000-0000-0000-000000000011', 'dp_bad_event_11', 'open', 100, 0, -100, 'USD', now())$$,
  '23514', 'dispute requires a signature-verified Stripe dispute event',
  'a payment event cannot be reused as canonical dispute evidence'
);

insert into public.conversions (
  id, acquisition_id, affiliate_id, product_id, agreement_id,
  commission_rule_id, event_id, event_name, account_id, transaction_id,
  qualified, occurred_at
)
select
  '45000000-0000-0000-0000-000000000011',
  '43000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000011',
  '41000000-0000-0000-0000-000000000011',
  event.id, event.event_name, event.account_id,
  '48000000-0000-0000-0000-000000000011', true, event.occurred_at
from public.events as event
where event.id = '44000000-0000-0000-0000-000000000011';

insert into public.events (
  id, source, source_event_id, event_name, product_id, affiliate_id,
  acquisition_id, account_id, occurred_at, trust, commercial_eligible
) values (
  '44000000-0000-0000-0000-000000000097', 'first_party', 'browser-purchase:11',
  'purchase', '20000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000011',
  '42000000-0000-0000-0000-000000000011', '2026-05-10 00:00:00+00', 'browser', false
);
select throws_ok(
  $$insert into public.conversions (acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, transaction_id, qualified, occurred_at) select '43000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', event.id, event.event_name, event.account_id, '48000000-0000-0000-0000-000000000011', true, event.occurred_at from public.events as event where event.id = '44000000-0000-0000-0000-000000000097'$$,
  '23514', 'conversions require commercially eligible attribution and events',
  'browser evidence cannot qualify a conversion even beside a real canonical transaction'
);

select throws_ok(
  $$update public.subscriptions set acquisition_id = null where id = '47000000-0000-0000-0000-000000000011'$$,
  'P0001', 'subscription identity and billing currency are immutable',
  'subscription identity cannot be changed after a conversion validates it'
);
insert into public.entitlements (
  id, account_id, product_id, subscription_id, status, starts_at, source
)
values (
  '48500000-0000-0000-0000-000000000011',
  '42000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '47000000-0000-0000-0000-000000000011', 'active', now(), 'stripe'
);
select throws_ok(
  $$update public.entitlements set subscription_id = null where id = '48500000-0000-0000-0000-000000000011'$$,
  'P0001', 'entitlement identity is immutable',
  'entitlement identity cannot detach from its validated subscription'
);

select throws_ok(
  $$insert into public.conversions (acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, transaction_id, qualified, occurred_at) select '43000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', event.id, event.event_name, event.account_id, '48000000-0000-0000-0000-000000000011', true, event.occurred_at from public.events as event where event.id = '44000000-0000-0000-0000-000000000011'$$,
  '23505', 'duplicate key value violates unique constraint "conversions_transaction_dedupe"',
  'transaction conversions are idempotent'
);
select throws_ok(
  $$insert into public.conversions (acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, qualified, occurred_at) select '43000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', event.id, event.event_name, event.account_id, true, event.occurred_at from public.events as event where event.id = '44000000-0000-0000-0000-000000000011'$$,
  '23514', 'CPA, revenue-share, and hybrid conversions require a canonical transaction',
  'CPA conversions cannot qualify without a transaction'
);

insert into public.events (
  id, source, source_event_id, schema_version, event_name, product_id,
  affiliate_id, acquisition_id, account_id, occurred_at, trust, commercial_eligible
)
values (
  '44000000-0000-0000-0000-000000000012', 'first_party', 'signup:11', 1,
  'signup', '20000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '43000000-0000-0000-0000-000000000011',
  '42000000-0000-0000-0000-000000000011', '2026-05-10 00:01:00+00', 'funnel_server', true
);
select throws_ok(
  $$insert into public.conversions (acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, transaction_id, qualified, occurred_at) select '43000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', event.id, event.event_name, event.account_id, '48000000-0000-0000-0000-000000000011', true, event.occurred_at from public.events as event where event.id = '44000000-0000-0000-0000-000000000012'$$,
  '23514', 'conversion requires a resolved acquisition and the exact qualifying trigger event',
  'non-trigger events cannot qualify a commission'
);

insert into public.accounts (id, external_key)
values
  ('42000000-0000-0000-0000-000000000012', 'customer-external-12'),
  ('42000000-0000-0000-0000-000000000013', 'customer-external-13'),
  ('42000000-0000-0000-0000-000000000014', 'customer-external-14');
insert into public.acquisitions (
  id, product_id, affiliate_id, account_id, attribution_method, status, resolved_at, created_at
)
values
  ('43000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '42000000-0000-0000-0000-000000000012', 'manual', 'resolved', '2026-05-05 00:01:00+00', '2026-05-05 00:00:00+00'),
  ('43000000-0000-0000-0000-000000000013', '20000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '42000000-0000-0000-0000-000000000013', 'manual', 'resolved', '2026-03-01 00:01:00+00', '2026-03-01 00:00:00+00'),
  ('43000000-0000-0000-0000-000000000014', '20000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '42000000-0000-0000-0000-000000000014', 'manual', 'resolved', '2026-05-05 00:01:00+00', '2026-05-05 00:00:00+00');
insert into public.events (
  id, source, source_event_id, schema_version, event_name, product_id,
  affiliate_id, acquisition_id, account_id, occurred_at, trust, commercial_eligible
)
values
  ('44000000-0000-0000-0000-000000000022', 'first_party', 'purchase:12', 1, 'purchase', '20000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000012', '42000000-0000-0000-0000-000000000012', '2026-05-10 00:00:00+00', 'funnel_server', true),
  ('44000000-0000-0000-0000-000000000013', 'first_party', 'purchase:13', 1, 'purchase', '20000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000013', '42000000-0000-0000-0000-000000000013', '2026-05-10 00:00:00+00', 'funnel_server', true),
  ('44000000-0000-0000-0000-000000000014', 'first_party', 'purchase:14', 1, 'purchase', '20000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000014', '42000000-0000-0000-0000-000000000014', '2026-05-10 00:00:00+00', 'funnel_server', true);
insert into public.subscriptions (
  id, account_id, product_id, acquisition_id, stripe_customer_id,
  stripe_subscription_id, status, currency
)
values
  ('47000000-0000-0000-0000-000000000012', '42000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000012', 'cus_test_12', 'sub_test_12', 'active', 'USD'),
  ('47000000-0000-0000-0000-000000000013', '42000000-0000-0000-0000-000000000013', '20000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000013', 'cus_test_13', 'sub_test_13', 'active', 'USD'),
  ('47000000-0000-0000-0000-000000000014', '42000000-0000-0000-0000-000000000014', '20000000-0000-0000-0000-000000000011', '43000000-0000-0000-0000-000000000014', 'cus_test_14', 'sub_test_14', 'active', 'USD');
insert into public.transactions (
  id, subscription_id, acquisition_id, provider_event_id, stripe_invoice_id,
  kind, gross_minor, fee_minor, tax_minor, eligible_net_minor,
  currency, settled_currency, occurred_at
)
values
  ('48000000-0000-0000-0000-000000000012', '47000000-0000-0000-0000-000000000012', '43000000-0000-0000-0000-000000000012', '46000000-0000-0000-0000-000000000014', 'in_test_12', 'first_purchase', 10000, 500, 0, 9500, 'USD', 'USD', '2026-05-10 00:00:00+00'),
  ('48000000-0000-0000-0000-000000000013', '47000000-0000-0000-0000-000000000013', '43000000-0000-0000-0000-000000000013', '46000000-0000-0000-0000-000000000015', 'in_test_13', 'first_purchase', 10000, 500, 0, 9500, 'USD', 'USD', '2026-05-10 00:00:00+00'),
  ('48000000-0000-0000-0000-000000000014', '47000000-0000-0000-0000-000000000014', '43000000-0000-0000-0000-000000000014', '46000000-0000-0000-0000-000000000016', 'in_test_14', 'first_purchase', 10000, 500, 0, 9500, 'USD', 'USD', '2026-05-10 00:00:00+00');

select throws_ok(
  $$insert into public.conversions (acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, transaction_id, qualified, occurred_at) select '43000000-0000-0000-0000-000000000013', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', event.id, event.event_name, event.account_id, '48000000-0000-0000-0000-000000000013', true, event.occurred_at from public.events as event where event.id = '44000000-0000-0000-0000-000000000013'$$,
  '23514', 'conversion is outside its agreement attribution window',
  'events outside the versioned attribution window cannot qualify'
);
select throws_ok(
  $$insert into public.conversions (acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, transaction_id, qualified, occurred_at) select '43000000-0000-0000-0000-000000000014', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', event.id, event.event_name, event.account_id, '48000000-0000-0000-0000-000000000011', true, event.occurred_at from public.events as event where event.id = '44000000-0000-0000-0000-000000000014'$$,
  '23514', 'conversion transaction and subscription must match acquisition, account, product, and payout currency',
  'a transaction from another acquisition cannot qualify a conversion'
);

insert into public.conversions (
  id, acquisition_id, affiliate_id, product_id, agreement_id,
  commission_rule_id, event_id, event_name, account_id, transaction_id,
  qualified, rejection_reason, occurred_at
)
select
  '45000000-0000-0000-0000-000000000012',
  '43000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000011',
  '41000000-0000-0000-0000-000000000011',
  event.id, event.event_name, event.account_id,
  '48000000-0000-0000-0000-000000000012', false, 'fraud review rejected', event.occurred_at
from public.events as event
where event.id = '44000000-0000-0000-0000-000000000022';

update public.agreements
set status = 'superseded', ends_at = '2026-05-12 00:00:00+00'
where id = '40000000-0000-0000-0000-000000000011';
select lives_ok(
  $$insert into public.conversions (id, acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, transaction_id, qualified, occurred_at) select '45000000-0000-0000-0000-000000000014', '43000000-0000-0000-0000-000000000014', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', event.id, event.event_name, event.account_id, '48000000-0000-0000-0000-000000000014', true, event.occurred_at from public.events as event where event.id = '44000000-0000-0000-0000-000000000014'$$,
  'an out-of-order worker can qualify an event against its effective immutable historical agreement version'
);
select throws_ok(
  $$update public.acquisitions set account_id = null where id = '43000000-0000-0000-0000-000000000011'$$,
  'P0001', 'invalid acquisition status transition: resolved -> resolved',
  'resolved acquisition identity cannot be rewritten after conversion'
);
select throws_ok(
  $$update public.events set properties = '{"tampered":true}' where id = '44000000-0000-0000-0000-000000000011'$$,
  'P0001', 'tracking history is append-only outside an approved non-commercial product deletion',
  'canonical events are append-only'
);
select throws_ok(
  $$update public.conversions set qualified = false where id = '45000000-0000-0000-0000-000000000011'$$,
  'P0001', 'conversions is append-only',
  'conversion decisions are append-only'
);

select throws_ok(
  $$update public.provider_events set payload = '{}' where id = '46000000-0000-0000-0000-000000000011'$$,
  'P0001', 'provider_events is append-only',
  'raw provider callbacks are immutable'
);
select throws_ok(
  $$update public.transactions set eligible_net_minor = 1 where id = '48000000-0000-0000-0000-000000000011'$$,
  'P0001', 'transactions is append-only',
  'settled transactions are immutable'
);
select throws_ok(
  $$update public.refunds set amount_minor = 1 where id = '49000000-0000-0000-0000-000000000011'$$,
  'P0001', 'refunds is append-only',
  'refund facts are immutable'
);
select throws_ok(
  $$update public.disputes set status = 'won' where id = '4a000000-0000-0000-0000-000000000011'$$,
  'P0001', 'disputes is append-only',
  'dispute facts are immutable and later states require new facts'
);

insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at
)
values (
  '50000000-0000-0000-0000-000000000011',
  '2026-05-01', '2026-05-15', '2026-05-15', '2026-05-21'
);
insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at
)
values (
  '50000000-0000-0000-0000-000000000099',
  clock_timestamp(), clock_timestamp() + interval '2 days',
  clock_timestamp() + interval '2 days', clock_timestamp() + interval '8 days'
);
select throws_ok(
  $$update public.payout_periods set status = 'review' where id = '50000000-0000-0000-0000-000000000099'$$,
  'P0001', 'payout period cannot enter review before review_starts_at',
  'a future payout period cannot be reviewed or finalized prematurely'
);
select throws_ok(
  $$insert into public.commission_entries (affiliate_id, product_id, agreement_id, commission_rule_id, conversion_id, transaction_id, payout_period_id, entry_type, amount_minor, currency, source_key, partner_visible_description) values ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', '45000000-0000-0000-0000-000000000012', '48000000-0000-0000-0000-000000000012', '50000000-0000-0000-0000-000000000011', 'commission', 2500, 'USD', 'commission:unqualified', 'Rejected conversion')$$,
  '23514', 'commission entry requires a qualified conversion with matching identity',
  'an unqualified conversion can never enter the commission ledger'
);
select throws_ok(
  $$insert into public.commission_entries (affiliate_id, product_id, agreement_id, commission_rule_id, conversion_id, transaction_id, payout_period_id, entry_type, amount_minor, currency, source_key, partner_visible_description) values ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000019', '45000000-0000-0000-0000-000000000011', '48000000-0000-0000-0000-000000000011', '50000000-0000-0000-0000-000000000011', 'commission', 900, 'USD', 'commission:wrong-rule', 'Wrong rule')$$,
  '23514', 'commission entry requires a qualified conversion with matching identity',
  'a conversion cannot be ledgered under another rule from the same agreement'
);
select throws_ok(
  $$insert into public.commission_entries (affiliate_id, product_id, agreement_id, commission_rule_id, conversion_id, transaction_id, payout_period_id, entry_type, amount_minor, currency, source_key, partner_visible_description) values ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', '45000000-0000-0000-0000-000000000011', '48000000-0000-0000-0000-000000000011', '50000000-0000-0000-0000-000000000011', 'commission', 2501, 'USD', 'commission:wrong-amount', 'Wrong amount')$$,
  '23514', 'commission amount must exactly match its immutable rule and transaction basis',
  'commission earnings are derived from frozen rules rather than caller input'
);
insert into public.commission_entries (
  id, affiliate_id, product_id, agreement_id, commission_rule_id,
  conversion_id, transaction_id, payout_period_id, entry_type, amount_minor, currency,
  source_key, partner_visible_description
)
values (
  '51000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000011',
  '41000000-0000-0000-0000-000000000011',
  '45000000-0000-0000-0000-000000000011',
  '48000000-0000-0000-0000-000000000011',
  '50000000-0000-0000-0000-000000000011',
  'commission', 2500, 'USD', 'commission:11', 'Qualified purchase'
);
select throws_ok(
  $$insert into public.commission_entries (affiliate_id, product_id, agreement_id, commission_rule_id, conversion_id, transaction_id, payout_period_id, entry_type, amount_minor, currency, source_key, partner_visible_description) values ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000011', '45000000-0000-0000-0000-000000000011', '48000000-0000-0000-0000-000000000011', '50000000-0000-0000-0000-000000000011', 'commission', 2500, 'USD', 'commission:11-duplicate', 'Duplicated commission')$$,
  '23505', 'duplicate key value violates unique constraint "commission_entries_one_commission_per_conversion"',
  'one qualified conversion can create exactly one earning commission entry'
);
set constraints payouts_require_agreement_snapshot immediate;
select throws_ok(
  $$insert into public.payouts (id, affiliate_id, product_id, payout_period_id, eligible_net_minor, earnings_minor, final_payout_minor, currency) values ('52000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '50000000-0000-0000-0000-000000000011', 9500, 2500, 2500, 'USD')$$,
  '23514', 'every payout must have an agreement snapshot before commit',
  'an otherwise-valid payout cannot exist without an immutable agreement snapshot'
);
set constraints payouts_require_agreement_snapshot deferred;
insert into public.payouts (
  id, affiliate_id, product_id, payout_period_id, eligible_net_minor, earnings_minor,
  final_payout_minor, currency
)
values (
  '52000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '50000000-0000-0000-0000-000000000011', 9500, 2500, 2500, 'USD'
);
insert into public.payout_agreement_snapshots (
  payout_id, agreement_id, agreement_version, model, attribution_window_days,
  payout_frequency_days, payout_currency, minimum_payout_minor, rules_snapshot
)
select
  '52000000-0000-0000-0000-000000000011', agreement.id, agreement.version,
  agreement.model, agreement.attribution_window_days, agreement.payout_frequency_days,
  agreement.payout_currency, agreement.minimum_payout_minor,
  jsonb_agg(
    jsonb_build_object(
      'name', rule.name, 'version', rule.version, 'status', rule.status,
      'model', rule.model, 'trigger_event', rule.trigger_event,
      'fixed_amount_minor', rule.fixed_amount_minor,
      'rate_basis_points', rule.rate_basis_points, 'currency', rule.currency,
      'validation_window_hours', rule.validation_window_hours
    ) order by rule.name, rule.version
  )
from public.agreements as agreement
join public.commission_rules as rule on rule.agreement_id = agreement.id
where agreement.id = '40000000-0000-0000-0000-000000000011'
group by agreement.id;

select throws_ok(
  $$insert into public.payouts (id, affiliate_id, product_id, payout_period_id, earnings_minor, final_payout_minor, currency, reviewed_at, reviewed_by, approved_at, approved_by, payment_reference, paid_at) values ('52000000-0000-0000-0000-000000000099', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '50000000-0000-0000-0000-000000000011', 2500, 2500, 'USD', now(), '10000000-0000-0000-0000-000000000012', now(), '10000000-0000-0000-0000-000000000012', 'forged', now())$$,
  'P0001', 'open payouts cannot prefill future workflow or settlement evidence',
  'future review, approval, and settlement evidence cannot be forged on payout creation'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000011', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000011","role":"authenticated","email":"money-partner@example.test"}', true);
select is(
  (select status from public.get_partner_payout_detail('52000000-0000-0000-0000-000000000011')),
  'open'::public.payout_status,
  'a snapshot-backed open payout has contract-valid detail'
);
select is(
  (select minimum_payout_minor from public.get_partner_payout_detail('52000000-0000-0000-0000-000000000011')),
  1000::bigint,
  'open payout detail derives required commercial terms from its immutable snapshot'
);
reset role;

insert into public.payout_destinations (
  id, affiliate_id, version, method, display_label, currency, country_code,
  provider_reference, status, reauthenticated_at, email_confirmed_at,
  hold_until, created_by, created_at
)
values (
  '53000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011', 1, 'bank', 'Bank ending 4242',
  'USD', 'US', 'provider-bank-11', 'draft', now() - interval '4 days 5 minutes',
  now() - interval '4 days 1 hour', now() - interval '2 days',
  '10000000-0000-0000-0000-000000000012', now() - interval '4 days'
);
update public.payout_destinations
set status = 'verification_pending'
where id = '53000000-0000-0000-0000-000000000011';
update public.payout_destinations
set status = 'pending_hold', verification_status = 'passed', verified_at = now() - interval '3 days'
where id = '53000000-0000-0000-0000-000000000011';
update public.payout_destinations
set status = 'active', effective_at = hold_until
where id = '53000000-0000-0000-0000-000000000011';

select is(
  (select count(*) from public.payout_destination_events where payout_destination_id = '53000000-0000-0000-0000-000000000011'),
  4::bigint,
  'each payout destination lifecycle state is recorded'
);

insert into public.payout_destinations (
  id, affiliate_id, version, method, display_label, currency, country_code,
  provider_reference, status, reauthenticated_at, email_confirmed_at,
  hold_until, created_by, created_at
)
values (
  '53000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000011', 2, 'bank', 'Bank ending 9898',
  'USD', 'US', 'provider-bank-12', 'draft', now() - interval '4 days 5 minutes',
  now() - interval '4 days 1 hour', now() - interval '2 days',
  '10000000-0000-0000-0000-000000000012', now() - interval '4 days'
);
update public.payout_destinations set status = 'verification_pending'
where id = '53000000-0000-0000-0000-000000000012';
update public.payout_destinations
set status = 'pending_hold', verification_status = 'passed', verified_at = now() - interval '3 days'
where id = '53000000-0000-0000-0000-000000000012';

update public.payouts
set status = 'on_hold', hold_reason = 'manual review'
where id = '52000000-0000-0000-0000-000000000011';
select throws_ok(
  $$update public.payouts set status = 'approved', approved_at = now(), approved_by = '10000000-0000-0000-0000-000000000012' where id = '52000000-0000-0000-0000-000000000011'$$,
  'P0001', 'invalid payout status transition: on_hold -> approved',
  'an open payout cannot use on-hold to bypass review'
);
update public.payouts set status = 'open', hold_reason = null
where id = '52000000-0000-0000-0000-000000000011';
update public.payout_periods set status = 'review'
where id = '50000000-0000-0000-0000-000000000011';
select throws_ok(
  $$update public.payouts set status = 'review', reviewed_at = now(), reviewed_by = '10000000-0000-0000-0000-000000000011' where id = '52000000-0000-0000-0000-000000000011'$$,
  '42501', 'payout reviewer must be an active owner or finance admin',
  'an ordinary authenticated partner cannot be named as payout reviewer'
);
update public.payouts
set status = 'review', reviewed_at = now(), reviewed_by = '10000000-0000-0000-0000-000000000012'
where id = '52000000-0000-0000-0000-000000000011';
update public.payout_periods set status = 'closed', closed_at = now()
where id = '50000000-0000-0000-0000-000000000011';

insert into public.reconciliation_runs (
  id, provider, starts_at, ends_at, currency, idempotency_key, scheduled_for
)
values (
  '60000000-0000-0000-0000-000000000099', 'stripe',
  clock_timestamp(), clock_timestamp() + interval '1 day', 'USD', 'stripe:future-window:USD', now()
);
update public.reconciliation_runs
set status = 'running', started_at = now()
where id = '60000000-0000-0000-0000-000000000099';
select throws_ok(
  $$update public.reconciliation_runs set status = 'passed', provider_total_minor = 0, internal_total_minor = 0, unexplained_difference_minor = 0, completed_at = now() where id = '60000000-0000-0000-0000-000000000099'$$,
  'P0001', 'reconciliation cannot pass before its window ends',
  'a future reconciliation window cannot become payout evidence prematurely'
);
update public.reconciliation_runs
set status = 'failed', completed_at = now()
where id = '60000000-0000-0000-0000-000000000099';

insert into public.reconciliation_runs (
  id, provider, starts_at, ends_at, currency, idempotency_key, scheduled_for
)
values (
  '60000000-0000-0000-0000-000000000011', 'stripe',
  '2026-05-01', '2026-05-15', 'USD', 'stripe:2026-05-01:2026-05-15:USD', now()
);
select throws_ok(
  $$insert into public.reconciliation_runs (provider, starts_at, ends_at, currency, idempotency_key, scheduled_for) values ('stripe', '2026-05-01', '2026-05-15', 'USD', 'different-key', now())$$,
  '23505', 'duplicate key value violates unique constraint "reconciliation_runs_one_live_window"',
  'a reconciliation provider window cannot have overlapping live attempts'
);
insert into public.reconciliation_exceptions (
  id, reconciliation_run_id, source_key, category, summary
)
values (
  '61000000-0000-0000-0000-000000000011',
  '60000000-0000-0000-0000-000000000011',
  'stripe-exception:11', 'missing_transaction', 'Investigate missing transaction'
);
select throws_ok(
  $$update public.reconciliation_exceptions set category = 'hidden_difference' where id = '61000000-0000-0000-0000-000000000011'$$,
  'P0001', 'reconciliation exception facts are immutable',
  'reconciliation discrepancy identity and evidence cannot be rewritten'
);
select throws_ok(
  $$delete from public.reconciliation_exceptions where id = '61000000-0000-0000-0000-000000000011'$$,
  'P0001', 'reconciliation exception facts cannot be deleted',
  'an unresolved discrepancy cannot be deleted to manufacture a passing run'
);
update public.reconciliation_runs
set status = 'running', started_at = now()
where id = '60000000-0000-0000-0000-000000000011';
select throws_ok(
  $$update public.reconciliation_runs set status = 'passed', provider_total_minor = 100, internal_total_minor = 100, unexplained_difference_minor = 0, completed_at = now() where id = '60000000-0000-0000-0000-000000000011'$$,
  'P0001', 'reconciliation exception count must match the open exception queue',
  'a reconciliation cannot hide an open exception with a caller-entered zero count'
);
update public.reconciliation_exceptions
set status = 'resolved', resolution_note = 'Matched retry',
    resolved_by = '10000000-0000-0000-0000-000000000012', resolved_at = now()
where id = '61000000-0000-0000-0000-000000000011';
select throws_ok(
  $$update public.reconciliation_runs set status = 'passed', provider_total_minor = 100, internal_total_minor = 99, unexplained_difference_minor = 1, completed_at = now() where id = '60000000-0000-0000-0000-000000000011'$$,
  '23514', null,
  'reconciliation cannot pass with an unexplained difference'
);
update public.reconciliation_runs
set status = 'passed', provider_total_minor = 100, internal_total_minor = 100,
    unexplained_difference_minor = 0, completed_at = now()
where id = '60000000-0000-0000-0000-000000000011';
select throws_ok(
  $$insert into public.reconciliation_exceptions (reconciliation_run_id, source_key, category, summary) values ('60000000-0000-0000-0000-000000000011', 'late-exception:11', 'late', 'Late exception')$$,
  'P0001', 'exceptions cannot be attached to completed reconciliation runs',
  'completed reconciliation evidence cannot be invalidated later'
);
select throws_ok(
  $$update public.reconciliation_exceptions set summary = 'Rewritten after pass' where id = '61000000-0000-0000-0000-000000000011'$$,
  'P0001', 'exceptions on completed reconciliation runs are immutable',
  'resolved exception evidence remains frozen after its run passes'
);
select throws_ok(
  $$delete from public.reconciliation_exceptions where id = '61000000-0000-0000-0000-000000000011'$$,
  'P0001', 'reconciliation exception facts cannot be deleted',
  'completed reconciliation exception evidence cannot be deleted'
);

insert into public.reconciliation_runs (
  id, provider, starts_at, ends_at, currency, idempotency_key, scheduled_for
)
values (
  '60000000-0000-0000-0000-000000000017', 'stripe',
  '2026-04-01', '2026-04-15', 'USD', 'stripe:2026-04-01:2026-04-15:USD:attempt-1', now()
);
insert into public.reconciliation_exceptions (
  id, reconciliation_run_id, source_key, category, summary
)
values (
  '61000000-0000-0000-0000-000000000017',
  '60000000-0000-0000-0000-000000000017',
  'stripe-retry-source:17', 'provider_lag', 'Provider data was incomplete'
);
update public.reconciliation_runs set status = 'running', started_at = now()
where id = '60000000-0000-0000-0000-000000000017';
update public.reconciliation_runs set status = 'failed', completed_at = now()
where id = '60000000-0000-0000-0000-000000000017';
select lives_ok(
  $$insert into public.reconciliation_runs (id, provider, starts_at, ends_at, currency, idempotency_key, scheduled_for) values ('60000000-0000-0000-0000-000000000018', 'stripe', '2026-04-01', '2026-04-15', 'USD', 'stripe:2026-04-01:2026-04-15:USD:attempt-2', now())$$,
  'a failed immutable reconciliation attempt can be retried for the exact window'
);
select lives_ok(
  $$insert into public.reconciliation_exceptions (id, reconciliation_run_id, source_key, category, summary) values ('61000000-0000-0000-0000-000000000018', '60000000-0000-0000-0000-000000000018', 'stripe-retry-source:17', 'provider_lag', 'Retry still shows the same source discrepancy')$$,
  'retry attempts can record the same provider source without rewriting prior evidence'
);
update public.reconciliation_exceptions
set status = 'resolved', resolution_note = 'Provider retry matched',
    resolved_by = '10000000-0000-0000-0000-000000000012', resolved_at = now()
where id = '61000000-0000-0000-0000-000000000018';
update public.reconciliation_runs set status = 'running', started_at = now()
where id = '60000000-0000-0000-0000-000000000018';
select lives_ok(
  $$update public.reconciliation_runs set status = 'passed', provider_total_minor = 100, internal_total_minor = 100, unexplained_difference_minor = 0, completed_at = now() where id = '60000000-0000-0000-0000-000000000018'$$,
  'a corrected retry can become the immutable passed attempt for its window'
);

select throws_ok(
  $$update public.payouts set status = 'approved', minimum_payout_minor_snapshot = 1000, payout_frequency_days_snapshot = 14, payout_destination_id = '53000000-0000-0000-0000-000000000011', payment_method_snapshot = 'bank', destination_label_snapshot = 'Bank ending 4242', destination_version_snapshot = 1, calculation_finalized_at = now(), calculation_finalized_by = '10000000-0000-0000-0000-000000000012', approved_at = now(), approved_by = '10000000-0000-0000-0000-000000000012' where id = '52000000-0000-0000-0000-000000000011'$$,
  'P0001', 'finalized payout requires a passed Stripe reconciliation',
  'payout approval cannot bypass reconciliation'
);
select throws_ok(
  $$update public.payouts set status = 'approved', eligible_net_minor = 1, reconciliation_run_id = '60000000-0000-0000-0000-000000000011', minimum_payout_minor_snapshot = 1000, payout_frequency_days_snapshot = 14, payout_destination_id = '53000000-0000-0000-0000-000000000011', payment_method_snapshot = 'bank', destination_label_snapshot = 'Bank ending 4242', destination_version_snapshot = 1, calculation_finalized_at = now(), calculation_finalized_by = '10000000-0000-0000-0000-000000000012', approved_at = now(), approved_by = '10000000-0000-0000-0000-000000000012' where id = '52000000-0000-0000-0000-000000000011'$$,
  'P0001', 'payout arithmetic does not match its immutable ledger',
  'payout eligible revenue must match the distinct canonical transaction basis'
);
select throws_ok(
  $$update public.payouts set status = 'approved', reconciliation_run_id = '60000000-0000-0000-0000-000000000011', minimum_payout_minor_snapshot = 1000, payout_frequency_days_snapshot = 14, payout_destination_id = '53000000-0000-0000-0000-000000000011', payment_method_snapshot = 'bank', destination_label_snapshot = 'Bank ending 4242', destination_version_snapshot = 1, calculation_finalized_at = now(), calculation_finalized_by = '10000000-0000-0000-0000-000000000012', approved_at = now(), approved_by = '10000000-0000-0000-0000-000000000013' where id = '52000000-0000-0000-0000-000000000011'$$,
  '42501', 'payout approver must be an active owner or finance admin',
  'support administrators cannot approve partner money'
);
select throws_ok(
  $$update public.payouts set status = 'approved', reconciliation_run_id = '60000000-0000-0000-0000-000000000011', minimum_payout_minor_snapshot = 1000, payout_frequency_days_snapshot = 14, payout_destination_id = '53000000-0000-0000-0000-000000000011', payment_method_snapshot = 'bank', destination_label_snapshot = 'Bank ending 4242', destination_version_snapshot = 1, calculation_finalized_at = now(), calculation_finalized_by = '10000000-0000-0000-0000-000000000014', approved_at = now(), approved_by = '10000000-0000-0000-0000-000000000012' where id = '52000000-0000-0000-0000-000000000011'$$,
  '42501', 'payout calculation finalizer must be an active owner or finance admin',
  'inactive finance administrators cannot finalize payout calculations'
);
select lives_ok(
  $$update public.payouts set status = 'approved', reconciliation_run_id = '60000000-0000-0000-0000-000000000011', minimum_payout_minor_snapshot = 1000, payout_frequency_days_snapshot = 14, payout_destination_id = '53000000-0000-0000-0000-000000000011', payment_method_snapshot = 'bank', destination_label_snapshot = 'Bank ending 4242', destination_version_snapshot = 1, calculation_finalized_at = now(), calculation_finalized_by = '10000000-0000-0000-0000-000000000012', approved_at = now(), approved_by = '10000000-0000-0000-0000-000000000012' where id = '52000000-0000-0000-0000-000000000011'$$,
  'ledger-matched payout can be finalized and approved with frozen evidence'
);
select throws_ok(
  $$update public.payouts set approved_at = approved_at + interval '1 minute' where id = '52000000-0000-0000-0000-000000000011'$$,
  'P0001', 'payout approval evidence is immutable',
  'approved payout actor and time evidence cannot be rewritten'
);
select lives_ok(
  $$update public.payout_destinations set status = 'replaced', replacement_id = '53000000-0000-0000-0000-000000000012' where id = '53000000-0000-0000-0000-000000000011'; update public.payout_destinations set status = 'active', effective_at = hold_until where id = '53000000-0000-0000-0000-000000000012'$$,
  'eligible replacement swaps atomically without two active destinations'
);
select is(
  (select id from public.payout_destinations where affiliate_id = '30000000-0000-0000-0000-000000000011' and currency = 'USD' and status = 'active'),
  '53000000-0000-0000-0000-000000000012'::uuid,
  'replacement destination is the sole active destination'
);
select lives_ok(
  $$update public.payouts set status = 'scheduled', scheduled_at = now() where id = '52000000-0000-0000-0000-000000000011'$$,
  'approved payout can be scheduled'
);
select lives_ok(
  $$update public.payouts set status = 'paid', paid_at = now(), payment_reference = 'payment-test-11' where id = '52000000-0000-0000-0000-000000000011'$$,
  'scheduled payout can be marked paid with settlement evidence'
);
select is(
  (select destination_label_snapshot from public.payouts where id = '52000000-0000-0000-0000-000000000011'),
  'Bank ending 4242',
  'later destination replacement never changes a payout frozen before the replacement'
);
select throws_ok(
  $$update public.payouts set final_payout_minor = 9999 where id = '52000000-0000-0000-0000-000000000011'$$,
  'P0001', 'paid payouts are immutable',
  'paid payout values cannot be rewritten'
);
select throws_ok(
  $$insert into public.payout_agreement_snapshots (payout_id, agreement_id, agreement_version, model, attribution_window_days, payout_frequency_days, payout_currency, minimum_payout_minor, rules_snapshot) values ('52000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', 1, 'cpa', 30, 14, 'USD', 1000, '[]')$$,
  'P0001', 'agreement snapshots cannot be added after payout finalization',
  'payout snapshots cannot be appended after finalization'
);
select throws_ok(
  $$update public.commission_entries set amount_minor = 1 where id = '51000000-0000-0000-0000-000000000011'$$,
  'P0001', 'commission_entries is append-only',
  'commission ledger cannot be rewritten'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000011', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000011","role":"authenticated","email":"money-partner@example.test"}', true);
select is(
  (select final_payout_minor from public.get_partner_payout_detail('52000000-0000-0000-0000-000000000011')),
  2500::bigint,
  'authorized partner receives immutable payout detail'
);
select is(
  jsonb_array_length((select calculation from public.get_partner_payout_detail('52000000-0000-0000-0000-000000000011'))),
  6,
  'payout detail exposes a bounded calculation allowlist'
);
select ok(
  not ((select history from public.get_partner_payout_detail('52000000-0000-0000-0000-000000000011'))::text like '%source_key%'),
  'payout detail history omits internal source keys'
);
reset role;
select throws_ok(
  $$update public.reconciliation_runs set details = '{"tampered":true}' where id = '60000000-0000-0000-0000-000000000011'$$,
  'P0001', 'completed reconciliation runs are immutable',
  'completed reconciliation is immutable'
);

insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at
)
values
  ('50000000-0000-0000-0000-000000000012', '2026-05-15', '2026-05-29', '2026-05-29', '2026-06-04'),
  ('50000000-0000-0000-0000-000000000013', '2026-05-29', '2026-06-12', '2026-06-12', '2026-06-18');
insert into public.commission_entries (
  id, affiliate_id, product_id, agreement_id, payout_period_id, entry_type,
  amount_minor, currency, source_key, partner_visible_description
)
values (
  '51000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000011',
  '50000000-0000-0000-0000-000000000012',
  'adjustment', -500, 'USD', 'debt-adjustment:12', 'Prior-period debt'
);
insert into public.payouts (
  id, affiliate_id, product_id, payout_period_id, adjustments_minor,
  carry_out_minor, final_payout_minor, currency
)
values (
  '52000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '50000000-0000-0000-0000-000000000012', -500, -500, 0, 'USD'
);
insert into public.payout_agreement_snapshots (
  payout_id, agreement_id, agreement_version, model, attribution_window_days,
  payout_frequency_days, payout_currency, minimum_payout_minor, rules_snapshot
)
select
  '52000000-0000-0000-0000-000000000012', agreement.id, agreement.version,
  agreement.model, agreement.attribution_window_days, agreement.payout_frequency_days,
  agreement.payout_currency, agreement.minimum_payout_minor,
  jsonb_agg(
    jsonb_build_object(
      'name', rule.name, 'version', rule.version, 'status', rule.status,
      'model', rule.model, 'trigger_event', rule.trigger_event,
      'fixed_amount_minor', rule.fixed_amount_minor,
      'rate_basis_points', rule.rate_basis_points, 'currency', rule.currency,
      'validation_window_hours', rule.validation_window_hours
    ) order by rule.name, rule.version
  )
from public.agreements as agreement
join public.commission_rules as rule on rule.agreement_id = agreement.id
where agreement.id = '40000000-0000-0000-0000-000000000011'
group by agreement.id;
insert into public.reconciliation_runs (
  id, provider, starts_at, ends_at, currency, idempotency_key, scheduled_for
)
values (
  '60000000-0000-0000-0000-000000000012', 'stripe',
  '2026-05-15', '2026-05-29', 'USD', 'stripe:2026-05-15:2026-05-29:USD', now()
);
update public.reconciliation_runs set status = 'running', started_at = now()
where id = '60000000-0000-0000-0000-000000000012';
update public.reconciliation_runs
set status = 'passed', provider_total_minor = 0, internal_total_minor = 0,
    unexplained_difference_minor = 0, completed_at = now()
where id = '60000000-0000-0000-0000-000000000012';
update public.payout_periods set status = 'review'
where id = '50000000-0000-0000-0000-000000000012';
update public.payouts
set status = 'review', reviewed_at = now(), reviewed_by = '10000000-0000-0000-0000-000000000012'
where id = '52000000-0000-0000-0000-000000000012';
update public.payout_periods set status = 'closed', closed_at = now()
where id = '50000000-0000-0000-0000-000000000012';
select lives_ok(
  $$update public.payouts set status = 'carried_forward', reconciliation_run_id = '60000000-0000-0000-0000-000000000012', minimum_payout_minor_snapshot = 1000, payout_frequency_days_snapshot = 14, calculation_finalized_at = now(), calculation_finalized_by = '10000000-0000-0000-0000-000000000012' where id = '52000000-0000-0000-0000-000000000012'$$,
  'a signed negative debt balance is finalized as carry-forward rather than stranded on hold'
);

insert into public.commission_entries (
  id, affiliate_id, product_id, agreement_id, source_payout_id, payout_period_id,
  entry_type, amount_minor, currency, source_key, partner_visible_description
)
values (
  '51000000-0000-0000-0000-000000000013',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000011',
  '52000000-0000-0000-0000-000000000012',
  '50000000-0000-0000-0000-000000000013',
  'carry_forward', -500, 'USD', 'carry:12-to-13', 'Debt carried in'
);
select throws_ok(
  $$insert into public.commission_entries (affiliate_id, product_id, agreement_id, source_payout_id, payout_period_id, entry_type, amount_minor, currency, source_key, partner_visible_description) values ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000011', '52000000-0000-0000-0000-000000000012', '50000000-0000-0000-0000-000000000013', 'carry_forward', -500, 'USD', 'carry:duplicated', 'Duplicated debt')$$,
  '23505', 'duplicate key value violates unique constraint "commission_entries_one_carry_consumption"',
  'a finalized carry balance can be consumed exactly once'
);
insert into public.commission_entries (
  id, affiliate_id, product_id, agreement_id, payout_period_id, entry_type,
  amount_minor, currency, source_key, partner_visible_description
)
values (
  '51000000-0000-0000-0000-000000000014',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000011',
  '50000000-0000-0000-0000-000000000013',
  'adjustment', 1500, 'USD', 'positive-adjustment:13', 'Current-period earnings adjustment'
);
insert into public.payouts (
  id, affiliate_id, product_id, payout_period_id, adjustments_minor,
  carry_in_minor, final_payout_minor, currency
)
values (
  '52000000-0000-0000-0000-000000000013',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '50000000-0000-0000-0000-000000000013', 1500, -500, 1000, 'USD'
);
insert into public.payout_agreement_snapshots (
  payout_id, agreement_id, agreement_version, model, attribution_window_days,
  payout_frequency_days, payout_currency, minimum_payout_minor, rules_snapshot
)
select
  '52000000-0000-0000-0000-000000000013', agreement.id, agreement.version,
  agreement.model, agreement.attribution_window_days, agreement.payout_frequency_days,
  agreement.payout_currency, agreement.minimum_payout_minor,
  jsonb_agg(
    jsonb_build_object(
      'name', rule.name, 'version', rule.version, 'status', rule.status,
      'model', rule.model, 'trigger_event', rule.trigger_event,
      'fixed_amount_minor', rule.fixed_amount_minor,
      'rate_basis_points', rule.rate_basis_points, 'currency', rule.currency,
      'validation_window_hours', rule.validation_window_hours
    ) order by rule.name, rule.version
  )
from public.agreements as agreement
join public.commission_rules as rule on rule.agreement_id = agreement.id
where agreement.id = '40000000-0000-0000-0000-000000000011'
group by agreement.id;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000011', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000011","role":"authenticated","email":"money-partner@example.test"}', true);
select is(
  (select carried_forward_minor from public.partner_payout_summary where product_id = '20000000-0000-0000-0000-000000000011'),
  -500::bigint,
  'payout summary reports the latest unresolved signed carry, not a lifetime sum'
);
select is(
  (select count(*) from public.partner_payout_summary where product_id = '20000000-0000-0000-0000-000000000011'),
  1::bigint,
  'product-scoped payout summary remains exactly one row across historical periods'
);
reset role;

insert into public.reconciliation_runs (
  id, provider, starts_at, ends_at, currency, idempotency_key, scheduled_for
)
values (
  '60000000-0000-0000-0000-000000000013', 'stripe',
  '2026-05-29', '2026-06-12', 'USD', 'stripe:2026-05-29:2026-06-12:USD', now()
);
update public.reconciliation_runs set status = 'running', started_at = now()
where id = '60000000-0000-0000-0000-000000000013';
update public.reconciliation_runs
set status = 'passed', provider_total_minor = 0, internal_total_minor = 0,
    unexplained_difference_minor = 0, completed_at = now()
where id = '60000000-0000-0000-0000-000000000013';
update public.payout_periods set status = 'review'
where id = '50000000-0000-0000-0000-000000000013';
update public.payouts
set status = 'review', reviewed_at = now(), reviewed_by = '10000000-0000-0000-0000-000000000012'
where id = '52000000-0000-0000-0000-000000000013';
update public.payout_periods set status = 'closed', closed_at = now()
where id = '50000000-0000-0000-0000-000000000013';
select throws_ok(
  $$update public.payouts set status = 'carried_forward', carry_out_minor = 1000, final_payout_minor = 0, reconciliation_run_id = '60000000-0000-0000-0000-000000000013', minimum_payout_minor_snapshot = 1000, payout_frequency_days_snapshot = 14, calculation_finalized_at = now(), calculation_finalized_by = '10000000-0000-0000-0000-000000000012' where id = '52000000-0000-0000-0000-000000000013'$$,
  'P0001', 'carried-forward payout must carry the complete below-minimum signed balance',
  'a balance at the minimum threshold cannot be carried again'
);
select lives_ok(
  $$update public.payouts set status = 'approved', reconciliation_run_id = '60000000-0000-0000-0000-000000000013', minimum_payout_minor_snapshot = 1000, payout_frequency_days_snapshot = 14, payout_destination_id = '53000000-0000-0000-0000-000000000012', payment_method_snapshot = 'bank', destination_label_snapshot = 'Bank ending 9898', destination_version_snapshot = 2, calculation_finalized_at = now(), calculation_finalized_by = '10000000-0000-0000-0000-000000000012', approved_at = now(), approved_by = '10000000-0000-0000-0000-000000000012' where id = '52000000-0000-0000-0000-000000000013'$$,
  'later positive earnings can offset carried debt and pay the exact net balance'
);

insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  payout_frequency_days, payout_currency, minimum_payout_minor
)
values (
  '40000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  2, 'cpa', 'draft', '2026-06-12', 14, 'EUR', 1000
);
insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values (
  '41000000-0000-0000-0000-000000000012',
  '40000000-0000-0000-0000-000000000012',
  'Qualified purchase', 1, 'active', 'cpa', 'purchase', 2500, 'EUR'
);
update public.agreements set status = 'active'
where id = '40000000-0000-0000-0000-000000000012';
insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at
)
values (
  '50000000-0000-0000-0000-000000000014',
  '2026-06-12', '2026-06-26', '2026-06-26', '2026-07-02'
);
insert into public.commission_entries (
  id, affiliate_id, product_id, agreement_id, payout_period_id, entry_type,
  amount_minor, currency, source_key, partner_visible_description
)
values (
  '51000000-0000-0000-0000-000000000015',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000012',
  '50000000-0000-0000-0000-000000000014',
  'adjustment', 500, 'EUR', 'eur-adjustment:14', 'EUR adjustment'
);
insert into public.payouts (
  id, affiliate_id, product_id, payout_period_id, adjustments_minor,
  final_payout_minor, currency
)
values (
  '52000000-0000-0000-0000-000000000014',
  '30000000-0000-0000-0000-000000000011',
  '20000000-0000-0000-0000-000000000011',
  '50000000-0000-0000-0000-000000000014', 500, 500, 'EUR'
);
insert into public.payout_agreement_snapshots (
  payout_id, agreement_id, agreement_version, model, attribution_window_days,
  payout_frequency_days, payout_currency, minimum_payout_minor, rules_snapshot
)
select
  '52000000-0000-0000-0000-000000000014', agreement.id, agreement.version,
  agreement.model, agreement.attribution_window_days, agreement.payout_frequency_days,
  agreement.payout_currency, agreement.minimum_payout_minor,
  jsonb_agg(
    jsonb_build_object(
      'name', rule.name, 'version', rule.version, 'status', rule.status,
      'model', rule.model, 'trigger_event', rule.trigger_event,
      'fixed_amount_minor', rule.fixed_amount_minor,
      'rate_basis_points', rule.rate_basis_points, 'currency', rule.currency,
      'validation_window_hours', rule.validation_window_hours
    ) order by rule.name, rule.version
  )
from public.agreements as agreement
join public.commission_rules as rule on rule.agreement_id = agreement.id
where agreement.id = '40000000-0000-0000-0000-000000000012'
group by agreement.id;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000011', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000011","role":"authenticated","email":"money-partner@example.test"}', true);
select is(
  (select count(*) from public.partner_payout_summary where product_id = '20000000-0000-0000-0000-000000000011'),
  1::bigint,
  'a selected product still has exactly one payout-summary row after a historical currency change'
);
select is(
  (select currency from public.partner_payout_summary where product_id = '20000000-0000-0000-0000-000000000011'),
  null::text,
  'mixed-currency payout history does not claim a single currency'
);
select is(
  (select paid_minor from public.partner_payout_summary where product_id = '20000000-0000-0000-0000-000000000011'),
  null::bigint,
  'mixed-currency payout history never adds unlike money'
);
reset role;

set constraints payouts_require_agreement_snapshot immediate;

select * from finish();
rollback;
