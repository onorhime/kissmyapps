begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_column(
  'public', 'provider_events', 'signed_body_sha256',
  'provider events record the exact signed-body digest'
);

select col_type_is(
  'public', 'provider_events', 'signed_body_sha256', 'text',
  'the signed-body digest uses a bounded textual encoding contract'
);

select ok(
  (
    select column_info.is_nullable = 'YES'
    from information_schema.columns as column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'provider_events'
      and column_info.column_name = 'signed_body_sha256'
  ),
  'the digest remains nullable for immutable legacy provider events'
);

select ok(
  exists (
    select 1
    from pg_constraint as constraint_info
    join pg_class as relation on relation.oid = constraint_info.conrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'provider_events'
      and constraint_info.conname = 'provider_events_signed_body_sha256_sha256'
      and constraint_info.contype = 'c'
      and pg_get_constraintdef(constraint_info.oid)
        like '%signed_body_sha256 ~ ''^[a-f0-9]{64}$''%'
  ),
  'the signed-body digest constraint accepts only lowercase SHA-256 hex'
);

select ok(
  not has_column_privilege(
    'anon', 'public.provider_events', 'signed_body_sha256', 'SELECT'
  )
  and not has_column_privilege(
    'authenticated', 'public.provider_events', 'signed_body_sha256', 'SELECT'
  ),
  'public and authenticated API roles cannot read Stripe body digests'
);

select ok(
  not has_table_privilege('service_role', 'public.provider_events', 'SELECT')
  and not has_table_privilege('service_role', 'public.provider_events', 'INSERT')
  and not has_table_privilege('service_role', 'public.provider_event_processing', 'INSERT'),
  'the service role has no direct provider-table access'
);

select ok(
  has_function_privilege(
    'service_role', 'public.persist_stripe_provider_event(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.persist_stripe_provider_event(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.persist_stripe_provider_event(jsonb)', 'EXECUTE'
  ),
  'only the service role can execute the atomic Stripe persistence boundary'
);

select lives_ok(
  $$insert into public.provider_events (
    id, provider, provider_event_id, event_type, payload,
    signature_verified, signed_body_sha256
  ) values (
    '8d000000-0000-4000-8000-000000000131',
    'stripe', 'evt_digest_valid_131', 'invoice.paid',
    '{"id":"evt_digest_valid_131","type":"invoice.paid","livemode":true,"data":{"object":{"id":"in_digest_valid_131"}}}',
    true, repeat('a', 64)
  )$$,
  'a lowercase 64-hex signed-body digest is accepted'
);

select lives_ok(
  $$insert into public.provider_events (
    id, provider, provider_event_id, event_type, payload,
    signature_verified, signed_body_sha256
  ) values (
    '8d000000-0000-4000-8000-000000000132',
    'stripe', 'evt_digest_legacy_132', 'invoice.paid',
    '{"id":"evt_digest_legacy_132","type":"invoice.paid","livemode":true,"data":{"object":{"id":"in_digest_legacy_132"}}}',
    true, null
  )$$,
  'legacy-compatible provider evidence may omit the unavailable digest'
);

select throws_ok(
  $$insert into public.provider_events (
    id, provider, provider_event_id, event_type, payload,
    signature_verified, signed_body_sha256
  ) values (
    '8d000000-0000-4000-8000-000000000133',
    'stripe', 'evt_digest_invalid_133', 'invoice.paid',
    '{"id":"evt_digest_invalid_133","type":"invoice.paid","livemode":true,"data":{"object":{"id":"in_digest_invalid_133"}}}',
    true, repeat('A', 64)
  )$$,
  '23514', null,
  'uppercase or otherwise non-canonical body digests are rejected'
);

select throws_ok(
  $$update public.provider_events
    set signed_body_sha256 = repeat('b', 64)
    where id = '8d000000-0000-4000-8000-000000000131'$$,
  'P0001', 'provider_events is append-only',
  'a persisted signed-body digest cannot be rewritten'
);

select is(
  public.persist_stripe_provider_event(jsonb_build_object(
    'event_id', 'evt_digest_rpc_134',
    'event_type', 'invoice.paid',
    'payload', jsonb_build_object(
      'id', 'evt_digest_rpc_134',
      'type', 'invoice.paid',
      'livemode', true,
      'data', jsonb_build_object('object', jsonb_build_object('id', 'in_digest_rpc_134'))
    ),
    'signed_body_sha256', repeat('c', 64)
  )) ->> 'duplicate',
  'false',
  'the first minimized Stripe event insert is accepted'
);

select is(
  public.persist_stripe_provider_event(jsonb_build_object(
    'event_id', 'evt_digest_rpc_134',
    'event_type', 'invoice.paid',
    'payload', jsonb_build_object(
      'id', 'evt_digest_rpc_134',
      'type', 'invoice.paid',
      'livemode', true,
      'data', jsonb_build_object('object', jsonb_build_object('id', 'in_digest_rpc_134'))
    ),
    'signed_body_sha256', repeat('c', 64)
  )) ->> 'duplicate',
  'true',
  'an exact Stripe retry is idempotent'
);

select throws_ok(
  $$select public.persist_stripe_provider_event(jsonb_build_object(
    'event_id', 'evt_digest_rpc_134',
    'event_type', 'invoice.paid',
    'payload', jsonb_build_object(
      'id', 'evt_digest_rpc_134',
      'type', 'invoice.paid',
      'livemode', true,
      'data', jsonb_build_object('object', jsonb_build_object('id', 'in_digest_rpc_134'))
    ),
    'signed_body_sha256', repeat('d', 64)
  ))$$,
  '23505', 'Stripe event identity conflicts with prior evidence',
  'a reused Stripe event ID with different signed bytes fails closed'
);

select is(
  col_description('public.provider_events'::regclass, (
    select attribute.attnum
    from pg_attribute as attribute
    where attribute.attrelid = 'public.provider_events'::regclass
      and attribute.attname = 'signed_body_sha256'
  )),
  'Lowercase SHA-256 of the exact signature-verified raw request body. Nullable only for immutable provider events received before this column existed; new Stripe webhook inserts always set it.',
  'the schema documents exact-body identity and the legacy null exception'
);

select * from finish();
rollback;
