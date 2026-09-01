begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000161',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'destination-owner@example.test',
    '$2a$10$destinationOwnerPasswordHash000000000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000162',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'destination-operations@example.test',
    '$2a$10$destinationOperationsPasswordHash000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000163',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'destination-finance@example.test',
    '$2a$10$destinationFinancePasswordHash000000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000164',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'destination-analyst@example.test',
    '$2a$10$destinationAnalystPasswordHash000000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000165',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'destination-support@example.test',
    '$2a$10$destinationSupportPasswordHash000000000000000000000000',
    now(), '{}', '{}', now(), now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000161', 'owner', true),
  ('10000000-0000-0000-0000-000000000162', 'operations', true),
  ('10000000-0000-0000-0000-000000000163', 'finance', true),
  ('10000000-0000-0000-0000-000000000164', 'analyst', true),
  ('10000000-0000-0000-0000-000000000165', 'support', true);

insert into public.products (id, slug, name, status)
values (
  '20000000-0000-0000-0000-000000000161',
  'pgtap-destination-redaction',
  'pgTAP Destination Redaction',
  'draft'
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values
  (
    '50000000-0000-0000-0000-000000000161',
    '20000000-0000-0000-0000-000000000161',
    'primary', 'Primary Funnel',
    'https://private.kissmyapps.dev/checkout?provider_secret=raw',
    'live', true
  ),
  (
    '50000000-0000-0000-0000-000000000162',
    '20000000-0000-0000-0000-000000000161',
    'future', 'Future Funnel', null, 'draft', false
  );

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000161', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000161","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select is(
  public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')
    #>> '{funnels,0,destination_url}',
  'https://private.kissmyapps.dev/checkout?provider_secret=raw',
  'owner receives the full protected funnel destination'
);
select is(
  public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')
    #>> '{funnels,0,destination_configured}',
  'true',
  'owner also receives explicit configured state'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000162', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000162","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select is(
  public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')
    #>> '{funnels,0,destination_url}',
  'https://private.kissmyapps.dev/checkout?provider_secret=raw',
  'operations receives the full protected funnel destination'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000163', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000163","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select ok(
  not ((
    public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')
      #> '{funnels,0}'
  ) ? 'destination_url'),
  'finance receives no destination_url field'
);
select is(
  public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')
    #>> '{funnels,0,destination_configured}',
  'true',
  'finance can see that the primary destination is configured'
);
select is(
  public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')
    #>> '{funnels,1,destination_configured}',
  'false',
  'finance can see that the future destination is missing'
);
select ok(
  position(
    'private.kissmyapps.dev' in
    public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')::text
  ) = 0,
  'finance response contains no copy of the protected destination'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000164', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000164","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select ok(
  not ((
    public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')
      #> '{funnels,0}'
  ) ? 'destination_url'),
  'analyst receives no destination_url field'
);
select is(
  public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')
    #>> '{funnels,0,destination_configured}',
  'true',
  'analyst receives truthful configured state'
);
select ok(
  position(
    'provider_secret=raw' in
    public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')::text
  ) = 0,
  'analyst response contains no protected destination query data'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000165', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000165","role":"authenticated","amr":[{"method":"password"}]}',
  true
);
select throws_ok(
  $$select public.get_admin_product_configuration('20000000-0000-0000-0000-000000000161')$$,
  '42501', 'admin role cannot view product configuration',
  'support is not granted product-configuration access'
);

select * from finish();
rollback;
