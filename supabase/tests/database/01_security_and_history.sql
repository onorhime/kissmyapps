begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'partner-a@example.test', '', now(), '{}', '{"full_name":"Partner A Owner"}', now(), now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'partner-b@example.test', '', now(), '{}', '{"full_name":"Partner B Owner"}', now(), now()),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'paused@example.test', '', now(), '{}', '{"full_name":"Paused Owner"}', now(), now()),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'terminated@example.test', '', now(), '{}', '{"full_name":"Former Owner"}', now(), now()),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'analyst@example.test', '', now(), '{}', '{"full_name":"Partner Analyst"}', now(), now()),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'support@example.test', '', now(), '{}', '{"full_name":"Support Admin"}', now(), now()),
  ('10000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.test', '', now(), '{}', '{"full_name":"Platform Owner"}', now(), now());

insert into public.platform_settings (tracking_base_url, tracking_enabled)
values ('https://go.kissmyapps.dev', true);

select throws_ok(
  $$insert into public.affiliates (public_name, slug, reporting_timezone, status) values ('Invalid Timezone', 'invalid-timezone', 'Mars/Olympus_Mons', 'draft')$$,
  '22023', 'reporting timezone must be a valid IANA timezone name',
  'partner reporting timezones must be valid IANA names'
);

insert into public.products (id, slug, name, status)
values ('20000000-0000-0000-0000-000000000001', 'contract-product', 'Contract Product', 'active');

insert into public.affiliates (
  id, public_name, legal_name, slug, entity_type, country_code,
  reporting_timezone, preferred_currency, status
)
values
  ('30000000-0000-0000-0000-000000000001', 'Partner A', 'Partner A LLC', 'partner-a', 'company', 'US', 'UTC', 'USD', 'active'),
  ('30000000-0000-0000-0000-000000000002', 'Partner B', 'Partner B LLC', 'partner-b', 'company', 'GB', 'UTC', 'USD', 'active'),
  ('30000000-0000-0000-0000-000000000003', 'Paused Partner', 'Paused Partner LLC', 'paused-partner', 'company', 'CA', 'UTC', 'USD', 'active'),
  ('30000000-0000-0000-0000-000000000004', 'Former Partner', 'Former Partner LLC', 'former-partner', 'company', 'NG', 'UTC', 'USD', 'active');

insert into public.affiliate_users (
  affiliate_id, user_id, role, active, activation_pending, activated_at
)
values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner', true, false, now()),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'owner', true, false, now()),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'owner', true, false, now()),
  ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', 'owner', true, false, now()),
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'analyst', true, false, now());

insert into public.admin_users (user_id, role)
values
  ('10000000-0000-0000-0000-000000000006', 'support'),
  ('10000000-0000-0000-0000-000000000007', 'owner');

insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  payout_currency, minimum_payout_minor
)
values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1, 'cpa', 'draft', '2026-01-01', 'USD', 1000),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 1, 'cpa', 'draft', '2026-01-01', 'USD', 1000),
  ('40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 1, 'cpa', 'draft', '2026-01-01', 'USD', 1000),
  ('40000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 1, 'cpa', 'draft', '2026-01-01', 'USD', 1000);

insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values
  ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD'),
  ('41000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'Purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD'),
  ('41000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 'Purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD'),
  ('41000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000004', 'Purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD');

insert into public.documents (
  id, affiliate_id, agreement_id, name, document_type, version, file_path,
  status, effective_at, signed_by_partner_at, signed_by_kissmyapps_at
)
values (
  '71000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  'Signed agreement', 'agreement', 1,
  '30000000-0000-0000-0000-000000000001/agreements/signed.pdf',
  'active', now(), now(), now()
);

insert into public.billing_offers (
  id, product_id, key, version, name, billing_mode, stripe_price_id, currency,
  unit_amount_minor, success_url_template, cancel_url, status,
  verified_stripe_price_id, verified_currency, verified_unit_amount_minor,
  verified_billing_mode, stripe_livemode_verified_at
)
values (
  '79000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'monthly', 1, 'Monthly subscription', 'subscription', 'price_SecurityMonthly001', 'USD',
  1999, 'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
  'https://app.kissmyapps.dev/cancel', 'active',
  'price_SecurityMonthly001', 'USD', 1999, 'subscription', now()
);

update public.agreements set status = 'active';

-- These workspaces had active agreements before their partner lifecycle changed.
-- Establish that valid chronology so the activation guard remains enforceable.
update public.affiliates
set status = case id
  when '30000000-0000-0000-0000-000000000003' then 'paused'::public.affiliate_status
  when '30000000-0000-0000-0000-000000000004' then 'terminated'::public.affiliate_status
end
where id in (
  '30000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000004'
);

insert into public.funnels (id, product_id, key, name, destination_url, status)
values (
  '50000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'contract-funnel', 'Contract Funnel', 'https://destination.example.test/start', 'live'
);
insert into public.sources (id, key, name)
values ('51000000-0000-0000-0000-000000000001', 'security-fixture-newsletter', 'Newsletter');
insert into public.campaigns (id, product_id, key, name, status)
values
  ('52000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'launch', 'Launch', 'active'),
  ('52000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'retired', 'Retired', 'archived');

insert into public.affiliate_links (
  id, affiliate_id, product_id, source_id, campaign_id, funnel_id, name,
  public_code, tracking_url, sub1, status, created_by
)
values
  ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Partner A Link', 'aaaaaaaaaaaaaaaa', 'https://go.kissmyapps.dev/r/partner-a/aaaaaaaaaaaaaaaa', 'weekly', 'active', '10000000-0000-0000-0000-000000000001'),
  ('60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Partner B Link', 'bbbbbbbbbbbbbbbb', 'https://go.kissmyapps.dev/r/partner-b/bbbbbbbbbbbbbbbb', 'weekly', 'paused', '10000000-0000-0000-0000-000000000002'),
  ('60000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', null, null, '50000000-0000-0000-0000-000000000001', 'Paused Link', 'cccccccccccccccc', 'https://go.kissmyapps.dev/r/paused-partner/cccccccccccccccc', 'archive', 'paused', '10000000-0000-0000-0000-000000000003'),
  ('60000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', null, null, '50000000-0000-0000-0000-000000000001', 'Former Link', 'dddddddddddddddd', 'https://go.kissmyapps.dev/r/former-partner/dddddddddddddddd', 'archive', 'paused', '10000000-0000-0000-0000-000000000004');

insert into public.affiliate_daily_metrics (
  id, affiliate_id, product_id, affiliate_link_id, metric_date, source_id,
  campaign_id, funnel_id, sub1, clicks, visitors, leads, purchases,
  eligible_revenue_minor, earnings_minor, currency, completeness,
  reconciliation_stage, reconciled_through, calculated_at
)
values
  ('70000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '2026-08-20', '51000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'weekly', 12, 10, 2, 1, 10000, 2500, 'USD', 'complete', 'reconciled', '2026-08-20', now()),
  ('70000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', '2026-08-20', '51000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'weekly', 99, 80, 9, 7, 70000, 17500, 'USD', 'complete', 'reconciled', '2026-08-20', now());

insert into public.affiliate_daily_metrics (
  id, affiliate_id, product_id, metric_date, active_subscriptions,
  is_subscription_snapshot, currency, completeness, reconciliation_stage,
  reconciled_through, calculated_at
)
values
  ('70000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '2026-08-19', 10, true, 'USD', 'complete', 'reconciled', '2026-08-19', now()),
  ('70000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '2026-08-20', 4, true, 'USD', 'complete', 'reconciled', '2026-08-20', now());

select throws_ok(
  $$insert into public.affiliate_daily_metrics (affiliate_id, product_id, metric_date, clicks, active_subscriptions, is_subscription_snapshot, currency, completeness, calculated_at) values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '2026-08-21', 1, 3, true, 'USD', 'complete', now())$$,
  '23514', null,
  'subscription snapshots cannot duplicate additive reporting metrics'
);

insert into storage.objects (id, bucket_id, name)
values
  ('75000000-0000-0000-0000-000000000001', 'affiliate-private-documents', '30000000-0000-0000-0000-000000000001/agreements/signed.pdf'),
  ('75000000-0000-0000-0000-000000000002', 'affiliate-private-documents', '30000000-0000-0000-0000-000000000001/internal/unreferenced-draft.pdf');

insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at
)
values (
  '72000000-0000-0000-0000-000000000001',
  '2026-08-01', '2026-08-15', '2026-08-15', '2026-08-21'
);
insert into public.commission_entries (
  id, affiliate_id, product_id, agreement_id, payout_period_id, entry_type,
  amount_minor, currency, source_key, partner_visible_description
)
values (
  '73000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000001',
  'adjustment', 100, 'USD', 'security-adjustment:1', 'Security fixture adjustment'
);
insert into public.payouts (
  id, affiliate_id, product_id, payout_period_id, adjustments_minor,
  final_payout_minor, currency
)
values (
  '74000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000001', 100, 100, 'USD'
);
insert into public.payout_agreement_snapshots (
  payout_id, agreement_id, agreement_version, model, attribution_window_days,
  payout_frequency_days, payout_currency, minimum_payout_minor, rules_snapshot
)
select
  '74000000-0000-0000-0000-000000000001', agreement.id, agreement.version,
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
where agreement.id = '40000000-0000-0000-0000-000000000001'
group by agreement.id;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"email":"partner-a@example.test","sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","amr":[{"method":"password"}]}', true);

select throws_ok(
  $$select * from public.affiliates$$,
  '42501', 'permission denied for table affiliates',
  'partner cannot bypass allowlists with a raw affiliate query'
);
select throws_ok(
  $$select provider_reference from public.payout_destinations$$,
  '42501', 'permission denied for table payout_destinations',
  'partner cannot read payout provider references'
);
select is((select count(*) from public.partner_profile), 1::bigint, 'partner sees one own profile');
select is((select public_name from public.partner_profile), 'Partner A', 'profile belongs to the authenticated workspace');
select is((select count(*) from public.partner_product_directory), 1::bigint, 'partner sees its related product');
select is((select count(*) from public.partner_link_directory), 1::bigint, 'partner sees only its link');
select is(
  (select tracking_url from public.partner_link_directory),
  'https://go.kissmyapps.dev/r/partner-a/aaaaaaaaaaaaaaaa',
  'partner sees the issued tracking URL'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'partner_link_directory' and column_name = 'destination_url'
  ),
  'partner link directory never exposes funnel destinations'
);
select is(
  (select clicks from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000001', '2026-08-20', '2026-08-20',
    'UTC', null, null, null, null, null
  )),
  12::bigint,
  'summary RPC aggregates only the current partner tenant'
);
select is(
  (select active_subscriptions from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000001', '2026-08-19', '2026-08-20',
    'UTC', null, null, null, null, null
  )),
  4::bigint,
  'active subscriptions use the latest complete snapshot rather than the historical maximum'
);
select is(
  (select count(*) from public.get_partner_dashboard_trends(
    '20000000-0000-0000-0000-000000000001', '2026-08-19', '2026-08-20',
    'UTC', null, null, null, null, null, 'day', 'source'
  ) where active_subscriptions is not null),
  0::bigint,
  'global subscription snapshots are not falsely attributed to a source group'
);
select throws_ok(
  $$select * from public.get_partner_dashboard_summary(null, '2026-08-20', '2026-08-20', 'UTC', null, null, null, null, null)$$,
  '42501', 'an authorized product is required',
  'direct reporting callers cannot request a cross-product aggregate'
);
select is(
  (select count(*) from storage.objects where name like '30000000-0000-0000-0000-000000000001/%'),
  1::bigint,
  'storage policy exposes only a partner-owned object referenced by an eligible application record'
);
select is(
  (select count(*) from storage.objects where name like '%unreferenced-draft.pdf'),
  0::bigint,
  'same-prefix but unreferenced storage objects remain private'
);

select throws_ok(
  $$select * from public.create_partner_link('{"name":"Injected","product_id":"20000000-0000-0000-0000-000000000001","funnel_id":"50000000-0000-0000-0000-000000000001","sub1":"test","admin":true}'::jsonb)$$,
  '22023', 'link input must be a JSON object with supported fields',
  'create-link RPC rejects over-posted fields'
);
select lives_ok(
  $$select * from public.create_partner_link('{"name":"RPC Link","product_id":"20000000-0000-0000-0000-000000000001","funnel_id":"50000000-0000-0000-0000-000000000001","source_id":null,"campaign_id":null,"sub1":"rpc","sub2":"placement","sub3":"creative","parent_link_id":null}'::jsonb)$$,
  'owner can create a server-issued link'
);
select ok(
  (select tracking_url from public.partner_link_directory where name = 'RPC Link') like 'https://go.kissmyapps.dev/r/partner-a/%',
  'created link is issued only on the configured tracking domain'
);
select throws_ok(
  $$select * from public.update_partner_link('60000000-0000-0000-0000-000000000001', '{"tracking_url":"https://attacker.example"}'::jsonb)$$,
  '22023', 'issued link attribution is immutable; only name may be updated',
  'update-link RPC rejects routing mutations under the immutable-link contract'
);
select throws_ok(
  $$select * from public.update_partner_link('60000000-0000-0000-0000-000000000001', '{"campaign_id":"52000000-0000-0000-0000-000000000002"}'::jsonb)$$,
  '22023', 'issued link attribution is immutable; only name may be updated',
  'update-link RPC cannot retag an issued link to another campaign'
);

select lives_ok(
  $$select * from public.update_partner_profile('{"full_name":"Partner A Owner","public_name":"Partner A Updated","legal_name":"Partner A LLC","entity_type":"Company","country_code":"US","timezone":"UTC","preferred_currency":"USD","website":"https://partner-a.example.test","category":"Technology","audience_description":"Technical readers","audience_countries":["US","GB"],"channels":["Newsletter"],"channel_details":"Weekly"}'::jsonb)$$,
  'owner can update allowlisted profile fields'
);
select is((select public_name from public.partner_profile), 'Partner A Updated', 'profile RPC persists shared partner identity');
select throws_ok(
  $$select * from public.update_partner_profile('{"full_name":"Partner A Owner","public_name":"Partner A Updated","legal_name":"Partner A LLC","entity_type":"Company","country_code":"US","timezone":"Africa/Lagos","preferred_currency":"USD","website":"https://partner-a.example.test","category":"Technology","audience_description":"Technical readers","audience_countries":["US","GB"],"channels":["Newsletter"],"channel_details":"Weekly"}'::jsonb)$$,
  'P0001', 'reporting timezone cannot change after daily reporting facts exist',
  'profile timezone cannot reinterpret historical date buckets'
);
select lives_ok(
  $$select * from public.update_partner_settings('{"notifications":{"statements":true,"payouts":false,"verification":true,"signatures":true,"adjustments":true,"inactive_links":false}}'::jsonb)$$,
  'partner can update all six per-user notification preferences'
);
select is(
  (select notifications ->> 'payouts' from public.partner_profile),
  'false',
  'notification preferences are returned through the profile allowlist'
);

reset role;
update public.agreements
set status = 'superseded', ends_at = '2026-08-20 12:00:00+00'
where id = '40000000-0000-0000-0000-000000000001';
insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  payout_currency, minimum_payout_minor
)
values (
  '40000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  2, 'cpa', 'draft', '2026-08-20 12:00:00+00', 'NGN', 100000
);
insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values (
  '41000000-0000-0000-0000-000000000011',
  '40000000-0000-0000-0000-000000000011',
  'Purchase', 1, 'active', 'cpa', 'purchase.completed', 250000, 'NGN'
);
update public.agreements set status = 'active'
where id = '40000000-0000-0000-0000-000000000011';
insert into public.affiliate_daily_metrics (
  id, affiliate_id, product_id, metric_date, clicks, visitors,
  gross_collected_minor, eligible_revenue_minor, earnings_minor,
  currency, completeness, reconciliation_stage, reconciled_through, calculated_at
)
values (
  '70000000-0000-0000-0000-000000000021',
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '2026-08-20', 3, 2, 1000000, 900000, 250000,
  'NGN', 'complete', 'reconciled', '2026-08-20', now()
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"email":"partner-a@example.test","sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","amr":[{"method":"password"}]}', true);
select is(
  (select clicks from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000001', '2026-08-20', '2026-08-20',
    'UTC', null, null, null, null, null
  )),
  15::bigint,
  'mixed-currency reporting preserves currency-independent counts'
);
select is(
  (select currency from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000001', '2026-08-20', '2026-08-20',
    'UTC', null, null, null, null, null
  )),
  null::text,
  'mixed-currency summary does not claim a currency'
);
select is(
  (select gross_collected_minor from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000001', '2026-08-20', '2026-08-20',
    'UTC', null, null, null, null, null
  )),
  null::bigint,
  'mixed-currency summary never adds unlike money'
);
select is(
  (select gross_collected_minor from public.get_partner_dashboard_trends(
    '20000000-0000-0000-0000-000000000001', '2026-08-20', '2026-08-20',
    'UTC', null, null, null, null, null, 'day', 'date'
  )),
  null::bigint,
  'mixed-currency trend buckets never add unlike money'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claims', '{"email":"partner-b@example.test","sub":"10000000-0000-0000-0000-000000000002","role":"authenticated","amr":[{"method":"password"}]}', true);
select is((select count(*) from public.partner_link_directory), 1::bigint, 'second partner sees only its link');
select is((select name from public.partner_link_directory), 'Partner B Link', 'second partner cannot read first partner link');
select throws_ok(
  $$select * from public.update_partner_link('60000000-0000-0000-0000-000000000001', '{"name":"Cross-tenant edit"}'::jsonb)$$,
  '42501', 'link not found or role cannot edit it',
  'security-definer link update cannot cross partner tenants'
);
select throws_ok(
  $$select * from public.set_partner_link_status('60000000-0000-0000-0000-000000000001', 'paused')$$,
  '42501', 'link not found or role cannot change its status',
  'security-definer link status changes cannot cross partner tenants'
);
select is((select count(*) from public.partner_document_directory), 0::bigint, 'second partner sees zero first-partner documents');
select is((select count(*) from public.partner_payout_history), 0::bigint, 'second partner sees zero first-partner payout rows');
select is((select count(*) from public.partner_payout_summary), 0::bigint, 'second partner sees zero first-partner payout balances');
select is(
  (select count(*) from public.get_partner_payout_detail('74000000-0000-0000-0000-000000000001')),
  0::bigint,
  'security-definer payout detail returns no cross-tenant row'
);
select is(
  (select count(*) from public.partner_agreement_directory where version = 2),
  0::bigint,
  'second partner cannot see the first partner unique agreement version'
);
select is(
  (select count(*) from storage.objects where bucket_id = 'affiliate-private-documents' and name = '30000000-0000-0000-0000-000000000001/agreements/signed.pdf'),
  0::bigint,
  'storage policy denies a referenced object owned by another partner'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claims', '{"email":"paused@example.test","sub":"10000000-0000-0000-0000-000000000003","role":"authenticated","amr":[{"method":"password"}]}', true);
select is((select count(*) from public.partner_link_directory), 1::bigint, 'paused workspace retains historical read access');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000004', true);
select set_config('request.jwt.claims', '{"email":"terminated@example.test","sub":"10000000-0000-0000-0000-000000000004","role":"authenticated","amr":[{"method":"password"}]}', true);
select is((select count(*) from public.partner_profile), 0::bigint, 'terminated workspace has no partner profile access');
select is((select count(*) from public.partner_link_directory), 0::bigint, 'terminated workspace has no historical browser access');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000005', true);
select set_config('request.jwt.claims', '{"email":"analyst@example.test","sub":"10000000-0000-0000-0000-000000000005","role":"authenticated","amr":[{"method":"password"}]}', true);
select throws_ok(
  $$select * from public.create_partner_link('{"name":"Nope","product_id":"20000000-0000-0000-0000-000000000001","funnel_id":"50000000-0000-0000-0000-000000000001","sub1":"nope"}'::jsonb)$$,
  '42501', 'partner role cannot create links',
  'affiliate analyst cannot mutate links'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000006', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000006","role":"authenticated","amr":[{"method":"password"}]}', true);
select ok(not public.current_user_is_admin(array['finance']::text[]), 'support admin does not inherit finance role');
select ok(public.current_user_is_admin(array['support']::text[]), 'support admin matches only its role');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000007', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000007","role":"authenticated","amr":[{"method":"password"}]}', true);
select ok(public.current_user_is_admin(array['owner']::text[]), 'platform owner passes owner role check');

reset role;
update public.products set status = 'paused' where id = '20000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"email":"partner-a@example.test","sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","amr":[{"method":"password"}]}', true);
select is((select count(*) from public.partner_link_directory), 2::bigint, 'paused product does not erase authorized link history');
select is((select count(*) from public.partner_product_directory), 1::bigint, 'paused product remains in partner history');

reset role;
select ok((select count(*) from public.audit_logs) > 0, 'audited mutations write audit history');
select throws_ok(
  $$delete from public.audit_logs$$,
  'P0001', 'audit_logs is append-only',
  'audit history cannot be deleted'
);

select * from finish();
rollback;
