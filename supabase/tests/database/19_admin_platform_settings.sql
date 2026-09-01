begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function(
  'public', 'get_admin_platform_settings', array[]::text[],
  'Admin Platform Settings read RPC exists'
);
select has_function(
  'public', 'platform_tracking_enablement_ready', array['text'],
  'internal tracking enablement predicate exists'
);
select has_function(
  'public', 'enforce_platform_tracking_fail_closed', array[]::text[],
  'upgrade fail-closed enforcement helper exists'
);
select has_function(
  'public', 'set_platform_settings_updated_at', array[]::text[],
  'monotonic Platform Settings timestamp trigger function exists'
);
select has_trigger(
  'public', 'platform_settings', 'platform_settings_set_updated_at',
  'Platform Settings has a dedicated monotonic timestamp trigger'
);

select ok(
  (
    select function.prosecdef and function.provolatile = 's'
    from pg_catalog.pg_proc as function
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.proname = 'get_admin_platform_settings'
      and function.pronargs = 0
  ),
  'Platform Settings is a stable SECURITY DEFINER read'
);

select ok(
  has_function_privilege(
    'authenticated', 'public.get_admin_platform_settings()', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.get_admin_platform_settings()', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.get_admin_platform_settings()', 'EXECUTE'
  )
  and not has_function_privilege(
    'public', 'public.get_admin_platform_settings()', 'EXECUTE'
  ),
  'only authenticated browser sessions receive the settings read grant'
);

select ok(
  not has_function_privilege(
    'authenticated', 'public.platform_tracking_enablement_ready(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.platform_tracking_enablement_ready(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.enforce_platform_tracking_fail_closed()', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.enforce_platform_tracking_fail_closed()', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.set_platform_settings_updated_at()', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.set_platform_settings_updated_at()', 'EXECUTE'
  ),
  'internal readiness, upgrade, and timestamp helpers are not API-callable'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000191',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'settings-owner@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000192',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'settings-operations@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000193',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'settings-finance@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000194',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'settings-analyst@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000195',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'settings-support@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000196',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'settings-ordinary@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000197',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'settings-inactive@example.test', '',
    now(), '{}', '{}', now(), now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000191', 'owner', true),
  ('10000000-0000-0000-0000-000000000192', 'operations', true),
  ('10000000-0000-0000-0000-000000000193', 'finance', true),
  ('10000000-0000-0000-0000-000000000194', 'analyst', true),
  ('10000000-0000-0000-0000-000000000195', 'support', true),
  ('10000000-0000-0000-0000-000000000197', 'owner', false);

delete from public.platform_settings;

insert into public.platform_settings (
  singleton, tracking_base_url, tracking_enabled, updated_at
)
values (
  true,
  'https://go.kissmyapps.dev',
  true,
  now() - interval '1 day'
);
select ok(
  public.enforce_platform_tracking_fail_closed(),
  'upgrade enforcement changes an unsafe legacy enabled singleton'
);
select is(
  (select tracking_enabled from public.platform_settings where singleton),
  false,
  'upgrade enforcement disables legacy tracking without a correlated launch chain'
);
select ok(
  (
    select updated_at > now() - interval '1 day'
    from public.platform_settings
    where singleton
  ),
  'upgrade enforcement advances the optimistic concurrency token'
);
delete from public.platform_settings;

insert into public.platform_settings (
  singleton, tracking_base_url, tracking_enabled, updated_at
)
values (
  true,
  'https://legacy.kissmyapps.dev',
  false,
  now() - interval '1 day'
);
select ok(
  public.enforce_platform_tracking_fail_closed(),
  'upgrade enforcement changes a legacy disabled noncanonical singleton'
);
select is(
  (select tracking_base_url from public.platform_settings where singleton),
  null,
  'upgrade enforcement clears a legacy noncanonical tracking origin'
);
select is(
  (select tracking_enabled from public.platform_settings where singleton),
  false,
  'normalizing a legacy origin keeps the tracking kill switch disabled'
);
delete from public.platform_settings;

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$ select public.get_admin_platform_settings() $$,
  '42501', null,
  'anonymous callers cannot execute Platform Settings'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000191', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000191","role":"authenticated"}',
  true
);

