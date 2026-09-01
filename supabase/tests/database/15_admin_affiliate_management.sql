begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function(
  'public', 'get_admin_affiliate_summary', array[]::text[],
  'admin affiliate summary RPC exists'
);
select has_function(
  'public', 'get_admin_affiliate_directory', array['jsonb'],
  'admin affiliate directory RPC exists'
);
select has_function(
  'public', 'get_admin_affiliate_detail', array['uuid'],
  'admin affiliate detail RPC exists'
);
select has_function(
  'public', 'set_admin_affiliate_status', array['jsonb'],
  'admin affiliate pause/reactivate RPC exists'
);
select has_function(
  'public', 'terminate_admin_affiliate', array['jsonb'],
  'admin affiliate termination RPC exists'
);
select has_function(
  'public', 'guard_agreement_activation_affiliate_status', array[]::text[],
  'agreement activation serialization guard exists'
);
select has_trigger(
  'public', 'agreements', 'agreements_guard_activation_affiliate_status',
  'agreement activation is serialized with partner termination'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.get_admin_affiliate_directory(jsonb)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.get_admin_affiliate_detail(uuid)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.get_admin_affiliate_summary()', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.set_admin_affiliate_status(jsonb)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.terminate_admin_affiliate(jsonb)', 'EXECUTE'
  ),
  'authenticated browsers receive only the guarded affiliate-management entrypoints'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.admin_affiliate_directory_rows(uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.guard_agreement_activation_affiliate_status()', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.get_admin_affiliate_directory(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.get_admin_affiliate_directory(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.terminate_admin_affiliate(jsonb)', 'EXECUTE'
  ),
  'the row builder and browser lifecycle RPCs have no anonymous or service execution grant'
);
select ok(
  not has_table_privilege('authenticated', 'public.affiliates', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.affiliate_users', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.affiliate_links', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.platform_legal_acceptances', 'SELECT')
  and not has_table_privilege('authenticated', 'public.audit_logs', 'INSERT'),
  'affiliate management does not widen direct browser table privileges'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  invited_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000151',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'affiliate-owner@example.test',
    '$2a$10$affiliateManagementOwnerPasswordHash000000000000000000',
    now(), null, '{}', '{"full_name":"Affiliate Owner"}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000152',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'affiliate-operations@example.test',
    '$2a$10$affiliateManagementOperationsPasswordHash00000000000000',
    now(), null, '{}', '{"full_name":"Affiliate Operations"}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000153',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'affiliate-support@example.test',
    '$2a$10$affiliateManagementSupportPasswordHash0000000000000000',
    now(), null, '{}', '{"full_name":"Affiliate Support"}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000154',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'affiliate-finance@example.test',
    '$2a$10$affiliateManagementFinancePasswordHash0000000000000000',
    now(), null, '{}', '{"full_name":"Affiliate Finance"}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000155',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'affiliate-analyst@example.test',
    '$2a$10$affiliateManagementAnalystPasswordHash0000000000000000',
    now(), null, '{}', '{"full_name":"Affiliate Analyst"}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000156',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'affiliate-ordinary@example.test',
    '$2a$10$affiliateManagementOrdinaryPasswordHash000000000000000',
    now(), null, '{}', '{"full_name":"Ordinary User"}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000157',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'affiliate-inactive-owner@example.test',
    '$2a$10$affiliateManagementInactiveOwnerPasswordHash000000000',
    now(), null, '{}', '{"full_name":"Inactive Owner"}', now(), now()
  ),
  (
    '11000000-0000-0000-0000-000000000158',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'confirmed-public@example.test',
    '$2a$10$confirmedPublicAffiliatePasswordHash000000000000000000',
    now(), null, '{}',
    '{
      "registration_flow":"public_partner_v1",
      "full_name":"Confirmed Public Partner",
      "terms_version":"2026-07-13",
      "terms_url":"https://kissmyapps.dev/terms",
      "privacy_version":"2026-07-13",
      "privacy_url":"https://kissmyapps.dev/privacy",
      "age_confirmed":true
    }',
    now() - interval '3 days', now()
  ),
  (
    '12000000-0000-0000-0000-000000000159',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'pending-public@example.test',
    '$2a$10$pendingPublicAffiliatePasswordHash00000000000000000000',
    null, null, '{}',
    '{
      "registration_flow":"public_partner_v1",
      "full_name":"Pending Public Partner",
      "terms_version":"2026-07-13",
      "terms_url":"https://kissmyapps.dev/terms",
      "privacy_version":"2026-07-13",
      "privacy_url":"https://kissmyapps.dev/privacy",
      "age_confirmed":true
    }',
    now() - interval '2 days', now()
  ),
  (
    '10000000-0000-0000-0000-000000000161',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'lifecycle@example.test',
    '$2a$10$lifecycleAffiliatePasswordHash000000000000000000000',
    now(), null, '{}', '{"full_name":"Lifecycle Owner"}', now() - interval '5 days', now()
  ),
  (
    '10000000-0000-0000-0000-000000000162',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'invited@example.test',
    '$2a$10$invitedAffiliatePasswordHash00000000000000000000000',
    now(), now(), '{}', '{"full_name":"Invited Owner"}', now() - interval '1 day', now()
  ),
  (
    '10000000-0000-0000-0000-000000000163',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'payout-blocker@example.test',
    '$2a$10$payoutBlockerAffiliatePasswordHash000000000000000000',
    now(), null, '{}', '{"full_name":"Payout Blocker Owner"}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000164',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'former-affiliate-owner@example.test',
    '$2a$10$formerAffiliateOwnerPasswordHash0000000000000000000',
    now(), null, '{}', '{"full_name":"Former Affiliate Owner"}',
    now() - interval '30 days', now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000151', 'owner', true),
  ('10000000-0000-0000-0000-000000000152', 'operations', true),
  ('10000000-0000-0000-0000-000000000153', 'support', true),
  ('10000000-0000-0000-0000-000000000154', 'finance', true),
  ('10000000-0000-0000-0000-000000000155', 'analyst', true),
  ('10000000-0000-0000-0000-000000000157', 'owner', false);

insert into public.affiliates (
  id, public_name, slug, status, audience_countries, channels
)
values
  (
    '30000000-0000-0000-0000-000000000151',
    'Lifecycle Partner', 'lifecycle-partner', 'active',
    array[' NG ', '', '   ', 'US'], array[' TikTok ', '', 'YouTube']
  ),
  (
    '30000000-0000-0000-0000-000000000152',
    'Invited Partner', 'invited-partner-management', 'invited', '{}', '{}'
  ),
  (
    '30000000-0000-0000-0000-000000000153',
    'Payout Blocker', 'payout-blocker', 'active', '{}', '{}'
  ),
  (
    '30000000-0000-0000-0000-000000000154',
    'Workspace Without Owner', 'workspace-without-owner', 'draft', '{}', '{}'
  ),
  (
    '30000000-0000-0000-0000-000000000155',
    'Carry Forward Blocker', 'carry-forward-blocker', 'active', '{}', '{}'
  ),
  (
    '30000000-0000-0000-0000-000000000156',
    'Unmaterialized Ledger Blocker', 'unmaterialized-ledger-blocker', 'active', '{}', '{}'
  );

insert into public.affiliate_users (
  affiliate_id, user_id, role, active, activation_pending, activated_at, created_at
)
values
  (
    '30000000-0000-0000-0000-000000000151',
    '10000000-0000-0000-0000-000000000161',
    'owner', true, false, now() - interval '4 days', now() - interval '5 days'
  ),
  (
    '30000000-0000-0000-0000-000000000152',
    '10000000-0000-0000-0000-000000000162',
    'owner', false, true, null, now() - interval '1 day'
  ),
  (
    '30000000-0000-0000-0000-000000000153',
    '10000000-0000-0000-0000-000000000163',
    'owner', true, false, now(), now()
  ),
  (
    '30000000-0000-0000-0000-000000000151',
    '10000000-0000-0000-0000-000000000164',
    'owner', false, false, now() - interval '30 days', now() - interval '30 days'
  ),
  (
    '30000000-0000-0000-0000-000000000152',
    '10000000-0000-0000-0000-000000000164',
    'owner', false, false, now() - interval '30 days', now() - interval '30 days'
  );

insert into public.platform_settings (singleton, tracking_base_url, tracking_enabled)
values (true, 'https://go.kissmyapps.dev', true)
on conflict (singleton) do update set
  tracking_base_url = excluded.tracking_base_url,
  tracking_enabled = excluded.tracking_enabled;

insert into public.products (id, slug, name, status)
values
  (
    '20000000-0000-0000-0000-000000000151',
    'affiliate-management-active', 'Affiliate Management Active', 'active'
  ),
  (
    '20000000-0000-0000-0000-000000000152',
    'affiliate-management-draft', 'Affiliate Management Draft', 'draft'
  );

insert into public.billing_offers (
  id, product_id, key, version, name, billing_mode, stripe_price_id, currency,
  unit_amount_minor, success_url_template, cancel_url, status,
  verified_stripe_price_id, verified_currency, verified_unit_amount_minor,
  verified_billing_mode, stripe_livemode_verified_at
)
values (
  '72000000-0000-0000-0000-000000000151',
  '20000000-0000-0000-0000-000000000151',
  'monthly', 1, 'Monthly subscription', 'subscription',
  'price_AffiliateManagement151', 'USD', 1999,
  'https://funnel.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
  'https://funnel.kissmyapps.dev/cancel', 'active',
  'price_AffiliateManagement151', 'USD', 1999, 'subscription', now()
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values (
  '50000000-0000-0000-0000-000000000151',
  '20000000-0000-0000-0000-000000000151',
  'primary', 'Primary Funnel', 'https://funnel.kissmyapps.dev/start', 'live', true
);

insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  payout_currency, minimum_payout_minor
)
values
  (
    '40000000-0000-0000-0000-000000000151',
    '30000000-0000-0000-0000-000000000151',
    '20000000-0000-0000-0000-000000000151',
    1, 'cpa', 'draft', '2026-01-01 00:00:00+00', 'USD', 10000
  ),
  (
    '40000000-0000-0000-0000-000000000152',
    '30000000-0000-0000-0000-000000000151',
    '20000000-0000-0000-0000-000000000152',
    1, 'cpa', 'draft', '2026-01-01 00:00:00+00', 'USD', 10000
  ),
  (
    '40000000-0000-0000-0000-000000000153',
    '30000000-0000-0000-0000-000000000153',
    '20000000-0000-0000-0000-000000000152',
    1, 'cpa', 'draft', null, 'USD', 10000
  ),
  (
    '40000000-0000-0000-0000-000000000154',
    '30000000-0000-0000-0000-000000000154',
    '20000000-0000-0000-0000-000000000152',
    1, 'cpa', 'awaiting_signature', null, 'USD', 10000
  ),
  (
    '40000000-0000-0000-0000-000000000155',
    '30000000-0000-0000-0000-000000000155',
    '20000000-0000-0000-0000-000000000152',
    1, 'cpa', 'draft', null, 'USD', 10000
  ),
  (
    '40000000-0000-0000-0000-000000000156',
    '30000000-0000-0000-0000-000000000156',
    '20000000-0000-0000-0000-000000000152',
    1, 'cpa', 'draft', null, 'USD', 10000
  );

insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values
  (
    '41000000-0000-0000-0000-000000000151',
    '40000000-0000-0000-0000-000000000151',
    'First purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD'
  ),
  (
    '41000000-0000-0000-0000-000000000152',
    '40000000-0000-0000-0000-000000000152',
    'Retained purchase', 1, 'active', 'cpa', 'purchase.completed', 1500, 'USD'
  );

insert into public.documents (
  id, affiliate_id, agreement_id, name, document_type, version, file_path,
  status, effective_at, signed_by_partner_at, signed_by_kissmyapps_at
)
values
  (
    '71000000-0000-0000-0000-000000000151',
    '30000000-0000-0000-0000-000000000151',
    '40000000-0000-0000-0000-000000000151',
    'Affiliate Management Agreement', 'affiliate_agreement', 1,
    '30000000-0000-0000-0000-000000000151/agreements/version-1.pdf',
    'active', '2026-01-01 00:00:00+00', now() - interval '1 day', now() - interval '1 day'
  ),
  (
    '71000000-0000-0000-0000-000000000152',
    '30000000-0000-0000-0000-000000000151',
    null,
    'Tax identity record', 'tax_identity', 1,
    '30000000-0000-0000-0000-000000000151/tax/version-1.pdf',
    'active', '2026-01-01 00:00:00+00', now() - interval '1 day', now() - interval '1 day'
  );

update public.agreements
set status = 'active'
where id = '40000000-0000-0000-0000-000000000151';

insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
  sub1, status, is_main, created_by
)
values (
  '60000000-0000-0000-0000-000000000151',
  '30000000-0000-0000-0000-000000000151',
  '20000000-0000-0000-0000-000000000151',
  '50000000-0000-0000-0000-000000000151',
  'Main Link', 'aaaaaaaaaaaaaaaa',
  'https://go.kissmyapps.dev/r/lifecycle-partner/aaaaaaaaaaaaaaaa',
  null, 'active', true, '10000000-0000-0000-0000-000000000151'
);

insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
  sub1, status, status_changed_at, archived_at, is_main, created_by
)
values (
  '60000000-0000-0000-0000-000000000152',
  '30000000-0000-0000-0000-000000000151',
  '20000000-0000-0000-0000-000000000151',
  '50000000-0000-0000-0000-000000000151',
  'Archived Link', 'bbbbbbbbbbbbbbbb',
  'https://go.kissmyapps.dev/r/lifecycle-partner/bbbbbbbbbbbbbbbb',
  'archive', 'archived', now(), now(), false,
  '10000000-0000-0000-0000-000000000151'
);

insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at, status
)
values
  (
    '70000000-0000-0000-0000-000000000153',
    '2026-08-01 00:00:00+00', '2026-08-15 00:00:00+00',
    '2026-08-15 00:00:00+00', '2026-08-29 00:00:00+00', 'open'
  ),
  (
    '70000000-0000-0000-0000-000000000154',
    '2026-07-01 00:00:00+00', '2026-07-15 00:00:00+00',
    '2026-07-15 00:00:00+00', '2026-07-29 00:00:00+00', 'open'
  ),
  (
    '70000000-0000-0000-0000-000000000155',
    '2026-07-15 00:00:00+00', '2026-07-29 00:00:00+00',
    '2026-07-29 00:00:00+00', '2026-08-12 00:00:00+00', 'open'
  );

