begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select ok(
  has_function_privilege(
    'service_role',
    'public.assert_funnel_request_scope(text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.assert_funnel_request_scope(text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.assert_funnel_request_scope(text,text,uuid,uuid)',
    'EXECUTE'
  ),
  'funnel request scope assertion is callable only through the service boundary'
);

insert into public.platform_settings (tracking_base_url, tracking_enabled)
values ('https://go.kissmyapps.dev', true);

insert into public.products (id, slug, name, status)
values (
  '20000000-0000-0000-0000-000000000121',
  'scope-product', 'Scope Product', 'active'
);

insert into public.affiliates (
  id, public_name, slug, reporting_timezone, preferred_currency, status
)
values (
  '30000000-0000-0000-0000-000000000121',
  'Scope Partner', 'scope-partner', 'UTC', 'USD', 'active'
);

insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  payout_currency, minimum_payout_minor
)
values (
  '40000000-0000-0000-0000-000000000121',
  '30000000-0000-0000-0000-000000000121',
  '20000000-0000-0000-0000-000000000121',
  1, 'cpa', 'draft', now() - interval '1 day', 'USD', 1000
);

insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values (
  '41000000-0000-0000-0000-000000000121',
  '40000000-0000-0000-0000-000000000121',
  'Paid purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD'
);

insert into public.documents (
  id, affiliate_id, agreement_id, name, document_type, version, file_path, status,
  effective_at, signed_by_partner_at, signed_by_kissmyapps_at
)
values (
  '42000000-0000-0000-0000-000000000121',
  '30000000-0000-0000-0000-000000000121',
  '40000000-0000-0000-0000-000000000121',
  'Signed scope agreement', 'affiliate_agreement', 1,
  '30000000-0000-0000-0000-000000000121/agreements/version-1.pdf',
  'active', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'
);

update public.agreements
set status = 'active'
where id = '40000000-0000-0000-0000-000000000121';

insert into public.billing_offers (
  id, product_id, key, version, name, billing_mode, stripe_price_id, currency,
  unit_amount_minor, success_url_template, cancel_url, status,
  verified_stripe_price_id, verified_currency, verified_unit_amount_minor,
  verified_billing_mode, stripe_livemode_verified_at
)
values (
  '70000000-0000-0000-0000-000000000121',
  '20000000-0000-0000-0000-000000000121',
  'monthly', 1, 'Monthly subscription', 'subscription',
  'price_ScopeMonthly121', 'USD', 1999,
  'https://funnel.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
  'https://funnel.kissmyapps.dev/cancel', 'active',
  'price_ScopeMonthly121', 'USD', 1999, 'subscription', now()
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values
  (
    '50000000-0000-0000-0000-000000000121',
    '20000000-0000-0000-0000-000000000121',
    'primary', 'Primary', 'https://funnel.kissmyapps.dev/start', 'live', true
  ),
  (
    '50000000-0000-0000-0000-000000000122',
    '20000000-0000-0000-0000-000000000121',
    'alternate', 'Alternate', 'https://alternate.kissmyapps.dev/start', 'live', false
  );

insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
  is_main, status
)
values (
  '60000000-0000-0000-0000-000000000121',
  '30000000-0000-0000-0000-000000000121',
  '20000000-0000-0000-0000-000000000121',
  '50000000-0000-0000-0000-000000000121',
  'Main link', 'scopemainscope12',
  'https://go.kissmyapps.dev/r/scope-partner/scopemainscope12',
  true, 'active'
);

select throws_ok(
  $$insert into public.clicks (
    public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id,
    destination_url_snapshot, ip_hash, is_bot
  ) values (
    'rawipmustnotpersist12',
    '60000000-0000-0000-0000-000000000121',
    '30000000-0000-0000-0000-000000000121',
    '20000000-0000-0000-0000-000000000121',
    '50000000-0000-0000-0000-000000000121',
    'https://funnel.kissmyapps.dev/start',
    '203.0.113.12', false
  )$$,
  '23514', null,
  'the canonical click table rejects raw IP values rather than storing them'
);

set local role service_role;

select set_config(
  'test.scope_click_id',
  (
    select click_id
    from public.register_tracking_click(
      'scope-partner',
      'scopemainscope12',
      jsonb_build_object(
        'ip_hash', repeat('a', 64),
        'session_id_hash', repeat('b', 64),
        'is_bot', false
      )
    )
  ),
  true
);

reset role;

select set_config(
  'test.scope_click_occurred_at',
  (
    select occurred_at::text
    from public.clicks
    where public_click_id = current_setting('test.scope_click_id')
  ),
  true
);

set local role service_role;

select is(
  public.assert_funnel_request_scope(
    'funnel_primary',
    current_setting('test.scope_click_id'),
    '20000000-0000-0000-0000-000000000121',
    '50000000-0000-0000-0000-000000000121'
  ),
  true,
  'a canonical non-bot click matches the Edge-authenticated key scope'
);