select lives_ok(
  $$ select public.get_admin_platform_settings() $$,
  'Owner can read Platform Settings'
);
select is(
  public.get_admin_platform_settings() #> '{tracking,base_url}', 'null'::jsonb,
  'missing singleton returns a null tracking origin'
);
select is(
  public.get_admin_platform_settings() #> '{tracking,updated_at}', 'null'::jsonb,
  'missing singleton returns a null settings timestamp'
);
select is(
  public.get_admin_platform_settings() #>> '{tracking,enabled}', 'false',
  'missing singleton fails closed with tracking disabled'
);
select is(
  public.get_admin_platform_settings() #>> '{expected_hosts,partner}',
  'https://partners.kissmyapps.dev',
  'Partner host is the explicit public production constant'
);
select is(
  public.get_admin_platform_settings() #>> '{expected_hosts,admin}',
  'https://admin.kissmyapps.dev',
  'Admin host is the explicit public production constant'
);
select is(
  public.get_admin_platform_settings() #>> '{expected_hosts,tracking}',
  'https://go.kissmyapps.dev',
  'tracking host is the explicit public production constant'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,active_product_count}')::bigint,
  0::bigint,
  'an empty catalog reports zero active products'
);
select is(
  public.get_admin_platform_settings() #>> '{readiness,can_enable}', 'false',
  'tracking cannot be enabled for an empty catalog'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000192', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000192","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select lives_ok(
  $$ select public.get_admin_platform_settings() $$,
  'Operations can read Platform Settings'
);
select throws_ok(
  $$ select public.configure_admin_tracking('{"base_url":"https://go.kissmyapps.dev","enabled":false,"expected_updated_at":null}'::jsonb) $$,
  '42501', 'admin role cannot configure tracking',
  'Operations cannot mutate the Owner-only tracking settings'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000193', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000193","role":"authenticated"}',
  true
);
select lives_ok(
  $$ select public.get_admin_platform_settings() $$,
  'Finance can read Platform Settings'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000194', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000194","role":"authenticated"}',
  true
);
select lives_ok(
  $$ select public.get_admin_platform_settings() $$,
  'Analyst can read Platform Settings'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000195', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000195","role":"authenticated"}',
  true
);
select throws_ok(
  $$ select public.get_admin_platform_settings() $$,
  '42501', 'admin role cannot view platform settings',
  'Support cannot read Platform Settings'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000196', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000196","role":"authenticated"}',
  true
);
select throws_ok(
  $$ select public.get_admin_platform_settings() $$,
  '42501', 'admin role cannot view platform settings',
  'an ordinary authenticated user cannot read Platform Settings'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000197', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000197","role":"authenticated"}',
  true
);
select throws_ok(
  $$ select public.get_admin_platform_settings() $$,
  '42501', 'admin role cannot view platform settings',
  'an inactive administrator cannot read Platform Settings'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000191', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000191","role":"authenticated","amr":[{"method":"totp"}]}',
  true
);
select throws_ok(
  $$ select public.configure_admin_tracking('{"base_url":"https://go.kissmyapps.dev","enabled":false,"expected_updated_at":null}'::jsonb) $$,
  '42501', 'Configure Tracking requires a password-authenticated session',
  'tracking mutation requires a password-authenticated Owner session'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000191","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select throws_ok(
  $$ select public.configure_admin_tracking('{"base_url":"https://go.kissmyapps.dev","enabled":true,"expected_updated_at":null}'::jsonb) $$,
  'P0001',
  'tracking activation requires the canonical origin, an active product with a live default HTTPS funnel, launch-ready agreement, active live-verified subscription offer, and canonical non-archived main links',
  'server guard rejects enabling an empty catalog'
);

select is(
  public.configure_admin_tracking(
    '{"base_url":"https://go.kissmyapps.dev","enabled":false,"expected_updated_at":null}'::jsonb
  ) #>> '{tracking,base_url}',
  'https://go.kissmyapps.dev',
  'an Owner can save the production tracking origin while disabled'
);
select is(
  public.get_admin_platform_settings() ->> 'enabled', 'false',
  'the legacy top-level enabled alias remains available'
);
select ok(
  public.get_admin_platform_settings() #>> '{tracking,updated_at}' is not null,
  'a settings mutation records its actual update time'
);

select set_config(
  'test.platform_settings_initial_version',
  public.get_admin_platform_settings() #>> '{tracking,updated_at}',
  true
);

select throws_ok(
  $$
    select public.configure_admin_tracking(
      jsonb_build_object(
        'base_url', 'https://tracking.kissmyapps.dev',
        'enabled', false,
        'expected_updated_at', current_setting('test.platform_settings_initial_version')
      )
    )
  $$,
  '22023', 'tracking base URL must equal https://go.kissmyapps.dev',
  'the server rejects a noncanonical production-looking tracking origin'
);
select throws_ok(
  $$ select public.configure_admin_tracking('{"base_url":"https://go.kissmyapps.dev","enabled":false}'::jsonb) $$,
  '22023',
  'tracking input must contain exactly base_url, enabled, and expected_updated_at',
  'tracking mutation requires an explicit optimistic concurrency token'
);
select is(
  public.configure_admin_tracking(
    jsonb_build_object(
      'base_url', 'https://go.kissmyapps.dev',
      'enabled', false,
      'expected_updated_at', current_setting('test.platform_settings_initial_version')
    )
  ) #>> '{tracking,enabled}',
  'false',
  'a matching concurrency token permits a same-origin save'
);
select set_config(
  'test.platform_settings_after_save_version',
  public.get_admin_platform_settings() #>> '{tracking,updated_at}',
  true
);
select ok(
  current_setting('test.platform_settings_after_save_version')::timestamptz
    > current_setting('test.platform_settings_initial_version')::timestamptz,
  'every successful settings write advances the concurrency token'
);
select throws_ok(
  $$
    select public.configure_admin_tracking(
      jsonb_build_object(
        'base_url', 'https://go.kissmyapps.dev',
        'enabled', false,
        'expected_updated_at', current_setting('test.platform_settings_initial_version')
      )
    )
  $$,
  '40001', 'platform settings changed; reload before saving',
  'a stale concurrency token cannot overwrite a newer settings version'
);
select throws_ok(
  $$ select public.configure_admin_tracking('{"base_url":"https://go.kissmyapps.dev","enabled":false,"expected_updated_at":null}'::jsonb) $$,
  '40001', 'platform settings changed; reload before saving',
  'the absent-row token cannot overwrite an existing singleton'
);

reset role;

insert into public.products (id, slug, name, status)
values (
  '20000000-0000-0000-0000-000000000191',
  'settings-launch-product', 'Settings Launch Product', 'draft'
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values (
  '50000000-0000-0000-0000-000000000191',
  '20000000-0000-0000-0000-000000000191',
  'primary', 'Primary Funnel', 'https://funnel.kissmyapps.dev/start', 'live', true
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000191', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000191","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select is(
  public.activate_admin_product(
    '{"product_id":"20000000-0000-0000-0000-000000000191"}'::jsonb
  ) ->> 'status',
  'active',
  'a product can activate against a configured origin while tracking stays disabled'
);
select is(
  public.get_admin_platform_settings() #>> '{tracking,enabled}', 'false',
  'product activation does not silently enable tracking'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,active_product_count}')::bigint,
  1::bigint,
  'active product count reflects the real catalog'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,live_default_funnel_count}')::bigint,
  1::bigint,
  'live default funnel count reflects the real catalog'
);
select is(
  public.get_admin_platform_settings() #>> '{readiness,can_enable}', 'false',
  'a product and funnel alone are insufficient to enable tracking'
);
select throws_ok(
  $$
    select public.configure_admin_tracking(
      jsonb_build_object(
        'base_url', 'https://go.kissmyapps.dev',
        'enabled', true,
        'expected_updated_at', public.get_admin_platform_settings() #>> '{tracking,updated_at}'
      )
    )
  $$,
  'P0001',
  'tracking activation requires the canonical origin, an active product with a live default HTTPS funnel, launch-ready agreement, active live-verified subscription offer, and canonical non-archived main links',
  'server guard still requires commercial readiness'
);