insert into public.commission_entries (
  id, affiliate_id, product_id, agreement_id, payout_period_id, entry_type,
  amount_minor, currency, source_key, partner_visible_description
)
values
  (
    '73000000-0000-0000-0000-000000000153',
    '30000000-0000-0000-0000-000000000153',
    '20000000-0000-0000-0000-000000000152',
    '40000000-0000-0000-0000-000000000153',
    '70000000-0000-0000-0000-000000000153',
    'adjustment', 100, 'USD', 'admin-affiliate-open-adjustment',
    'Open payout adjustment'
  ),
  (
    '73000000-0000-0000-0000-000000000154',
    '30000000-0000-0000-0000-000000000155',
    '20000000-0000-0000-0000-000000000152',
    '40000000-0000-0000-0000-000000000155',
    '70000000-0000-0000-0000-000000000154',
    'adjustment', 500, 'USD', 'admin-affiliate-carry-adjustment',
    'Below-minimum carried balance'
  ),
  (
    '73000000-0000-0000-0000-000000000155',
    '30000000-0000-0000-0000-000000000156',
    '20000000-0000-0000-0000-000000000152',
    '40000000-0000-0000-0000-000000000156',
    '70000000-0000-0000-0000-000000000155',
    'adjustment', 250, 'USD', 'admin-affiliate-unmaterialized-adjustment',
    'Ledger balance awaiting payout materialization'
  );

