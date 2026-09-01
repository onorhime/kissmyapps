begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function(
  'public', 'get_admin_data_health', array[]::text[],
  'aggregate Admin Data Health RPC exists'
);

select ok(
  (
    select function.prosecdef and function.provolatile = 's'
    from pg_catalog.pg_proc as function
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.proname = 'get_admin_data_health'
      and function.pronargs = 0
  ),
  'Data Health is a stable SECURITY DEFINER read'
);

select ok(
  has_function_privilege(
    'authenticated', 'public.get_admin_data_health()', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.get_admin_data_health()', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.get_admin_data_health()', 'EXECUTE'
  )
  and not has_function_privilege(
    'public', 'public.get_admin_data_health()', 'EXECUTE'
  ),
  'only authenticated browser sessions receive the RPC grant'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'commercial_reconciliation_processing_ready_idx'
  )
  and exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'reconciliation_runs_status_scheduled_idx'
  ),
  'Data Health queue and recent-run reads have supporting indexes'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000181',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'health-owner@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000182',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'health-operations@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000183',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'health-finance@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000184',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'health-analyst@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000185',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'health-support@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000186',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'health-ordinary@example.test', '',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000187',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'health-inactive@example.test', '',
    now(), '{}', '{}', now(), now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000181', 'owner', true),
  ('10000000-0000-0000-0000-000000000182', 'operations', true),
  ('10000000-0000-0000-0000-000000000183', 'finance', true),
  ('10000000-0000-0000-0000-000000000184', 'analyst', true),
  ('10000000-0000-0000-0000-000000000185', 'support', true),
  ('10000000-0000-0000-0000-000000000187', 'owner', false);

insert into public.platform_settings (
  singleton, tracking_base_url, tracking_enabled
)
values (true, null, false)
on conflict (singleton) do update
set tracking_base_url = excluded.tracking_base_url,
    tracking_enabled = excluded.tracking_enabled;

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$ select public.get_admin_data_health() $$,
  '42501', null,
  'anonymous callers cannot execute Data Health'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000181', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000181","role":"authenticated"}',
  true
);
select lives_ok(
  $$ select public.get_admin_data_health() $$,
  'Owner can read aggregate Data Health'
);

select is(
  public.get_admin_data_health() ->> 'overall_status', 'disabled',
  'disabled tracking is reported explicitly'
);
select is(
  jsonb_array_length(public.get_admin_data_health() -> 'providers'), 4,
  'response has exactly four provider aggregates'
);
select is(
  jsonb_array_length(public.get_admin_data_health() -> 'queues'), 4,
  'response has exactly four queue aggregates'
);
select is(
  public.get_admin_data_health() #>> '{providers,0,id}', 'click_tracker',
  'click provider identifier matches the TypeScript contract'
);
select is(
  public.get_admin_data_health() #>> '{providers,1,id}', 'funnel_events',
  'funnel provider identifier matches the TypeScript contract'
);
select is(
  public.get_admin_data_health() #>> '{providers,2,id}', 'stripe',
  'Stripe provider identifier matches the TypeScript contract'
);
select is(
  public.get_admin_data_health() #>> '{providers,3,id}', 'singular',
  'Singular provider identifier matches the TypeScript contract'
);
select is(
  public.get_admin_data_health() #>> '{providers,0,status}', 'disabled',
  'click tracking is disabled when platform tracking is off'
);
select is(
  public.get_admin_data_health() #>> '{providers,1,status}', 'disabled',
  'funnel tracking is disabled when platform tracking is off'
);
select is(
  public.get_admin_data_health() #>> '{providers,2,status}', 'unobserved',
  'zero Stripe observations are not reported healthy'
);
select is(
  public.get_admin_data_health() #>> '{providers,3,status}', 'unobserved',
  'zero Singular observations are not reported healthy'
);
select is(
  public.get_admin_data_health() #>> '{queues,0,status}', 'unobserved',
  'zero Stripe queue evidence is unobserved'
);
select is(
  public.get_admin_data_health() #>> '{queues,1,status}', 'unobserved',
  'zero commercial-fact queue evidence is unobserved'
);
select is(
  public.get_admin_data_health() #>> '{queues,2,status}', 'unobserved',
  'zero reporting-metric queue evidence is unobserved'
);
select is(
  public.get_admin_data_health() #>> '{queues,3,status}', 'unobserved',
  'zero reconciliation queue evidence is unobserved'
);
select is(
  (public.get_admin_data_health() #>> '{metrics,row_count}')::bigint, 0::bigint,
  'zero metric rows are a count rather than freshness proof'
);
select is(
  public.get_admin_data_health() #> '{reconciliation,recent_runs}', '[]'::jsonb,
  'zero reconciliation runs return an empty bounded list'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000182', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000182","role":"authenticated"}',
  true
);
select lives_ok(
  $$ select public.get_admin_data_health() $$,
  'Operations can read aggregate Data Health'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000183', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000183","role":"authenticated"}',
  true
);
select lives_ok(
  $$ select public.get_admin_data_health() $$,
  'Finance can read aggregate Data Health'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000184', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000184","role":"authenticated"}',
  true
);
select lives_ok(
  $$ select public.get_admin_data_health() $$,
  'Analyst can read aggregate Data Health'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000185', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000185","role":"authenticated"}',
  true
);
select throws_ok(
  $$ select public.get_admin_data_health() $$,
  '42501', 'admin role cannot view data health',
  'Support cannot read Data Health'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000186', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000186","role":"authenticated"}',
  true
);
select throws_ok(
  $$ select public.get_admin_data_health() $$,
  '42501', 'admin role cannot view data health',
  'an ordinary authenticated user cannot read Data Health'
);

select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000187', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000187","role":"authenticated"}',
  true
);
select throws_ok(
  $$ select public.get_admin_data_health() $$,
  '42501', 'admin role cannot view data health',
  'an inactive administrator cannot read Data Health'
);

