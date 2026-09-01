begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function(
  'public', 'get_admin_attribution_overview', array['jsonb'],
  'the protected admin attribution RPC exists'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.get_admin_attribution_overview(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.get_admin_attribution_overview(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.get_admin_attribution_overview(jsonb)', 'EXECUTE'
  ),
  'only authenticated users receive the RPC grant before role authorization'
);
select ok(
  not has_table_privilege('authenticated', 'public.clicks', 'SELECT')
  and not has_table_privilege('authenticated', 'public.acquisitions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.events', 'SELECT')
  and not has_table_privilege('authenticated', 'public.conversions', 'SELECT'),
  'authenticated callers cannot bypass the aggregate boundary to read raw facts'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-4000-8000-000000000171',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attribution-owner@example.test', '', now(),
    '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000172',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attribution-operations@example.test', '', now(),
    '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000173',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attribution-finance@example.test', '', now(),
    '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000174',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attribution-analyst@example.test', '', now(),
    '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000175',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attribution-support@example.test', '', now(),
    '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000176',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attribution-member@example.test', '', now(),
    '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000177',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attribution-inactive@example.test', '', now(),
    '{}', '{}', now(), now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-4000-8000-000000000171', 'owner', true),
  ('10000000-0000-4000-8000-000000000172', 'operations', true),
  ('10000000-0000-4000-8000-000000000173', 'finance', true),
  ('10000000-0000-4000-8000-000000000174', 'analyst', true),
  ('10000000-0000-4000-8000-000000000175', 'support', true),
  ('10000000-0000-4000-8000-000000000177', 'owner', false);

set local role anon;
select throws_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb)$$,
  '42501', null,
  'anonymous callers are denied at the function privilege boundary'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000171', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000171","role":"authenticated","amr":[{"method":"password"}]}',
  true
);

select is(
  public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) #> '{readiness}',
  '{"tracking_enabled":false,"base_url_configured":false,"active_product_count":0,"live_funnel_count":0,"active_link_count":0,"last_click_at":null,"last_event_at":null,"last_conversion_at":null}'::jsonb,
  'an empty system returns explicit zero and null readiness state'
);
select is(
  public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) #> '{summary}',
  '{"clicks":0,"bot_clicks":0,"acquisitions":0,"resolved_acquisitions":0,"rejected_acquisitions":0,"events":0,"trusted_events":0,"commercial_eligible_events":0,"qualified_conversions":0}'::jsonb,
  'an empty system returns mapper-safe zero summary totals'
);
select is(
  public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) #> '{recent_acquisitions}',
  '{"items":[],"total_count":0}'::jsonb,
  'an empty system returns mapper-safe pagination state'
);
select ok(
  public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) #> '{breakdown}' = '[]'::jsonb
  and public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) #> '{event_types}' = '[]'::jsonb
  and public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) #> '{sources}' = '[]'::jsonb,
  'all empty collections are emitted as JSON arrays'
);

reset role;

insert into public.platform_settings (singleton, tracking_base_url, tracking_enabled)
values (true, 'https://go.attribution.example.test', true);

insert into public.products (id, slug, name, status)
values (
  '20000000-0000-4000-8000-000000000171',
  'attribution-alpha', 'Attribution Alpha', 'active'
);

insert into public.sources (id, key, name)
values (
  '51000000-0000-4000-8000-000000000171',
  'attribution-tiktok', 'TikTok'
);