insert into public.payouts (
  id, affiliate_id, product_id, payout_period_id, status, adjustments_minor,
  carry_out_minor, final_payout_minor, currency
)
values
  (
    '74000000-0000-0000-0000-000000000153',
    '30000000-0000-0000-0000-000000000153',
    '20000000-0000-0000-0000-000000000152',
    '70000000-0000-0000-0000-000000000153',
    'open', 100, 0, 100, 'USD'
  ),
  (
    '74000000-0000-0000-0000-000000000154',
    '30000000-0000-0000-0000-000000000155',
    '20000000-0000-0000-0000-000000000152',
    '70000000-0000-0000-0000-000000000154',
    'open', 500, 0, 500, 'USD'
  );

insert into public.payout_agreement_snapshots (
  payout_id, agreement_id, agreement_version, model, attribution_window_days,
  payout_frequency_days, payout_currency, minimum_payout_minor, rules_snapshot
)
values
  (
    '74000000-0000-0000-0000-000000000153',
    '40000000-0000-0000-0000-000000000153',
    1, 'cpa', 30, 14, 'USD', 10000, '[]'
  ),
  (
    '74000000-0000-0000-0000-000000000154',
    '40000000-0000-0000-0000-000000000155',
    1, 'cpa', 30, 14, 'USD', 10000, '[]'
  );

insert into public.reconciliation_runs (
  id, provider, starts_at, ends_at, currency, idempotency_key, scheduled_for
)
values (
  '76000000-0000-0000-0000-000000000154',
  'stripe', '2026-07-01 00:00:00+00', '2026-07-15 00:00:00+00', 'USD',
  'affiliate-management:carry:2026-07-01:2026-07-15:USD', now()
);
update public.reconciliation_runs
set status = 'running', started_at = now()
where id = '76000000-0000-0000-0000-000000000154';
update public.reconciliation_runs
set
  status = 'passed',
  provider_total_minor = 0,
  internal_total_minor = 0,
  unexplained_difference_minor = 0,
  completed_at = now()
where id = '76000000-0000-0000-0000-000000000154';

update public.payout_periods
set status = 'review'
where id = '70000000-0000-0000-0000-000000000154';
update public.payouts
set
  status = 'review',
  reviewed_at = now(),
  reviewed_by = '10000000-0000-0000-0000-000000000151'
where id = '74000000-0000-0000-0000-000000000154';
update public.payout_periods
set status = 'closed', closed_at = now()
where id = '70000000-0000-0000-0000-000000000154';
update public.payouts
set
  status = 'carried_forward',
  carry_out_minor = 500,
  final_payout_minor = 0,
  minimum_payout_minor_snapshot = 10000,
  payout_frequency_days_snapshot = 14,
  calculation_finalized_at = now(),
  calculation_finalized_by = '10000000-0000-0000-0000-000000000151',
  reconciliation_run_id = '76000000-0000-0000-0000-000000000154'
where id = '74000000-0000-0000-0000-000000000154';

select set_config(
  'test.confirmed_affiliate_id',
  (
    select affiliate.id::text
    from public.affiliates as affiliate
    where affiliate.slug = 'partner-110000000000000000000000'
  ),
  true
);
select set_config(
  'test.confirmed_affiliate_registered_at',
  (
    select affiliate.created_at::text
    from public.affiliates as affiliate
    where affiliate.slug = 'partner-110000000000000000000000'
  ),
  true
);
select set_config(
  'test.pending_affiliate_id',
  (
    select affiliate.id::text
    from public.affiliates as affiliate
    where affiliate.slug = 'partner-120000000000000000000000'
  ),
  true
);

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$select public.get_admin_affiliate_directory('{}'::jsonb)$$,
  '42501', null,
  'anonymous callers cannot execute the affiliate directory'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000151', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000151","role":"authenticated","email":"affiliate-owner@example.test","amr":[{"method":"password","timestamp":1788220000}]}',
  true
);

select is(
  (public.get_admin_affiliate_summary() ->> 'total_count')::bigint,
  8::bigint,
  'the summary counts every provisioned and legacy partner workspace'
);
select is(
  (public.get_admin_affiliate_summary() ->> 'pending_confirmation_count')::bigint,
  1::bigint,
  'the summary distinguishes pending email confirmation'
);
select is(
  (public.get_admin_affiliate_summary() ->> 'pending_activation_count')::bigint,
  3::bigint,
  'the summary counts public and invited pending activations'
);
select is(
  (public.get_admin_affiliate_directory('{}'::jsonb) ->> 'total_count')::bigint,
  8::bigint,
  'the unfiltered directory returns the authoritative total'
);
select is(
  jsonb_array_length(public.get_admin_affiliate_directory('{}'::jsonb) -> 'items'),
  8,
  'the default page contains every small test fixture'
);