reset role;

insert into public.affiliates (id, public_name, slug, status)
values (
  '30000000-0000-0000-0000-000000000191',
  'Settings Launch Partner', 'settings-launch-partner', 'active'
);

insert into public.agreements (
  id, affiliate_id, product_id, version, model, status,
  payout_currency, starts_at
)
values (
  '40000000-0000-0000-0000-000000000191',
  '30000000-0000-0000-0000-000000000191',
  '20000000-0000-0000-0000-000000000191',
  1, 'cpa', 'draft', 'USD', now() - interval '1 day'
);

insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values (
  '41000000-0000-0000-0000-000000000191',
  '40000000-0000-0000-0000-000000000191',
  'Paid purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD'
);

insert into public.documents (
  id, affiliate_id, agreement_id, name, document_type, version, file_path, status,
  effective_at, signed_by_partner_at, signed_by_kissmyapps_at
)
values (
  '42000000-0000-0000-0000-000000000191',
  '30000000-0000-0000-0000-000000000191',
  '40000000-0000-0000-0000-000000000191',
  'Signed affiliate agreement', 'affiliate_agreement', 1,
  '30000000-0000-0000-0000-000000000191/private-settings-secret.pdf',
  'active', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'
);

update public.agreements
set status = 'active'
where id = '40000000-0000-0000-0000-000000000191';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000191', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000191","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,launch_ready_agreement_count}')::bigint,
  1::bigint,
  'bilaterally signed commercial terms count as launch-ready'
);
select is(
  public.get_admin_platform_settings() #>> '{readiness,can_enable}', 'false',
  'a verified active subscription offer is still required'
);

