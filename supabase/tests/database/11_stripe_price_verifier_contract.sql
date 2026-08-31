begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function(
  'public',
  'get_admin_billing_offer_verification_candidate',
  array['uuid'],
  'Admin Stripe Price verification candidate RPC exists'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.get_admin_billing_offer_verification_candidate(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_admin_billing_offer_verification_candidate(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.get_admin_billing_offer_verification_candidate(uuid)',
    'EXECUTE'
  ),
  'only an authenticated Admin session can request a verification candidate'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'price-owner@example.test',
    '$2a$10$priceOwnerPasswordHash00000000000000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'price-finance@example.test',
    '$2a$10$priceFinancePasswordHash000000000000000000000000000000',
    now(), '{}', '{}', now(), now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000201', 'owner', true),
  ('10000000-0000-0000-0000-000000000202', 'finance', true);

insert into public.products (id, slug, name, status)
values (
  '20000000-0000-0000-0000-000000000201',
  'price-verifier-product',
  'Price Verifier Product',
  'active'
);

insert into public.billing_offers (
  id, product_id, key, version, name, billing_mode, stripe_price_id,
  currency, unit_amount_minor, success_url_template, cancel_url, status
)
values
  (
    '30000000-0000-0000-0000-000000000201',
    '20000000-0000-0000-0000-000000000201',
    'monthly', 1, 'Monthly', 'subscription', 'price_VerifierLive201',
    'USD', 1999,
    'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
    'https://app.kissmyapps.dev/checkout', 'draft'
  ),
  (
    '30000000-0000-0000-0000-000000000202',
    '20000000-0000-0000-0000-000000000201',
    'incomplete', 1, 'Incomplete', 'subscription', null, null, null,
    null, null, 'draft'
  );

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000202', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000202","role":"authenticated","amr":[{"method":"password","timestamp":1787952000}]}',
  true
);
select throws_ok(
  $$select public.get_admin_billing_offer_verification_candidate('30000000-0000-0000-0000-000000000201')$$,
  '42501',
  'admin role cannot verify billing offers',
  'Finance cannot request live Price verification'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000201', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000201","role":"authenticated","amr":[{"method":"password","timestamp":1787952001}]}',
  true
);
select is(
  public.get_admin_billing_offer_verification_candidate(
    '30000000-0000-0000-0000-000000000201'
  ),
  jsonb_build_object(
    'billing_offer_id', '30000000-0000-0000-0000-000000000201'::uuid,
    'stripe_price_id', 'price_VerifierLive201',
    'currency', 'USD',
    'unit_amount_minor', 1999,
    'billing_mode', 'subscription'
  ),
  'the verifier receives only exact server-owned draft offer facts'
);
select throws_ok(
  $$select public.get_admin_billing_offer_verification_candidate('30000000-0000-0000-0000-000000000202')$$,
  'P0001',
  'complete the Stripe Price, currency, and amount before verification',
  'incomplete draft offers fail closed before a Stripe request'
);

reset role;
select * from finish();
rollback;