select is(
  public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
    ->> 'primary_email',
  'lifecycle@example.test',
  'the active owner outranks an older former owner as the primary contact'
);
select is(
  public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000152')
    ->> 'primary_email',
  'invited@example.test',
  'a pending owner outranks an older inactive former owner as the primary contact'
);
select is(
  public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
    -> 'audience_countries',
  '["NG", "US"]'::jsonb,
  'protected rows trim and remove blank legacy audience-country entries'
);
select is(
  public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
    -> 'channels',
  '["TikTok", "YouTube"]'::jsonb,
  'protected rows trim and remove blank legacy channel entries'
);
select is(
  public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
    ->> 'registration_kind',
  'legacy',
  'a manually provisioned workspace is identified as legacy'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'product_count'
  )::bigint,
  2::bigint,
  'product count deduplicates products across agreement and link history'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'agreement_count'
  )::bigint,
  2::bigint,
  'agreement count includes every versioned agreement row'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'active_agreement_count'
  )::bigint,
  1::bigint,
  'active agreement count remains separate from agreement history'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'blocking_agreement_count'
  )::bigint,
  1::bigint,
  'an active agreement is visible as a termination blocker'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000154')
      ->> 'blocking_agreement_count'
  )::bigint,
  1::bigint,
  'an awaiting-signature agreement is visible as a termination blocker'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'blocking_document_count'
  )::bigint,
  1::bigint,
  'only current agreement-backed legal documents count as termination blockers'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'link_count'
  )::bigint,
  2::bigint,
  'link count includes active and archived link history'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'active_link_count'
  )::bigint,
  1::bigint,
  'active link count reflects record-level link state'
);
select is(
  public.get_admin_affiliate_detail(
    current_setting('test.confirmed_affiliate_id')::uuid
  ) ->> 'registration_kind',
  'public',
  'immutable acceptance evidence identifies a public registration'
);
select is(
  (
    public.get_admin_affiliate_detail(
      current_setting('test.confirmed_affiliate_id')::uuid
    ) ->> 'registered_at'
  )::timestamptz,
  current_setting('test.confirmed_affiliate_registered_at')::timestamptz,
  'registration time is the workspace creation timestamp, not the older Auth account timestamp'
);
select is(
  public.get_admin_affiliate_detail(
    current_setting('test.confirmed_affiliate_id')::uuid
  ) ->> 'email_confirmation_status',
  'confirmed',
  'the directory exposes only the confirmation lifecycle state'
);
select is(
  public.get_admin_affiliate_detail(
    current_setting('test.confirmed_affiliate_id')::uuid
  ) ->> 'activation_status',
  'pending',
  'a confirmed public registration remains pending until activation completes'
);
select is(
  public.get_admin_affiliate_detail(
    current_setting('test.confirmed_affiliate_id')::uuid
  ) ->> 'terms_version',
  '2026-07-13',
  'the protected detail returns the exact accepted terms version'
);
select ok(
  not (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ?| array['encrypted_password', 'raw_user_meta_data', 'raw_app_meta_data']
  ),
  'admin affiliate records never expose authentication secrets or raw metadata'
);

select is(
  (public.get_admin_affiliate_directory('{"query":"LIFECYCLE@EXAMPLE.TEST"}'::jsonb)
    ->> 'total_count')::bigint,
  1::bigint,
  'directory search is case-insensitive across the primary email'
);
select is(
  (public.get_admin_affiliate_directory('{"query":"%"}'::jsonb)
    ->> 'total_count')::bigint,
  0::bigint,
  'directory search treats SQL wildcard characters as literals'
);
select is(
  (public.get_admin_affiliate_directory('{"status":"draft"}'::jsonb)
    ->> 'total_count')::bigint,
  1::bigint,
  'status filtering is server-authoritative'
);
select is(
  (public.get_admin_affiliate_directory('{"confirmation_status":"pending"}'::jsonb)
    ->> 'total_count')::bigint,
  1::bigint,
  'confirmation filtering distinguishes unconfirmed accounts'
);
select is(
  (public.get_admin_affiliate_directory('{"activation_status":"missing"}'::jsonb)
    ->> 'total_count')::bigint,
  3::bigint,
  'activation filtering identifies workspaces without a primary user'
);
select is(
  jsonb_array_length(
    public.get_admin_affiliate_directory(
      '{"sort":"name","limit":1,"offset":1}'::jsonb
    ) -> 'items'
  ),
  1,
  'bounded pagination returns the requested page size'
);
select is(
  (
    public.get_admin_affiliate_directory(
      '{"sort":"name","limit":1,"offset":1}'::jsonb
    ) ->> 'total_count'
  )::bigint,
  8::bigint,
  'pagination retains the pre-page filtered total'
);