reset role;

insert into public.billing_offers (
  id, product_id, key, version, name, billing_mode, stripe_price_id, currency,
  unit_amount_minor, success_url_template, cancel_url, status,
  verified_stripe_price_id, verified_currency, verified_unit_amount_minor,
  verified_billing_mode, stripe_livemode_verified_at
)
values (
  '43000000-0000-0000-0000-000000000191',
  '20000000-0000-0000-0000-000000000191',
  'monthly', 1, 'Monthly subscription', 'subscription',
  'price_SettingsLaunch191', 'USD', 1999,
  'https://funnel.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
  'https://funnel.kissmyapps.dev/cancel', 'active',
  'price_SettingsLaunch191', 'USD', 1999, 'subscription', now()
);

set local session_replication_role = replica;
insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
  is_main, status, created_by
)
values (
  '44000000-0000-0000-0000-000000000191',
  '30000000-0000-0000-0000-000000000191',
  '20000000-0000-0000-0000-000000000191',
  '50000000-0000-0000-0000-000000000191',
  'Legacy noncanonical main link', 'legacysettings191',
  'https://legacy.kissmyapps.dev/r/settings-launch-partner/legacysettings191',
  true, 'paused', '10000000-0000-0000-0000-000000000191'
);
set local session_replication_role = origin;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000191', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000191","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,verified_active_offer_count}')::bigint,
  1::bigint,
  'only an active live-verified subscription offer counts'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,enable_ready_product_count}')::bigint,
  1::bigint,
  'the complete correlated pre-launch product chain is counted once'
);
select is(
  public.get_admin_platform_settings() #>> '{readiness,can_enable}', 'false',
  'a non-archived legacy main link on another origin blocks tracking activation'
);
select throws_ok(
  $$
    select public.configure_admin_tracking(
      jsonb_build_object(
        'base_url', 'https://go.kissmyapps.dev',
        'enabled', true,
        'expected_updated_at', public.get_admin_platform_settings() #>> '{tracking,updated_at}'
      )
    )
  $$,
  'P0001',
  'tracking activation requires the canonical origin, an active product with a live default HTTPS funnel, launch-ready agreement, active live-verified subscription offer, and canonical non-archived main links',
  'server guard rejects a noncanonical existing main-link prefix'
);