insert into public.affiliates (
  id, public_name, slug, reporting_timezone, preferred_currency, status
)
values (
  '30000000-0000-4000-8000-000000000171',
  'Attribution Partner', 'attr-partner', 'UTC', 'USD', 'active'
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values (
  '50000000-0000-4000-8000-000000000171',
  '20000000-0000-4000-8000-000000000171',
  'alpha-funnel', 'Alpha Funnel',
  'https://alpha.example.test/start?private_destination=never-return', 'live', true
);

insert into public.affiliate_links (
  id, affiliate_id, product_id, source_id, funnel_id, name, public_code,
  tracking_url, sub1, status
)
values (
  '60000000-0000-4000-8000-000000000171',
  '30000000-0000-4000-8000-000000000171',
  '20000000-0000-4000-8000-000000000171',
  '51000000-0000-4000-8000-000000000171',
  '50000000-0000-4000-8000-000000000171',
  'Attribution TikTok link', 'attrsource0171xx',
  'https://go.attribution.example.test/r/attr-partner/attrsource0171xx',
  'tiktok', 'paused'
);

insert into public.clicks (
  id, public_click_id, affiliate_link_id, affiliate_id, product_id, source_id,
  funnel_id, sub1, destination_url_snapshot, session_id_hash, is_bot, occurred_at
)
values
  (
    '61000000-0000-4000-8000-000000000171', 'accepted-click-0171',
    '60000000-0000-4000-8000-000000000171',
    '30000000-0000-4000-8000-000000000171',
    '20000000-0000-4000-8000-000000000171',
    '51000000-0000-4000-8000-000000000171',
    '50000000-0000-4000-8000-000000000171', 'tiktok',
    'https://alpha.example.test/start?private_destination=never-return',
    repeat('a', 64), false, '2026-08-25 10:00:00+00'
  ),
  (
    '61000000-0000-4000-8000-000000000172', 'rejected-bot-click-0171',
    '60000000-0000-4000-8000-000000000171',
    '30000000-0000-4000-8000-000000000171',
    '20000000-0000-4000-8000-000000000171',
    '51000000-0000-4000-8000-000000000171',
    '50000000-0000-4000-8000-000000000171', 'tiktok',
    'https://alpha.example.test/start?private_destination=never-return',
    repeat('b', 64), true, '2026-08-25 11:00:00+00'
  );

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000171', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000171","role":"authenticated","amr":[{"method":"password"}]}',
  true
);

select is(
  public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) #> '{summary}',
  '{"clicks":1,"bot_clicks":1,"acquisitions":0,"resolved_acquisitions":0,"rejected_acquisitions":0,"events":0,"trusted_events":0,"commercial_eligible_events":0,"qualified_conversions":0}'::jsonb,
  'accepted clicks and bot clicks are counted separately'
);
select is(
  public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) #> '{breakdown,0}',
  '{"product_id":"20000000-0000-4000-8000-000000000171","product_name":"Attribution Alpha","source_id":"51000000-0000-4000-8000-000000000171","source_name":"TikTok","clicks":1,"acquisitions":0,"qualified_conversions":0}'::jsonb,
  'breakdown click totals exclude bot traffic'
);
select is(
  jsonb_array_length(public.get_admin_attribution_overview(
    '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
  ) -> 'sources'),
  1,
  'the response includes the bounded source filter catalog'
);
select ok(
  position(
    'private_destination=never-return' in public.get_admin_attribution_overview(
      '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
    )::text
  ) = 0
  and position(
    'accepted-click-0171' in public.get_admin_attribution_overview(
      '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
    )::text
  ) = 0
  and position(
    repeat('a', 64) in public.get_admin_attribution_overview(
      '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
    )::text
  ) = 0
  and position(
    '"account_id"' in public.get_admin_attribution_overview(
      '{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb
    )::text
  ) = 0,
  'destinations, click identifiers, hashes, and account identifiers remain private'
);

select throws_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z","raw":true}'::jsonb)$$,
  '22023', 'attribution input contains unsupported or missing fields',
  'unknown input fields cannot expand the read contract'
);
select throws_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-26T00:00:00Z","ends_at":"2026-08-25T00:00:00Z"}'::jsonb)$$,
  '22023', 'attribution window must end after it starts',
  'invalid windows are rejected'
);
select throws_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-05-01T00:00:00Z","ends_at":"2026-08-01T00:00:00Z"}'::jsonb)$$,
  '22023', 'attribution window cannot exceed 90 days',
  'windows longer than 90 days are rejected'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000172', true);
select lives_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb)$$,
  'operations can read aggregate attribution'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000173', true);
select lives_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb)$$,
  'finance can read aggregate attribution'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000174', true);
select lives_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb)$$,
  'analyst can read aggregate attribution'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000175', true);
select throws_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb)$$,
  '42501', 'admin role cannot view attribution',
  'support is denied aggregate attribution access'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000176', true);
select throws_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb)$$,
  '42501', 'admin role cannot view attribution',
  'an ordinary authenticated user is denied aggregate attribution access'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000177', true);
select throws_ok(
  $$select public.get_admin_attribution_overview('{"starts_at":"2026-08-25T00:00:00Z","ends_at":"2026-08-26T00:00:00Z"}'::jsonb)$$,
  '42501', 'admin role cannot view attribution',
  'an inactive admin assignment is denied aggregate attribution access'
);

select * from finish();
rollback;