select throws_ok(
  $$select public.get_admin_affiliate_directory('[]'::jsonb)$$,
  '22023', 'partner-directory input contains unsupported fields',
  'directory input must be an object'
);
select throws_ok(
  $$select public.get_admin_affiliate_directory('{"unexpected":true}'::jsonb)$$,
  '22023', 'partner-directory input contains unsupported fields',
  'directory input rejects unsupported keys'
);
select throws_ok(
  $$select public.get_admin_affiliate_directory('{"status":"disabled"}'::jsonb)$$,
  '22023', 'partner-directory status is invalid',
  'directory input rejects unsupported affiliate status values'
);
select throws_ok(
  $$select public.get_admin_affiliate_directory('{"limit":999999999999999999999999999999}'::jsonb)$$,
  '22023', 'partner-directory limit is invalid',
  'directory input rejects enormous pagination values without an integer overflow leak'
);
select throws_ok(
  $$select public.get_admin_affiliate_directory('{"offset":-1}'::jsonb)$$,
  '22023', 'partner-directory offset is invalid',
  'directory input rejects negative offsets'
);
select throws_ok(
  $$select public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000199')$$,
  'P0002', 'partner not found',
  'detail lookup distinguishes a missing partner without exposing table details'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000153', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000153","role":"authenticated","amr":[{"method":"password","timestamp":1788220001}]}',
  true
);
select throws_ok(
  $$select public.get_admin_affiliate_directory('{}'::jsonb)$$,
  '42501', 'admin role cannot view the partner directory',
  'support cannot read registration email and legal evidence'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000154', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000154","role":"authenticated","amr":[{"method":"password","timestamp":1788220002}]}',
  true
);
select throws_ok(
  $$select public.get_admin_affiliate_summary()$$,
  '42501', 'admin role cannot view the partner directory',
  'finance cannot read the protected lifecycle directory'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000155', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000155","role":"authenticated","amr":[{"method":"password","timestamp":1788220003}]}',
  true
);
select throws_ok(
  $$select public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')$$,
  '42501', 'admin role cannot view partner details',
  'analyst cannot read protected registration details'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000156', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000156","role":"authenticated","amr":[{"method":"password","timestamp":1788220004}]}',
  true
);
select throws_ok(
  $$select public.get_admin_affiliate_directory('{}'::jsonb)$$,
  '42501', 'admin role cannot view the partner directory',
  'ordinary authenticated users cannot read the directory'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000157', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000157","role":"authenticated","amr":[{"method":"password","timestamp":1788220005}]}',
  true
);
select throws_ok(
  $$select public.get_admin_affiliate_directory('{}'::jsonb)$$,
  '42501', 'admin role cannot view the partner directory',
  'inactive owners cannot read the directory'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000152', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000152","role":"authenticated","amr":[{"method":"totp","timestamp":1788220006}]}',
  true
);
select throws_ok(
  $$select public.set_admin_affiliate_status('{"affiliate_id":"30000000-0000-0000-0000-000000000151","status":"paused","reason":"Temporary compliance review"}'::jsonb)$$,
  '42501', 'Change Partner Status requires a password-authenticated session',
  'operations must prove password authentication before changing lifecycle state'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000152","role":"authenticated","amr":[{"method":"password","timestamp":1788220007}]}',
  true
);
select throws_ok(
  $$select public.set_admin_affiliate_status('{"affiliate_id":"30000000-0000-0000-0000-000000000151","status":"paused","reason":"short"}'::jsonb)$$,
  '22023', 'partner-status reason must contain between 10 and 500 characters',
  'pause requires a meaningful immutable reason'
);
select throws_ok(
  $$select public.set_admin_affiliate_status('{"affiliate_id":"30000000-0000-0000-0000-000000000154","status":"paused","reason":"Closing an incomplete draft"}'::jsonb)$$,
  '55000', 'partner cannot move from draft to paused',
  'pause accepts only an active partner'
);

reset role;
update public.affiliates
set status = 'paused'
where id = '30000000-0000-0000-0000-000000000152';

set local role authenticated;
select throws_ok(
  $$select public.set_admin_affiliate_status('{"affiliate_id":"30000000-0000-0000-0000-000000000152","status":"active","reason":"Attempting unsafe reactivation"}'::jsonb)$$,
  '55000', 'partner reactivation requires an active owner membership',
  'reactivation refuses a workspace whose owner activation is still pending'
);
select is(
  public.set_admin_affiliate_status(
    '{"affiliate_id":"30000000-0000-0000-0000-000000000151","status":"paused","reason":"Temporary compliance review"}'::jsonb
  ) ->> 'status',
  'paused',
  'operations can pause an active partner'
);

