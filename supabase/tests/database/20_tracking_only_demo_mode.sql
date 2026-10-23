begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_type('public', 'product_tracking_mode', 'product tracking mode enum exists');
select has_column('public', 'products', 'tracking_mode', 'products store an explicit tracking mode');
select has_column('public', 'affiliate_links', 'commercial_eligible', 'links persist commercial scope');
select has_column('public', 'clicks', 'commercial_eligible', 'clicks persist commercial scope');
select has_column('public', 'acquisitions', 'commercial_eligible', 'acquisitions persist commercial scope');
select has_trigger(
  'public', 'checkout_attempts', 'checkout_attempts_00_tracking_scope_guard',
  'checkout attempts enforce immutable attribution scope before session creation'
);
select has_trigger(
  'public', 'conversions', 'conversions_00_tracking_scope_guard',
  'billable conversions require commercial attribution and event scope'
);
select has_trigger(
  'public', 'commission_entries', 'commission_entries_tracking_only_commercial_guard',
  'commission ledger rejects tracking-only products'
);
select has_trigger(
  'public', 'payouts', 'payouts_tracking_only_commercial_guard',
  'payout ledger rejects tracking-only products'
);
select has_function(
  'public', 'set_admin_product_tracking_mode', array['jsonb'],
  'Owner tracking-mode mutation exists'
);
select has_function(
  'public', 'tracking_only_product_is_ready', array['uuid'],
  'tracking-only readiness predicate exists'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.set_admin_product_tracking_mode(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.set_admin_product_tracking_mode(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.set_admin_product_tracking_mode(jsonb)', 'EXECUTE'
  ),
  'only authenticated browser sessions receive the mode-mutation grant'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.tracking_only_product_is_ready(uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.tracking_only_product_is_ready(uuid)', 'EXECUTE'
  ),
  'tracking-only readiness remains internal'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tracking-demo-owner@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tracking-demo-operations@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tracking-demo-partner@example.test', '',
    now(), '{}', '{}', now(), now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000201', 'owner', true),
  ('10000000-0000-0000-0000-000000000202', 'operations', true);

insert into public.affiliates (
  id, public_name, slug, reporting_timezone, preferred_currency, status
)
values (
  '30000000-0000-0000-0000-000000000201',
  'Tracking Demo Partner', 'tracking-demo-partner', 'UTC', 'USD', 'active'
);

insert into public.affiliate_users (affiliate_id, user_id, role, active, activation_pending, activated_at)
values (
  '30000000-0000-0000-0000-000000000201',
  '10000000-0000-0000-0000-000000000203',
  'owner', true, false, now()
);

insert into public.products (id, slug, name, status)
values
  (
    '20000000-0000-0000-0000-000000000201',
    'tracking-demo', 'Tracking Demo', 'draft'
  ),
  (
    '20000000-0000-0000-0000-000000000202',
    'commercial-regression', 'Commercial Regression', 'active'
  );

insert into public.agreements (
  id, affiliate_id, product_id, version, model, status
)
values (
  '40000000-0000-0000-0000-000000000202',
  '30000000-0000-0000-0000-000000000201',
  '20000000-0000-0000-0000-000000000202',
  1, 'cpa', 'draft'
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values (
  '50000000-0000-0000-0000-000000000201',
  '20000000-0000-0000-0000-000000000201',
  'demo', 'Demo Funnel', 'https://demo.kissmyapps.dev/start', 'live', true
);

insert into public.sources (id, key, name)
values (
  '51000000-0000-0000-0000-000000000201',
  'tiktok-demo', 'TikTok Demo'
);

insert into public.platform_settings (
  singleton, tracking_base_url, tracking_enabled
)
values (true, 'https://go.kissmyapps.dev', false);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000202', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000202","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select throws_ok(
  $$select public.set_admin_product_tracking_mode(jsonb_build_object(
    'product_id', '20000000-0000-0000-0000-000000000201',
    'mode', 'tracking_only',
    'expected_updated_at', (
      select updated_at from public.get_admin_products()
      where id = '20000000-0000-0000-0000-000000000201'
    )
  ))$$,
  '42501', 'admin role cannot configure product tracking mode',
  'Operations cannot approve tracking-only mode'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000201', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000201","role":"authenticated","amr":[{"method":"password"}]}',
  true
);

select set_config(
  'test.tracking_demo_stale_updated_at',
  (select updated_at::text from public.get_admin_products()
   where id = '20000000-0000-0000-0000-000000000201'),
  true
);

select is(
  public.set_admin_product_tracking_mode(jsonb_build_object(
    'product_id', '20000000-0000-0000-0000-000000000201',
    'mode', 'tracking_only',
    'expected_updated_at', (
      select updated_at from public.get_admin_products()
      where id = '20000000-0000-0000-0000-000000000201'
    )
  )) ->> 'tracking_mode',
  'tracking_only',
  'Owner explicitly approves the current live default public HTTPS funnel'
);

select throws_ok(
  $$select public.set_admin_product_tracking_mode(jsonb_build_object(
    'product_id', '20000000-0000-0000-0000-000000000201',
    'mode', 'tracking_only',
    'expected_updated_at', current_setting('test.tracking_demo_stale_updated_at')
  ))$$,
  '40001', 'product changed; reload before saving',
  'tracking-mode mutation rejects a stale compare-and-swap token'
);

select is(
  (select tracking_mode::text
   from public.create_admin_product(
     '{"name":"RPC Contract Product","slug":"rpc-contract-product"}'::jsonb
   )),
  'commercial',
  'new-product RPC returns the explicit default commercial tracking mode'
);

select is(
  public.get_admin_product_configuration(
    '20000000-0000-0000-0000-000000000201'
  ) #>> '{readiness,tracking_only_ready}',
  'true',
  'product configuration reports the exact approved snapshot ready'
);
select is(
  (select tracking_mode::text from public.get_admin_products()
    where id = '20000000-0000-0000-0000-000000000201'),
  'tracking_only',
  'Admin product directory exposes tracking mode'
);
select ok(
  (select tracking_only_approved_at is not null from public.get_admin_products()
    where id = '20000000-0000-0000-0000-000000000201'),
  'Admin product directory exposes approval time'
);

select is(
  public.activate_admin_product(
    '{"product_id":"20000000-0000-0000-0000-000000000201"}'::jsonb
  ) ->> 'status',
  'active',
  'tracking-only product uses the existing safe product activation boundary'
);

select is(
  public.get_admin_platform_settings()
    #>> '{readiness,tracking_only_ready_product_count}',
  '1',
  'Platform Settings counts a tracking-only-ready product without an agreement or offer'
);
select is(
  public.get_admin_platform_settings()
    #>> '{readiness,commercial_enable_ready_product_count}',
  '0',
  'the tracking-only product is not misclassified as commercially ready'
);
select is(
  public.get_admin_platform_settings() #>> '{readiness,can_enable}',
  'true',
  'the canonical global switch may be enabled by the explicit tracking-only branch'
);

select is(
  public.configure_admin_tracking(jsonb_build_object(
    'base_url', 'https://go.kissmyapps.dev',
    'enabled', true,
    'expected_updated_at',
      public.get_admin_platform_settings() #>> '{tracking,updated_at}'
  )) ->> 'enabled',
  'true',
  'Owner enables the canonical gateway without fake commercial data'
);

select is(
  public.issue_admin_main_link(
    '{"affiliate_id":"30000000-0000-0000-0000-000000000201","product_id":"20000000-0000-0000-0000-000000000201"}'::jsonb
  ) ->> 'commercial_eligible',
  'false',
  'tracking-only main link is permanently noncommercial'
);

reset role;
select throws_ok(
  $$insert into public.agreements (
    affiliate_id, product_id, version, model, status, starts_at
  ) values (
    '30000000-0000-0000-0000-000000000201',
    '20000000-0000-0000-0000-000000000201',
    1, 'cpa', 'draft', now()
  )$$,
  '23514', 'tracking-only products cannot create commercial records',
  'tracking-only product rejects commercial agreement facts'
);
select throws_ok(
  $$insert into public.billing_offers (
    product_id, key, version, name, billing_mode, stripe_price_id, currency,
    unit_amount_minor, success_url_template, cancel_url, status
  ) values (
    '20000000-0000-0000-0000-000000000201',
    'demo-offer', 1, 'Forbidden Demo Offer', 'subscription',
    'price_TrackingDemo201', 'USD', 1000,
    'https://demo.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
    'https://demo.kissmyapps.dev/cancel', 'draft'
  )$$,
  '23514', 'tracking-only products cannot create commercial records',
  'tracking-only product rejects billing offers before checkout can exist'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000203', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000203","role":"authenticated"}',
  true
);

select is(
  (select tracking_mode::text from public.partner_product_directory
    where id = '20000000-0000-0000-0000-000000000201'),
  'tracking_only',
  'Partner product directory labels tracking-only scope'
);
select is(
  (select main_link_commercial_eligible from public.partner_product_directory
    where id = '20000000-0000-0000-0000-000000000201'),
  false,
  'Partner product directory labels the current main link noncommercial'
);
select ok(
  (select main_link_id is not null from public.partner_product_directory
    where id = '20000000-0000-0000-0000-000000000201'),
  'Partner product directory exposes the server-issued current main link ID'
);

select throws_ok(
  $$select * from public.create_partner_link(jsonb_build_object(
    'name', 'Wrong parent',
    'product_id', '20000000-0000-0000-0000-000000000201',
    'funnel_id', '50000000-0000-0000-0000-000000000201',
    'source_id', '51000000-0000-0000-0000-000000000201',
    'campaign_id', null,
    'sub1', 'wrong-parent',
    'sub2', null,
    'sub3', null,
    'parent_link_id', '60000000-0000-0000-0000-000000000299'
  ))$$,
  'P0001', 'tracking-only link requires the current noncommercial main link',
  'a caller cannot attach a demo link to a foreign or invented main parent'
);

select is(
  (select commercial_eligible
    from public.create_partner_link(jsonb_build_object(
      'name', 'TikTok bio',
      'product_id', '20000000-0000-0000-0000-000000000201',
      'funnel_id', '50000000-0000-0000-0000-000000000201',
      'source_id', '51000000-0000-0000-0000-000000000201',
      'campaign_id', null,
      'sub1', 'bio',
      'sub2', null,
      'sub3', null,
      'parent_link_id', null
    ))),
  false,
  'derived source link inherits the current main link noncommercial scope server-side'
);

-- Resolve fixture-only internal routing data outside the partner's allowlisted surface.
reset role;
select set_config(
  'test.tracking_demo_code',
  (select public_code from public.affiliate_links where name = 'TikTok bio'),
  true
);

reset role;
set local role service_role;
select set_config(
  'test.tracking_demo_click',
  (
    select click_id from public.register_tracking_click(
      'tracking-demo-partner', current_setting('test.tracking_demo_code'),
      jsonb_build_object('session_id_hash', repeat('a', 64))
    )
  ),
  true
);

-- Service requests use the RPC; internal fixture assertions run as the database owner.
select throws_ok(
  $$select * from public.clicks$$,
  '42501', 'permission denied for table clicks',
  'service role cannot bypass tracking RPCs with a raw click query'
);
reset role;
select is(
  (select commercial_eligible from public.clicks
    where public_click_id = current_setting('test.tracking_demo_click')),
  false,
  'redirect persists immutable noncommercial click provenance'
);
select is(
  (select acquisition.commercial_eligible
    from public.acquisitions as acquisition
    join public.clicks as click on click.id = acquisition.click_record_id
    where click.public_click_id = current_setting('test.tracking_demo_click')),
  false,
  'redirect propagates immutable noncommercial acquisition provenance'
);
select throws_ok(
  $$update public.clicks
    set commercial_eligible = true
    where public_click_id = current_setting('test.tracking_demo_click')$$,
  'P0001', 'tracking history is append-only outside an approved non-commercial product deletion',
  'a direct table write cannot promote an issued demo click into commercial scope'
);

-- Click history is append-only. Build historical fixture evidence at insertion
-- time instead of rewriting the click that the service RPC just recorded.
-- That current click remains outside the historical reporting window below.
select throws_ok(
  $$update public.clicks set occurred_at = now() - interval '2 days'
    where public_click_id = current_setting('test.tracking_demo_click')$$,
  'P0001', 'tracking history is append-only outside an approved non-commercial product deletion',
  'recorded click time cannot be rewritten to manufacture a reporting window'
);
insert into public.clicks (
  public_click_id, affiliate_link_id, affiliate_id, product_id, source_id,
  campaign_id, funnel_id, sub1, sub2, sub3, destination_url_snapshot,
  session_id_hash, commercial_eligible, occurred_at
)
select fixture.public_click_id, click.affiliate_link_id, click.affiliate_id,
  click.product_id, click.source_id, click.campaign_id, click.funnel_id,
  click.sub1, click.sub2, click.sub3, click.destination_url_snapshot,
  fixture.session_hash, click.commercial_eligible, now() - interval '2 days'
from public.clicks as click
cross join (values
  (repeat('b', 48), repeat('b', 64)),
  (repeat('c', 48), repeat('c', 64))
) as fixture(public_click_id, session_hash)
where click.public_click_id = current_setting('test.tracking_demo_click');
insert into public.acquisitions (
  product_id, affiliate_id, click_record_id, source_id, campaign_id, funnel_id,
  attribution_method, status, commercial_eligible
)
select product_id, affiliate_id, id, source_id, campaign_id, funnel_id,
  'deterministic_web', 'open', commercial_eligible
from public.clicks where public_click_id in (repeat('b', 48), repeat('c', 48));
select set_config('test.tracking_demo_click', repeat('b', 48), true);
select set_config('test.tracking_demo_prior_day_click', repeat('c', 48), true);

set local role service_role;
select lives_ok(
  $$select * from public.ingest_browser_event(jsonb_build_object(
    'event_id', '90000000-0000-0000-0000-000000000201',
    'event_name', 'funnel_started',
    'click_id', current_setting('test.tracking_demo_click'),
    'occurred_at', now() - interval '1 day',
    'properties', '{}'::jsonb
  ))$$,
  'tracking-only browser event is accepted as noncommercial evidence'
);
select lives_ok(
  $$select * from public.ingest_funnel_event(jsonb_build_object(
    'event_id', '90000000-0000-0000-0000-000000000202',
    'event_name', 'demo.server_seen',
    'click_id', current_setting('test.tracking_demo_click'),
    'occurred_at', now() - interval '1 day',
    'properties', '{}'::jsonb
  ))$$,
  'tracking-only funnel event is forced into noncommercial scope'
);
select lives_ok(
  $$select * from public.ingest_funnel_event(jsonb_build_object(
    'event_id', '90000000-0000-0000-0000-000000000203',
    'event_name', 'app_store_clicked',
    'click_id', current_setting('test.tracking_demo_prior_day_click'),
    'occurred_at', now() - interval '1 day',
    'properties', '{}'::jsonb
  ))$$,
  'an in-range event remains attributable when its canonical click is from a prior day'
);

reset role;
-- Yesterday contains events but no clicks. The summary and source rows must
-- report known traffic zeroes consistently instead of mixing NULL and 0.
select set_config(
  'test.tracking_demo_account_count_before',
  (select count(*)::text from public.accounts),
  true
);
set local role service_role;
select throws_ok(
  $$select * from public.prepare_checkout_attempt(jsonb_build_object(
    'click_id', current_setting('test.tracking_demo_click'),
    'offer_key', 'forbidden-demo-offer',
    'idempotency_key', 'tracking_demo_checkout_201'
  ))$$,
  'P0002', 'billing offer is unavailable',
  'checkout preparation rejects demo attribution before any Stripe session can be created'
);
reset role;
select throws_ok(
  $$insert into public.checkout_attempts (
    idempotency_key, billing_offer_id, product_id, acquisition_id,
    click_record_id, affiliate_id, billing_mode, stripe_price_id, currency,
    unit_amount_minor, success_url_snapshot, cancel_url_snapshot
  ) select
    'tracking_demo_direct_201',
    '70000000-0000-0000-0000-000000000299',
    click.product_id,
    acquisition.id,
    click.id,
    click.affiliate_id,
    'subscription',
    'price_TrackingDemo201',
    'USD',
    1000,
    'https://demo.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
    'https://demo.kissmyapps.dev/cancel'
  from public.clicks as click
  join public.acquisitions as acquisition on acquisition.click_record_id = click.id
  where click.public_click_id = current_setting('test.tracking_demo_click')$$,
  'P0001', 'checkout is unavailable for noncommercial tracking',
  'direct checkout-attempt insertion is rejected from false link ancestry before foreign-key checks'
);
select is(
  (select count(*)::text from public.accounts),
  current_setting('test.tracking_demo_account_count_before'),
  'checkout rejection occurs before any customer account can be created'
);

select throws_ok(
  $$insert into public.conversions (
    acquisition_id, affiliate_id, product_id, agreement_id,
    commission_rule_id, event_id, event_name, occurred_at
  ) select
    acquisition.id,
    acquisition.affiliate_id,
    acquisition.product_id,
    '40000000-0000-0000-0000-000000000299',
    '41000000-0000-0000-0000-000000000299',
    event.id,
    event.event_name,
    event.occurred_at
  from public.acquisitions as acquisition
  join public.clicks as click on click.id = acquisition.click_record_id
  join public.events as event on event.acquisition_id = acquisition.id
  where click.public_click_id = current_setting('test.tracking_demo_click')
  order by event.created_at
  limit 1$$,
  '23514', 'conversions require commercially eligible attribution and events',
  'billable conversion insertion is rejected from immutable noncommercial evidence'
);

insert into public.payout_periods (
  id, starts_at, ends_at, review_starts_at, payout_due_at
)
values (
  '80000000-0000-0000-0000-000000000201',
  '2099-01-01 00:00:00+00', '2099-02-01 00:00:00+00',
  '2099-02-01 00:00:00+00', '2099-02-14 00:00:00+00'
);
select throws_ok(
  $$insert into public.commission_entries (
    affiliate_id, product_id, agreement_id, commission_rule_id,
    conversion_id, payout_period_id, entry_type, amount_minor, currency,
    source_key, partner_visible_description
  ) values (
    '30000000-0000-0000-0000-000000000201',
    '20000000-0000-0000-0000-000000000201',
    '40000000-0000-0000-0000-000000000299',
    '41000000-0000-0000-0000-000000000299',
    '42000000-0000-0000-0000-000000000299',
    '80000000-0000-0000-0000-000000000201',
    'commission', 1000, 'USD', 'tracking-demo-forbidden-commission',
    'Forbidden demo commission'
  )$$,
  '23514', 'tracking-only products cannot create commercial records',
  'commission ledger rejects tracking-only products before commercial foreign keys'
);
select throws_ok(
  $$insert into public.payouts (
    affiliate_id, product_id, payout_period_id, currency
  ) values (
    '30000000-0000-0000-0000-000000000201',
    '20000000-0000-0000-0000-000000000201',
    '80000000-0000-0000-0000-000000000201', 'USD'
  )$$,
  '23514', 'tracking-only products cannot create commercial records',
  'payout ledger rejects tracking-only products'
);
select is(
  (select bool_or(commercial_eligible) from public.events
    where product_id = '20000000-0000-0000-0000-000000000201'),
  false,
  'no demo event can elevate itself into commercial evidence'
);
select is(
  (select count(*) from public.commercial_metric_refresh_queue
    where product_id = '20000000-0000-0000-0000-000000000201'),
  0::bigint,
  'demo traffic never queues the commercial metrics worker'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000203', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000203","role":"authenticated"}',
  true
);
select is(
  (select clicks from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000201', current_date - 1, current_date - 1,
    'UTC', null, null, null, null, null
  )),
  0::bigint,
  'an event-only demo window reports a known zero click count without a worker'
);
select is(
  (select visitors from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000201', current_date - 1, current_date - 1,
    'UTC', null, null, null, null, null
  )),
  0::bigint,
  'an event-only demo window reports a known zero visitor count'
);
select is(
  (select funnel_starts from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000201', current_date - 1, current_date - 1,
    'UTC', null, null, null, null, null
  )),
  1::bigint,
  'Partner performance reads canonical demo events immediately'
);
select is(
  (select app_store_clicks from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000201', current_date - 1, current_date - 1,
    'UTC', null, null, null, null, null
  )),
  1::bigint,
  'in-range demo events remain visible when their canonical click occurred before the report range'
);
select is(
  (select earnings_minor from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000201', current_date - 1, current_date - 1,
    'UTC', null, null, null, null, null
  )),
  null::bigint,
  'Partner performance leaves demo earnings unavailable rather than reporting money'
);
select is(
  (select dimension_label from public.get_partner_dashboard_trends(
    '20000000-0000-0000-0000-000000000201', current_date - 1, current_date - 1,
    'UTC', null, null, null, null, null, 'day', 'source'
  ) where dimension_key = 'tiktok-demo' limit 1),
  'TikTok Demo',
  'Partner trends expose immediate source attribution for tracking-only traffic'
);
select is(
  (select clicks from public.get_partner_dashboard_trends(
    '20000000-0000-0000-0000-000000000201', current_date - 1, current_date - 1,
    'UTC', null, null, null, null, null, 'day', 'source'
  ) where dimension_key = 'tiktok-demo' limit 1),
  0::bigint,
  'event-only source reporting agrees with the summary known zero click count'
);
select is(
  (select has_data from public.get_partner_dashboard_summary(
    '20000000-0000-0000-0000-000000000202', current_date - 1, current_date - 1,
    'UTC', null, null, null, null, null
  )),
  false,
  'commercial products still route through the unchanged callable commercial summary implementation'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000201', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000201","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select throws_ok(
  $$select public.set_admin_product_tracking_mode(jsonb_build_object(
    'product_id', '20000000-0000-0000-0000-000000000201',
    'mode', 'commercial',
    'expected_updated_at', (
      select updated_at from public.get_admin_products()
      where id = '20000000-0000-0000-0000-000000000201'
    )
  ))$$,
  'P0001',
  'a product with tracking-only traffic cannot become commercial; create a new commercial product',
  'demo traffic can never be graduated into a commercial attribution history'
);

