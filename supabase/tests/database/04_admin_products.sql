begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('10000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-owner@example.test', '', now(), '{}', '{"full_name":"Admin Owner"}', now(), now()),
  ('10000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-operations@example.test', '', now(), '{}', '{"full_name":"Admin Operations"}', now(), now()),
  ('10000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-finance@example.test', '', now(), '{}', '{"full_name":"Admin Finance"}', now(), now()),
  ('10000000-0000-0000-0000-000000000034', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-analyst@example.test', '', now(), '{}', '{"full_name":"Admin Analyst"}', now(), now()),
  ('10000000-0000-0000-0000-000000000035', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-support@example.test', '', now(), '{}', '{"full_name":"Admin Support"}', now(), now()),
  ('10000000-0000-0000-0000-000000000036', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'inactive-admin@example.test', '', now(), '{}', '{"full_name":"Inactive Admin"}', now(), now()),
  ('10000000-0000-0000-0000-000000000037', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ordinary-user@example.test', '', now(), '{}', '{"full_name":"Ordinary User"}', now(), now());

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000031', 'owner', true),
  ('10000000-0000-0000-0000-000000000032', 'operations', true),
  ('10000000-0000-0000-0000-000000000033', 'finance', true),
  ('10000000-0000-0000-0000-000000000034', 'analyst', true),
  ('10000000-0000-0000-0000-000000000035', 'support', true),
  ('10000000-0000-0000-0000-000000000036', 'owner', false);

insert into public.products (id, slug, name)
values ('20000000-0000-0000-0000-000000000031', 'existing-product', 'Existing Product');

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$select * from public.get_admin_context()$$,
  '42501', null,
  'anonymous users cannot resolve admin context'
);
select throws_ok(
  $$select * from public.get_admin_products()$$,
  '42501', null,
  'anonymous users cannot list products'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Nope","slug":"nope"}'::jsonb)$$,
  '42501', null,
  'anonymous users cannot create products'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000037', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000037","role":"authenticated","email":"ordinary-user@example.test","amr":[{"method":"password","timestamp":1787950000}]}',
  true
);
select throws_ok(
  $$select * from public.get_admin_context()$$,
  '42501', 'active admin access is required',
  'a non-admin user cannot resolve admin context'
);
select throws_ok(
  $$select * from public.get_admin_products()$$,
  '42501', 'admin role cannot view products',
  'a non-admin user cannot list products'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Nope","slug":"nope"}'::jsonb)$$,
  '42501', 'admin role cannot create products',
  'a non-admin user cannot create products'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000036', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000036","role":"authenticated","email":"inactive-admin@example.test","amr":[{"method":"password","timestamp":1787950001}]}',
  true
);
select throws_ok(
  $$select * from public.get_admin_context()$$,
  '42501', 'active admin access is required',
  'an inactive administrator cannot resolve admin context'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Inactive Product","slug":"inactive-product"}'::jsonb)$$,
  '42501', 'admin role cannot create products',
  'an inactive owner cannot create products'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000031', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000031","role":"authenticated","email":"admin-owner@example.test","amr":[{"method":"totp","timestamp":1787950002}]}',
  true
);
select is(
  (select role from public.get_admin_context()),
  'owner',
  'an active owner can resolve its admin context'
);
select is(
  (select active from public.get_admin_context()),
  true,
  'admin context exposes the active authorization state required by the browser contract'
);
select is(
  (select full_name from public.get_admin_context()),
  'Admin Owner',
  'admin context reads the administrator name from the canonical profile'
);
select is(
  (select count(*) from public.get_admin_products()),
  1::bigint,
  'an active owner can list products'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Missing Password","slug":"missing-password"}'::jsonb)$$,
  '42501', 'product creation requires a password-authenticated session',
  'a second-factor-only session cannot create a product'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000032', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000032","role":"authenticated","email":"admin-operations@example.test","amr":[{"method":"password","timestamp":1787950003}]}',
  true
);
select is(
  (select role from public.get_admin_context()),
  'operations',
  'an active operations administrator can resolve its context'
);
select is(
  (select count(*) from public.get_admin_products()),
  1::bigint,
  'an active operations administrator can list products'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000033', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000033","role":"authenticated","email":"admin-finance@example.test","amr":[{"method":"password","timestamp":1787950004}]}',
  true
);
select is((select count(*) from public.get_admin_products()), 1::bigint, 'finance can read products');
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Finance Product","slug":"finance-product"}'::jsonb)$$,
  '42501', 'admin role cannot create products',
  'finance cannot create products'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000034', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000034","role":"authenticated","email":"admin-analyst@example.test","amr":[{"method":"password","timestamp":1787950005}]}',
  true
);
select is((select count(*) from public.get_admin_products()), 1::bigint, 'analyst can read products');
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Analyst Product","slug":"analyst-product"}'::jsonb)$$,
  '42501', 'admin role cannot create products',
  'analyst cannot create products'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000035', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000035","role":"authenticated","email":"admin-support@example.test","amr":[{"method":"password","timestamp":1787950006}]}',
  true
);
select is(
  (select role from public.get_admin_context()),
  'support',
  'support can resolve its admin context'
);
select throws_ok(
  $$select * from public.get_admin_products()$$,
  '42501', 'admin role cannot view products',
  'support retains the existing product visibility restriction'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Support Product","slug":"support-product"}'::jsonb)$$,
  '42501', 'admin role cannot create products',
  'support cannot create products'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000031', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000031","role":"authenticated","email":"admin-owner@example.test","amr":[{"method":"password","timestamp":1787950007}]}',
  true
);
select throws_ok(
  $$select * from public.create_admin_product('[]'::jsonb)$$,
  '22023', 'product input must be a JSON object',
  'product creation rejects non-object input'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Missing Slug"}'::jsonb)$$,
  '22023', 'product name and slug are required',
  'product creation requires both exact fields'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Extra Field","slug":"extra-field","status":"active"}'::jsonb)$$,
  '22023', 'product input contains unsupported fields',
  'product creation rejects privilege-bearing extra fields'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":7,"slug":"number-name"}'::jsonb)$$,
  '22023', 'product name and slug must be strings',
  'product creation rejects non-string fields'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"   ","slug":"blank-name"}'::jsonb)$$,
  '22023', 'product name must contain between 1 and 120 characters',
  'product creation validates the normalized product-name length'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Invalid Slug","slug":"Invalid Slug"}'::jsonb)$$,
  '22023', 'product slug must use 1 to 120 lowercase letters, numbers, or single hyphens',
  'product creation enforces a canonical slug'
);