reset role;
select ok(
  (
    select membership.active and not membership.activation_pending
    from public.affiliate_users as membership
    where membership.affiliate_id = '30000000-0000-0000-0000-000000000151'
      and membership.user_id = '10000000-0000-0000-0000-000000000161'
  ),
  'pause preserves the activated membership for historical access'
);
select is(
  (select link.status from public.affiliate_links as link
   where link.id = '60000000-0000-0000-0000-000000000151'),
  'active'::public.link_status,
  'pause leaves link row state intact behind the global affiliate gate'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000161', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000161","role":"authenticated","amr":[{"method":"password","timestamp":1788220008}]}',
  true
);
select ok(
  public.current_user_has_affiliate('30000000-0000-0000-0000-000000000151'),
  'paused partners retain historical workspace authorization'
);
select ok(
  not public.current_user_has_affiliate_role(
    '30000000-0000-0000-0000-000000000151',
    array['owner']::text[],
    true
  ),
  'paused partners fail active-workspace mutation authorization'
);
select is(
  (select count(*) from public.partner_profile),
  1::bigint,
  'paused partner history remains readable through its allowlist view'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000152', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000152","role":"authenticated","amr":[{"method":"password","timestamp":1788220009}]}',
  true
);
select is(
  public.set_admin_affiliate_status(
    '{"affiliate_id":"30000000-0000-0000-0000-000000000151","status":"active","reason":"Compliance review completed"}'::jsonb
  ) ->> 'status',
  'active',
  'operations can reactivate a paused partner with an active owner'
);
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Operations cannot terminate","confirmation":"lifecycle-partner"}'::jsonb)$$,
  '42501', 'admin role cannot terminate partners',
  'operations cannot terminate a partner'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000151', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000151","role":"authenticated","amr":[{"method":"password","timestamp":1788220010}]}',
  true
);
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Owner confirmed termination","confirmation":"wrong-partner"}'::jsonb)$$,
  '22023', 'partner termination confirmation does not match the partner slug',
  'termination requires exact typed partner confirmation'
);
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Owner confirmed termination","confirmation":"lifecycle-partner"}'::jsonb)$$,
  '55000', 'partner termination requires every active or awaiting-signature agreement to be resolved',
  'an effective commercial agreement blocks termination'
);
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000154","reason":"Owner confirmed termination","confirmation":"workspace-without-owner"}'::jsonb)$$,
  '55000', 'partner termination requires every active or awaiting-signature agreement to be resolved',
  'an awaiting-signature commercial agreement blocks termination'
);
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000153","reason":"Owner confirmed termination","confirmation":"payout-blocker"}'::jsonb)$$,
  '55000', 'partner termination requires every unsettled payout to be resolved',
  'an open payout obligation blocks termination'
);
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000155","reason":"Owner confirmed termination","confirmation":"carry-forward-blocker"}'::jsonb)$$,
  '55000', 'partner termination requires every unsettled payout to be resolved',
  'an unconsumed nonzero carry-forward obligation blocks termination'
);
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000156","reason":"Owner confirmed termination","confirmation":"unmaterialized-ledger-blocker"}'::jsonb)$$,
  '55000', 'partner termination requires every unsettled payout to be resolved',
  'a commission-ledger group without a matching payout blocks termination'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000153')
      ->> 'unsettled_payout_count'
  )::bigint,
  1::bigint,
  'the protected detail exposes the unresolved payout count without payout values'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000155')
      ->> 'unsettled_payout_count'
  )::bigint,
  1::bigint,
  'the obligation count includes an unconsumed nonzero carried-forward payout'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000156')
      ->> 'unsettled_payout_count'
  )::bigint,
  1::bigint,
  'the obligation count includes one ledger group awaiting payout materialization'
);

reset role;
update public.agreements
set status = 'terminated', ends_at = now()
where id = '40000000-0000-0000-0000-000000000151';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000151', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000151","role":"authenticated","amr":[{"method":"password","timestamp":1788220011}]}',
  true
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'blocking_agreement_count'
  )::bigint,
  0::bigint,
  'resolved commercial agreements clear the agreement blocker count'
);
select is(
  (
    public.get_admin_affiliate_detail('30000000-0000-0000-0000-000000000151')
      ->> 'blocking_document_count'
  )::bigint,
  1::bigint,
  'the current agreement document remains a distinct blocker after agreement resolution'
);
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Owner confirmed final termination","confirmation":"lifecycle-partner"}'::jsonb)$$,
  '55000', 'partner termination requires every current agreement document to be resolved',
  'an active agreement-backed legal document blocks termination independently'
);

reset role;
update public.documents
set status = 'awaiting_partner_signature'
where id = '71000000-0000-0000-0000-000000000151';

set local role authenticated;
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Owner confirmed final termination","confirmation":"lifecycle-partner"}'::jsonb)$$,
  '55000', 'partner termination requires every current agreement document to be resolved',
  'an agreement document awaiting the partner signature blocks termination'
);

reset role;
update public.documents
set status = 'awaiting_kissmyapps_signature'
where id = '71000000-0000-0000-0000-000000000151';

set local role authenticated;
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Owner confirmed final termination","confirmation":"lifecycle-partner"}'::jsonb)$$,
  '55000', 'partner termination requires every current agreement document to be resolved',
  'an agreement document awaiting the KissMyApps signature blocks termination'
);

reset role;
update public.documents
set status = 'signed'
where id = '71000000-0000-0000-0000-000000000151';

set local role authenticated;
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Owner confirmed final termination","confirmation":"lifecycle-partner"}'::jsonb)$$,
  '55000', 'partner termination requires every current agreement document to be resolved',
  'a signed agreement document blocks termination until it is resolved'
);