reset role;

insert into public.provider_events (
  id, provider, provider_event_id, event_type, payload,
  signature_verified, received_at
)
values
  (
    '90000000-0000-0000-0000-000000000181',
    'stripe', 'evt_DataHealthRetry001', 'invoice.paid',
    '{"livemode":true,"secret":"raw_provider_payload_secret"}',
    true, now() - interval '15 minutes'
  ),
  (
    '90000000-0000-0000-0000-000000000182',
    'stripe', 'evt_DataHealthLease001', 'invoice.paid',
    '{"livemode":true}', true, now() - interval '14 minutes'
  ),
  (
    '90000000-0000-0000-0000-000000000183',
    'stripe', 'evt_DataHealthFailed001', 'invoice.paid',
    '{"livemode":true}', true, now() - interval '13 minutes'
  ),
  (
    '90000000-0000-0000-0000-000000000184',
    'stripe', 'evt_DataHealthBackoff001', 'invoice.paid',
    '{"livemode":true}', true, now() - interval '12 minutes'
  );

insert into public.provider_event_processing (
  provider_event_id, status, processing_error, claimed_by, claim_token,
  claimed_at, lease_expires_at, next_attempt_at
)
values
  (
    '90000000-0000-0000-0000-000000000181',
    'pending', 'raw_worker_retry_error_secret', null, null, null, null,
    now() - interval '5 minutes'
  ),
  (
    '90000000-0000-0000-0000-000000000182',
    'processing', null, 'health-worker',
    '91000000-0000-0000-0000-000000000182',
    now() - interval '10 minutes', now() - interval '5 minutes', now()
  ),
  (
    '90000000-0000-0000-0000-000000000183',
    'failed', 'raw_worker_terminal_error_secret', null, null, null, null, now()
  ),
  (
    '90000000-0000-0000-0000-000000000184',
    'pending', 'raw_worker_backoff_error_secret', null, null, null, null,
    now() + interval '5 minutes'
  );

set local role authenticated;
select set_config(
  'request.jwt.claim.sub', '10000000-0000-0000-0000-000000000181', true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000181","role":"authenticated"}',
  true
);

select is(
  public.get_admin_data_health() ->> 'overall_status', 'attention',
  'queue failures override disabled tracking with attention'
);
select is(
  public.get_admin_data_health() #>> '{providers,2,status}', 'attention',
  'terminal Stripe processing failure explains provider attention'
);
select is(
  (public.get_admin_data_health() #>> '{providers,2,observed_count}')::bigint,
  4::bigint, 'Stripe provider observation count is aggregate-only'
);
select is(
  (public.get_admin_data_health() #>> '{providers,2,verified_count}')::bigint,
  4::bigint, 'signed live Stripe evidence is verified'
);
select is(
  (public.get_admin_data_health() #>> '{providers,2,failed_count}')::bigint,
  1::bigint, 'one terminal Stripe event explains provider attention'
);
select is(
  public.get_admin_data_health() #>> '{queues,0,status}', 'attention',
  'retry-ready, stale, and failed Stripe work needs attention'
);
select is(
  (public.get_admin_data_health() #>> '{queues,0,pending_count}')::bigint,
  2::bigint, 'Stripe pending aggregate includes ready and backed-off work'
);
select is(
  (public.get_admin_data_health() #>> '{queues,0,processing_count}')::bigint,
  1::bigint, 'Stripe processing aggregate is correct'
);
select is(
  (public.get_admin_data_health() #>> '{queues,0,processed_count}')::bigint,
  0::bigint, 'Stripe processed aggregate is correct'
);
select is(
  (public.get_admin_data_health() #>> '{queues,0,failed_count}')::bigint,
  1::bigint, 'Stripe failure aggregate is correct'
);
select is(
  (public.get_admin_data_health() #>> '{queues,0,retry_ready_count}')::bigint,
  1::bigint,
  'only an errored pending item whose backoff elapsed is retry-ready'
);
select is(
  (public.get_admin_data_health() #>> '{queues,0,stale_lease_count}')::bigint,
  1::bigint,
  'an expired processing lease is counted without exposing its claim'
);
select ok(
  public.get_admin_data_health() #>> '{queues,0,oldest_pending_at}' is not null,
  'oldest pending time is present without exposing event identity'
);
select is(
  public.get_admin_data_health() #> '{queues,0,last_processed_at}',
  'null'::jsonb,
  'no processed item returns null freshness rather than a false success time'
);

select ok(
  position(
    'raw_provider_payload_secret' in public.get_admin_data_health()::text
  ) = 0
  and position(
    'raw_worker_retry_error_secret' in public.get_admin_data_health()::text
  ) = 0
  and position(
    'raw_worker_terminal_error_secret' in public.get_admin_data_health()::text
  ) = 0
  and position(
    'raw_worker_backoff_error_secret' in public.get_admin_data_health()::text
  ) = 0
  and public.get_admin_data_health()::text
    !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  'Data Health omits raw payloads, worker errors, claim tokens, and row IDs'
);

select * from finish();
rollback;