select throws_ok(
  $$select public.assert_funnel_request_scope(
    'funnel_primary',
    current_setting('test.scope_click_id'),
    '20000000-0000-0000-0000-000000000121',
    '50000000-0000-0000-0000-000000000122'
  )$$,
  'P0002', 'funnel request scope is unavailable',
  'a click cannot be replayed into another funnel scope'
);

select throws_ok(
  $$select public.assert_funnel_request_scope(
    'funnel_primary',
    'nonexistentclick000000000000000000',
    '20000000-0000-0000-0000-000000000121',
    '50000000-0000-0000-0000-000000000121'
  )$$,
  'P0002', 'funnel request scope is unavailable',
  'a nonexistent click has the same non-leaking failure as a scope mismatch'
);

select throws_ok(
  $$select public.assert_funnel_request_scope(
    'bad key',
    current_setting('test.scope_click_id'),
    '20000000-0000-0000-0000-000000000121',
    '50000000-0000-0000-0000-000000000121'
  )$$,
  '22023', 'funnel request scope input is invalid',
  'the asserted key identifier is strict and canonical'
);

select set_config(
  'test.scope_bot_click_id',
  (
    select click_id
    from public.register_tracking_click(
      'scope-partner', 'scopemainscope12', '{"is_bot":true}'::jsonb
    )
  ),
  true
);

select throws_ok(
  $$select public.assert_funnel_request_scope(
    'funnel_primary',
    current_setting('test.scope_bot_click_id'),
    '20000000-0000-0000-0000-000000000121',
    '50000000-0000-0000-0000-000000000121'
  )$$,
  'P0002', 'funnel request scope is unavailable',
  'recognized bot clicks are never valid funnel request scope'
);

select set_config(
  'test.scope_rejected_click_id',
  (
    select click_id
    from public.register_tracking_click(
      'scope-partner', 'scopemainscope12', '{}'::jsonb
    )
  ),
  true
);

reset role;

update public.acquisitions as acquisition
set status = 'rejected', rejection_reason = 'manual_review'
from public.clicks as click
where click.id = acquisition.click_record_id
  and click.public_click_id = current_setting('test.scope_rejected_click_id');

set local role service_role;

select throws_ok(
  $$select public.assert_funnel_request_scope(
    'funnel_primary',
    current_setting('test.scope_rejected_click_id'),
    '20000000-0000-0000-0000-000000000121',
    '50000000-0000-0000-0000-000000000121'
  )$$,
  'P0002', 'funnel request scope is unavailable',
  'a rejected non-bot acquisition is never valid funnel request scope'
);

reset role;

-- Seed the exact rolling-window boundaries as durable click evidence. Direct
-- inserts here exercise the same canonical dimension trigger as production.
insert into public.clicks (
  public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id,
  destination_url_snapshot, ip_hash, is_bot, occurred_at, created_at
)
select
  md5('scope-ip-rate-' || ordinal::text),
  '60000000-0000-0000-0000-000000000121',
  '30000000-0000-0000-0000-000000000121',
  '20000000-0000-0000-0000-000000000121',
  '50000000-0000-0000-0000-000000000121',
  'https://funnel.kissmyapps.dev/start',
  repeat('c', 64), false, statement_timestamp(), statement_timestamp()
from generate_series(1, 300) as ordinal;

insert into public.clicks (
  public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id,
  destination_url_snapshot, session_id_hash, is_bot, occurred_at, created_at
)
select
  md5('scope-session-rate-' || ordinal::text),
  '60000000-0000-0000-0000-000000000121',
  '30000000-0000-0000-0000-000000000121',
  '20000000-0000-0000-0000-000000000121',
  '50000000-0000-0000-0000-000000000121',
  'https://funnel.kissmyapps.dev/start',
  repeat('d', 64), false, statement_timestamp(), statement_timestamp()
from generate_series(1, 30) as ordinal;

set local role service_role;

select throws_ok(
  $$select * from public.register_tracking_click(
    'scope-partner', 'scopemainscope12',
    jsonb_build_object('ip_hash', repeat('c', 64))
  )$$,
  'KMA29', 'tracking click rate limit exceeded',
  'the 301st per-link hashed-IP click in one minute is rejected as rate limited'
);

select throws_ok(
  $$select * from public.register_tracking_click(
    'scope-partner', 'scopemainscope12',
    jsonb_build_object('session_id_hash', repeat('d', 64))
  )$$,
  'KMA29', 'tracking click rate limit exceeded',
  'the 31st per-link hashed-session click in one minute is rejected as rate limited'
);

select lives_ok(
  $$select * from public.register_tracking_click(
    'scope-partner', 'scopemainscope12',
    jsonb_build_object(
      'ip_hash', repeat('e', 64),
      'session_id_hash', repeat('f', 64)
    )
  )$$,
  'one saturated hash does not block an unrelated hashed request'
);