reset role;
update public.funnels
set destination_url = 'https://demo.kissmyapps.dev/reapproved'
where id = '50000000-0000-0000-0000-000000000201';
select is(
  public.tracking_only_product_is_ready(
    '20000000-0000-0000-0000-000000000201'
  ),
  false,
  'a destination change invalidates the exact Owner-approved snapshot'
);

set local role service_role;
select throws_ok(
  $$select * from public.register_tracking_click(
    'tracking-demo-partner', current_setting('test.tracking_demo_code'),
    jsonb_build_object('session_id_hash', repeat('c', 64))
  )$$,
  'P0002', 'tracking route is unavailable',
  'redirect fails closed while the live funnel differs from the approved snapshot'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000201', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000201","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select is(
  public.set_admin_product_tracking_mode(jsonb_build_object(
    'product_id', '20000000-0000-0000-0000-000000000201',
    'mode', 'tracking_only',
    'expected_updated_at', (
      select updated_at from public.get_admin_products()
      where id = '20000000-0000-0000-0000-000000000201'
    )
  )) ->> 'tracking_only_destination_url_snapshot',
  'https://demo.kissmyapps.dev/reapproved',
  'same-mode Owner mutation explicitly re-approves a changed live default funnel snapshot'
);

select * from finish();
rollback;