reset role;
delete from public.affiliate_links
where id = '44000000-0000-0000-0000-000000000191';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000191', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000191","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select is(
  public.get_admin_platform_settings() #>> '{readiness,can_enable}', 'true',
  'the correlated chain becomes enable-ready after the legacy link is removed'
);
select is(
  public.configure_admin_tracking(
    jsonb_build_object(
      'base_url', 'https://go.kissmyapps.dev',
      'enabled', true,
      'expected_updated_at', public.get_admin_platform_settings() #>> '{tracking,updated_at}'
    )
  ) ->> 'enabled',
  'true',
  'an Owner can enable tracking only after every server-side gate passes'
);

select is(
  public.issue_admin_main_link(
    '{"affiliate_id":"30000000-0000-0000-0000-000000000191","product_id":"20000000-0000-0000-0000-000000000191"}'::jsonb
  ) ->> 'is_main',
  'true',
  'main-link issuance follows safe tracking activation'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,active_main_link_count}')::bigint,
  1::bigint,
  'active main-link readiness is reported as an aggregate count'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,fully_live_product_count}')::bigint,
  1::bigint,
  'a fully correlated enabled product-link chain is reported once'
);

reset role;
set local session_replication_role = replica;
update public.affiliate_links
set tracking_url = 'https://legacy.kissmyapps.dev/r/settings-launch-partner/legacysettings191'
where affiliate_id = '30000000-0000-0000-0000-000000000191'
  and product_id = '20000000-0000-0000-0000-000000000191'
  and is_main
  and status = 'active';
set local session_replication_role = origin;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000191', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000191","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,active_main_link_count}')::bigint,
  1::bigint,
  'an active legacy main link remains visible as inventory'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,fully_live_product_count}')::bigint,
  0::bigint,
  'a main link outside the current canonical prefix is not reported as fully live'
);

select ok(
  position(
    'private-settings-secret.pdf' in public.get_admin_platform_settings()::text
  ) = 0
  and position(
    'price_SettingsLaunch191' in public.get_admin_platform_settings()::text
  ) = 0
  and position(
    'funnel.kissmyapps.dev/start' in public.get_admin_platform_settings()::text
  ) = 0
  and public.get_admin_platform_settings()::text
    !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  'Platform Settings omits secrets, raw identifiers, offer IDs, and funnel destinations'
);

select is(
  public.configure_admin_tracking(
    jsonb_build_object(
      'base_url', 'https://go.kissmyapps.dev',
      'enabled', false,
      'expected_updated_at', public.get_admin_platform_settings() #>> '{tracking,updated_at}'
    )
  ) #>> '{tracking,enabled}',
  'false',
  'an Owner can always use the emergency tracking kill switch'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,active_main_link_count}')::bigint,
  1::bigint,
  'disabling preserves truthful link inventory without deleting history'
);
select is(
  (public.get_admin_platform_settings() #>> '{readiness,fully_live_product_count}')::bigint,
  0::bigint,
  'disabled tracking is never reported as fully live'
);

reset role;
select * from finish();
rollback;