reset role;

select is(
  (
    select count(*)
    from public.clicks
    where ip_hash = repeat('c', 64)
  ),
  300::bigint,
  'a rejected hashed-IP request creates no click row'
);

select is(
  (
    select count(*)
    from public.clicks
    where session_id_hash = repeat('d', 64)
  ),
  30::bigint,
  'a rejected hashed-session request creates no click row'
);

insert into public.events (
  source, source_event_id, event_name, product_id, affiliate_id,
  acquisition_id, funnel_id, properties, occurred_at, created_at,
  trust, commercial_eligible
)
select
  'first_party',
  'browser:' || (
    '83000000-0000-0000-0000-' || lpad(ordinal::text, 12, '0')
  )::uuid::text,
  'landing_viewed',
  '20000000-0000-0000-0000-000000000121',
  '30000000-0000-0000-0000-000000000121',
  acquisition.id,
  '50000000-0000-0000-0000-000000000121',
  jsonb_build_object('ordinal', ordinal),
  current_setting('test.scope_click_occurred_at')::timestamptz,
  statement_timestamp(),
  'browser', false
from public.acquisitions as acquisition
join public.clicks as click on click.id = acquisition.click_record_id
cross join generate_series(1, 30) as ordinal
where click.public_click_id = current_setting('test.scope_click_id');

set local role service_role;

select throws_ok(
  $$select * from public.ingest_browser_event(
    jsonb_build_object(
      'event_id', '83000000-0000-0000-0000-000000000999',
      'event_name', 'landing_viewed',
      'click_id', current_setting('test.scope_click_id'),
      'occurred_at', current_setting('test.scope_click_occurred_at'),
      'properties', jsonb_build_object('ordinal', 999)
    )
  )$$,
  'KMA29', 'browser event rate limit exceeded',
  'the 31st browser event for one click in one minute is rate limited'
);

select is(
  (
    select duplicate
    from public.ingest_browser_event(
      jsonb_build_object(
        'event_id', '83000000-0000-0000-0000-000000000001',
        'event_name', 'landing_viewed',
        'click_id', current_setting('test.scope_click_id'),
        'occurred_at', current_setting('test.scope_click_occurred_at'),
        'properties', jsonb_build_object('ordinal', 1)
      )
    )
  ),
  true,
  'an exact duplicate succeeds before the saturated browser-event rate gate'
);

select throws_ok(
  $$select * from public.ingest_browser_event(
    jsonb_build_object(
      'event_id', '83000000-0000-0000-0000-000000000001',
      'event_name', 'funnel_started',
      'click_id', current_setting('test.scope_click_id'),
      'occurred_at', current_setting('test.scope_click_occurred_at'),
      'properties', jsonb_build_object('ordinal', 1)
    )
  )$$,
  '23505', 'event ID has already been used for different browser evidence',
  'a conflicting retry is rejected as an identity conflict before rate limiting'
);

select is(
  (
    select duplicate
    from public.ingest_funnel_event(
      jsonb_build_object(
        'event_id', '84000000-0000-0000-0000-000000000001',
        'event_name', 'checkout.started',
        'click_id', current_setting('test.scope_click_id'),
        'occurred_at', current_setting('test.scope_click_occurred_at'),
        'properties', jsonb_build_object('step', 'checkout')
      )
    )
  ),
  false,
  'a new funnel event atomically inserts canonical evidence'
);

select is(
  (
    select duplicate
    from public.ingest_funnel_event(
      jsonb_build_object(
        'event_id', '84000000-0000-0000-0000-000000000001',
        'event_name', 'checkout.started',
        'click_id', current_setting('test.scope_click_id'),
        'occurred_at', current_setting('test.scope_click_occurred_at'),
        'properties', jsonb_build_object('step', 'checkout')
      )
    )
  ),
  true,
  'an exact funnel-event retry is an idempotent success'
);

select throws_ok(
  $$select * from public.ingest_funnel_event(
    jsonb_build_object(
      'event_id', '84000000-0000-0000-0000-000000000001',
      'event_name', 'checkout.completed',
      'click_id', current_setting('test.scope_click_id'),
      'occurred_at', current_setting('test.scope_click_occurred_at'),
      'properties', jsonb_build_object('step', 'checkout')
    )
  )$$,
  '23505', 'event ID has already been used for different funnel evidence',
  'a reused funnel event ID cannot overwrite different evidence'
);

reset role;

select is(
  (
    select count(*)
    from public.events as event
    join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
    join public.clicks as click on click.id = acquisition.click_record_id
    where click.public_click_id = current_setting('test.scope_click_id')
      and event.trust = 'browser'
  ),
  30::bigint,
  'rate rejection and exact retry leave the canonical browser event count unchanged'
);

select * from finish();
rollback;