select is(
  (select status from public.create_admin_product('{"name":"  First Product  ","slug":"first-product"}'::jsonb)),
  'draft'::public.product_status,
  'an owner creates a trimmed draft product'
);
select is(
  (select name from public.get_admin_products() where slug = 'first-product'),
  'First Product',
  'the product directory returns the normalized product name'
);
select throws_ok(
  $$select * from public.create_admin_product('{"name":"Duplicate","slug":"first-product"}'::jsonb)$$,
  '23505', null,
  'duplicate product slugs are rejected by the canonical unique constraint'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000032', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000032","role":"authenticated","email":"admin-operations@example.test","amr":[{"method":"password","timestamp":1787950008}]}',
  true
);
select is(
  (select status from public.create_admin_product('{"name":"Operations Product","slug":"operations-product"}'::jsonb)),
  'draft'::public.product_status,
  'an operations administrator can create a draft product'
);

reset role;
select is(
  (
    select actor_user_id
    from public.audit_logs
    where target_table = 'products'
      and action = 'insert'
      and after_data ->> 'slug' = 'first-product'
  ),
  '10000000-0000-0000-0000-000000000031'::uuid,
  'the product audit row records the creating administrator'
);
select is(
  (
    select actor_type
    from public.audit_logs
    where target_table = 'products'
      and action = 'insert'
      and after_data ->> 'slug' = 'first-product'
  ),
  'admin',
  'the product audit row identifies an administrator action'
);
select is(
  (
    select after_data ->> 'status'
    from public.audit_logs
    where target_table = 'products'
      and action = 'insert'
      and after_data ->> 'slug' = 'first-product'
  ),
  'draft',
  'the immutable audit snapshot records the forced draft status'
);

select * from finish();
rollback;