reset role;
update public.documents
set status = 'terminated', terminated_at = now()
where id = '71000000-0000-0000-0000-000000000151';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000151', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000151","role":"authenticated","amr":[{"method":"password","timestamp":1788220011}]}',
  true
);
select is(
  public.terminate_admin_affiliate(
    '{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Owner confirmed final termination","confirmation":"lifecycle-partner"}'::jsonb
  ) ->> 'status',
  'terminated',
  'an owner can terminate after legal and financial blockers are resolved'
);

reset role;
select throws_ok(
  $$update public.agreements set status = 'active' where id = '40000000-0000-0000-0000-000000000152'$$,
  '55000', 'agreement activation requires an active partner',
  'a retained draft agreement cannot activate after its partner is terminated'
);
select ok(
  (
    select not membership.active
      and not membership.activation_pending
      and membership.activated_at is not null
    from public.affiliate_users as membership
    where membership.affiliate_id = '30000000-0000-0000-0000-000000000151'
      and membership.user_id = '10000000-0000-0000-0000-000000000161'
  ),
  'termination disables access while preserving activation history'
);
select is(
  (select link.status from public.affiliate_links as link
   where link.id = '60000000-0000-0000-0000-000000000151'),
  'paused'::public.link_status,
  'termination explicitly pauses every active link'
);
select is(
  (select link.status from public.affiliate_links as link
   where link.id = '60000000-0000-0000-0000-000000000152'),
  'archived'::public.link_status,
  'termination preserves archived link history'
);
select is(
  (
    select audit.reason
    from public.audit_logs as audit
    where audit.action = 'affiliate.terminate'
      and audit.target_id = '30000000-0000-0000-0000-000000000151'
  ),
  'Owner confirmed final termination',
  'semantic termination audit retains the required operator reason'
);
select ok(
  (
    select audit.actor_user_id = '10000000-0000-0000-0000-000000000151'::uuid
      and audit.actor_type = 'admin'
      and audit.before_data ->> 'status' = 'active'
      and audit.after_data ->> 'status' = 'terminated'
      and (audit.metadata ->> 'memberships_disabled')::integer = 1
      and (audit.metadata ->> 'links_paused')::integer = 1
      and not (audit.metadata ? 'email')
    from public.audit_logs as audit
    where audit.action = 'affiliate.terminate'
      and audit.target_id = '30000000-0000-0000-0000-000000000151'
  ),
  'semantic audit records actor, transition, bounded effects, and no contact data'
);
select is(
  (
    select audit.reason
    from public.audit_logs as audit
    where audit.action = 'affiliate.pause'
      and audit.target_id = '30000000-0000-0000-0000-000000000151'
  ),
  'Temporary compliance review',
  'pause records its immutable reason separately from the generic row audit'
);
select is(
  (
    select audit.reason
    from public.audit_logs as audit
    where audit.action = 'affiliate.reactivate'
      and audit.target_id = '30000000-0000-0000-0000-000000000151'
  ),
  'Compliance review completed',
  'reactivation records its immutable reason separately from the generic row audit'
);

set local role authenticated;
select throws_ok(
  $$select public.terminate_admin_affiliate('{"affiliate_id":"30000000-0000-0000-0000-000000000151","reason":"Repeated termination attempt","confirmation":"lifecycle-partner"}'::jsonb)$$,
  '55000', 'terminated partners cannot be changed',
  'termination is irreversible and cannot be repeated'
);
select throws_ok(
  $$select public.set_admin_affiliate_status('{"affiliate_id":"30000000-0000-0000-0000-000000000151","status":"active","reason":"Improper reactivation attempt"}'::jsonb)$$,
  '55000', 'partner cannot move from terminated to active',
  'terminated partners cannot reactivate through the pause lifecycle RPC'
);

select is(
  public.terminate_admin_affiliate(
    jsonb_build_object(
      'affiliate_id', (
        current_setting('test.pending_affiliate_id')
      ),
      'reason', 'Rejected pending registration',
      'confirmation', 'partner-120000000000000000000000'
    )
  ) ->> 'status',
  'terminated',
  'an owner can reject a pending public registration without activating it'
);

reset role;
select ok(
  (
    select not membership.active and not membership.activation_pending
    from public.affiliate_users as membership
    join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
    where affiliate.slug = 'partner-120000000000000000000000'
  ),
  'pending-registration termination permanently closes activation state'
);
select is(
  (
    select count(*)
    from public.platform_legal_acceptances as acceptance
    join public.affiliates as affiliate on affiliate.id = acceptance.affiliate_id
    where affiliate.slug = 'partner-120000000000000000000000'
  ),
  1::bigint,
  'termination retains immutable registration acceptance evidence'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000161', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000161","role":"authenticated","amr":[{"method":"password","timestamp":1788220012}]}',
  true
);
select is(
  public.current_partner_activation_status(),
  'none',
  'terminated memberships no longer report active activation state'
);
select is(
  (select count(*) from public.partner_profile),
  0::bigint,
  'terminated users cannot read the former partner workspace'
);

reset role;
select throws_ok(
  $$delete from public.audit_logs where action = 'affiliate.terminate'$$,
  'P0001', 'audit_logs is append-only',
  'affiliate lifecycle audit evidence remains append-only'
);

select * from finish();
rollback;
