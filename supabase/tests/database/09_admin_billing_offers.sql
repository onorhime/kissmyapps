begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_function(
  'public', 'create_admin_billing_offer', array['jsonb'],
  'admin billing-offer creation RPC exists'
);
select has_function(
  'public', 'update_admin_billing_offer', array['jsonb'],
  'admin billing-offer draft update RPC exists'
);
select has_function(
  'public', 'set_admin_billing_offer_status', array['jsonb'],
  'admin billing-offer lifecycle RPC exists'
);
select has_function(
  'public', 'record_billing_offer_stripe_verification', array['jsonb'],
  'service-only Stripe Price attestation RPC exists'
);
select ok(
  has_function_privilege('authenticated', 'public.create_admin_billing_offer(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.update_admin_billing_offer(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_admin_billing_offer_status(jsonb)', 'EXECUTE')
  and not has_function_privilege(
    'authenticated', 'public.record_billing_offer_stripe_verification(jsonb)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.record_billing_offer_stripe_verification(jsonb)', 'EXECUTE'
  ),
  'browser and service RPC grants are separated at the provider-verification boundary'
);

create temporary table billing_offer_test_ids (
  label text primary key,
  id uuid not null unique
) on commit drop;
grant select, insert on pg_temp.billing_offer_test_ids to authenticated, service_role;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000091',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'billing-owner@example.test',
    '$2a$10$billingOwnerPasswordHash000000000000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000092',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'billing-operations@example.test',
    '$2a$10$billingOperationsPasswordHash00000000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000093',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'billing-finance@example.test',
    '$2a$10$billingFinancePasswordHash0000000000000000000000000000',
    now(), '{}', '{}', now(), now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000091', 'owner', true),
  ('10000000-0000-0000-0000-000000000092', 'operations', true),
  ('10000000-0000-0000-0000-000000000093', 'finance', true);

insert into public.products (id, slug, name, status)
values
  (
    '20000000-0000-0000-0000-000000000091',
    'admin-billing-active', 'Admin Billing Active', 'active'
  ),
  (
    '20000000-0000-0000-0000-000000000092',
    'admin-billing-draft', 'Admin Billing Draft', 'draft'
  );

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000093', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000093","role":"authenticated","amr":[{"method":"password","timestamp":1787952000}]}',
  true
);
select throws_ok(
  $$select public.create_admin_billing_offer('{"product_id":"20000000-0000-0000-0000-000000000091","key":"monthly","name":"Monthly","billing_mode":"subscription"}'::jsonb)$$,
  '42501', 'admin role cannot create billing offers',
  'Finance cannot mutate billing configuration'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000092', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000092","role":"authenticated","amr":[{"method":"totp","timestamp":1787952001}]}',
  true
);
select throws_ok(
  $$select public.create_admin_billing_offer('{"product_id":"20000000-0000-0000-0000-000000000091","key":"monthly","name":"Monthly","billing_mode":"subscription"}'::jsonb)$$,
  '42501', 'Create Billing Offers requires a password-authenticated session',
  'Operations billing mutations require password AMR'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000091', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000091","role":"authenticated","amr":[{"method":"password","timestamp":1787952002}]}',
  true
);

select throws_ok(
  $$select public.create_admin_billing_offer('{"product_id":"20000000-0000-0000-0000-000000000091","key":"bad-host","name":"Bad host","billing_mode":"subscription","success_url_template":"https://checkout.example.test/success","stripe_secret_key":"sk_live_never_allowed"}'::jsonb)$$,
  '22023', 'billing offer input contains unsupported or missing fields',
  'browser payloads cannot add Stripe secrets or unsupported provider facts'
);

with created as materialized (
  select public.create_admin_billing_offer(
    '{"product_id":"20000000-0000-0000-0000-000000000091","key":"monthly","name":"Monthly subscription","billing_mode":"subscription","stripe_price_id":"price_AdminMonthly091","currency":"USD","unit_amount_minor":1999,"success_url_template":"https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}","cancel_url":"https://app.kissmyapps.dev/checkout"}'::jsonb
  ) as value
), captured as (
  insert into pg_temp.billing_offer_test_ids (label, id)
  select 'monthly-v1', (created.value ->> 'id')::uuid from created
  returning id
)
select is(
  (select created.value ->> 'status' from created cross join captured),
  'draft',
  'a complete subscription configuration still begins as a draft'
);
with created as materialized (
  select public.create_admin_billing_offer(
    '{"product_id":"20000000-0000-0000-0000-000000000091","key":"monthly","name":"Monthly subscription next","billing_mode":"subscription"}'::jsonb
  ) as value
), captured as (
  insert into pg_temp.billing_offer_test_ids (label, id)
  select 'monthly-v2', (created.value ->> 'id')::uuid from created
  returning id
)
select is(
  (select (created.value ->> 'version')::integer from created cross join captured),
  2,
  'the server allocates an immutable next version for the same offer key'
);
select is(
  jsonb_array_length(
    public.get_admin_product_configuration('20000000-0000-0000-0000-000000000091')
      -> 'billing_offers'
  ),
  2,
  'the Admin product configuration lists real billing-offer versions'
);

select throws_ok(
  $$select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',(select id from pg_temp.billing_offer_test_ids where label = 'monthly-v1'),'status','active'))$$,
  'P0001', 'the configured Stripe Price must be verified in live mode before activation',
  'a typed Price ID is not treated as live provider verification'
);

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select throws_ok(
  $$select public.record_billing_offer_stripe_verification(jsonb_build_object('billing_offer_id',(select id from pg_temp.billing_offer_test_ids where label = 'monthly-v1'),'stripe_price_id','price_AdminMonthly091','livemode',false,'active',true,'currency','USD','unit_amount_minor',1999,'billing_mode','subscription'))$$,
  '22023', 'only an active live-mode Stripe Price can be verified',
  'test-mode Stripe Prices cannot satisfy the production gate'
);
select throws_ok(
  $$select public.record_billing_offer_stripe_verification(jsonb_build_object('billing_offer_id',(select id from pg_temp.billing_offer_test_ids where label = 'monthly-v1'),'stripe_price_id','price_AdminMonthly091','livemode',true,'active',true,'currency','USD','unit_amount_minor',1,'billing_mode','subscription'))$$,
  '23514', 'Stripe Price facts do not exactly match the configured offer',
  'provider verification requires the exact configured minor-unit amount'
);
select ok(
  public.record_billing_offer_stripe_verification(
    jsonb_build_object(
      'billing_offer_id', (select id from pg_temp.billing_offer_test_ids where label = 'monthly-v1'),
      'stripe_price_id', 'price_AdminMonthly091',
      'livemode', true,
      'active', true,
      'currency', 'USD',
      'unit_amount_minor', 1999,
      'billing_mode', 'subscription'
    )
  ),
  'the service boundary can attest exact active live Stripe Price facts'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000091', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000091","role":"authenticated","amr":[{"method":"password","timestamp":1787952003}]}',
  true
);
select is(
  public.set_admin_billing_offer_status(
    jsonb_build_object(
      'billing_offer_id', (select id from pg_temp.billing_offer_test_ids where label = 'monthly-v1'),
      'status', 'active'
    )
  ) ->> 'status',
  'active',
  'a live-verified subscription on an active product can be activated'
);
select throws_ok(
  $$select public.update_admin_billing_offer(jsonb_build_object('billing_offer_id',(select id from pg_temp.billing_offer_test_ids where label = 'monthly-v1'),'name','Changed','billing_mode','subscription','stripe_price_id','price_AdminMonthly091','currency','USD','unit_amount_minor',1,'success_url_template','https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}','cancel_url','https://app.kissmyapps.dev/checkout'))$$,
  'P0001', 'only draft billing offers can be edited',
  'activated billing terms cannot be rewritten'
);

reset role;
insert into public.platform_settings (singleton, tracking_base_url, tracking_enabled)
values (true, 'https://go.kissmyapps.dev', true)
on conflict (singleton) do update
set tracking_base_url = excluded.tracking_base_url,
    tracking_enabled = excluded.tracking_enabled;
insert into public.affiliates (id, public_name, slug, status)
values (
  '30000000-0000-0000-0000-000000000091',
  'Billing Partner', 'billing-partner', 'active'
);
insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  payout_currency, minimum_payout_minor
)
values (
  '40000000-0000-0000-0000-000000000091',
  '30000000-0000-0000-0000-000000000091',
  '20000000-0000-0000-0000-000000000091',
  1, 'cpa', 'draft', now() - interval '1 day', 'USD', 10000
);
insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values (
  '41000000-0000-0000-0000-000000000091',
  '40000000-0000-0000-0000-000000000091',
  'Paid purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD'
);
insert into public.documents (
  id, affiliate_id, agreement_id, name, document_type, version, file_path, status,
  effective_at, signed_by_partner_at, signed_by_kissmyapps_at
)
values (
  '42000000-0000-0000-0000-000000000091',
  '30000000-0000-0000-0000-000000000091',
  '40000000-0000-0000-0000-000000000091',
  'Signed affiliate agreement', 'affiliate_agreement', 1,
  '30000000-0000-0000-0000-000000000091/agreements/version-1.pdf',
  'active', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'
);
update public.agreements
set status = 'active'
where id = '40000000-0000-0000-0000-000000000091';
insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values (
  '50000000-0000-0000-0000-000000000091',
  '20000000-0000-0000-0000-000000000091',
  'primary', 'Primary Funnel', 'https://app.kissmyapps.dev/start', 'live', true
);
insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
  is_main, status, created_by
)
values (
  '60000000-0000-0000-0000-000000000091',
  '30000000-0000-0000-0000-000000000091',
  '20000000-0000-0000-0000-000000000091',
  '50000000-0000-0000-0000-000000000091',
  'Main link', 'adminbillingmain1',
  (
    select setting.tracking_base_url || '/r/billing-partner/adminbillingmain1'
    from public.platform_settings as setting
    where setting.singleton
  ),
  true, 'active', '10000000-0000-0000-0000-000000000091'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000091', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000091","role":"authenticated","amr":[{"method":"password","timestamp":1787952003}]}',
  true
);
select throws_ok(
  $$select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',(select id from pg_temp.billing_offer_test_ids where label = 'monthly-v1'),'status','paused'))$$,
  'P0001', 'pause active partner links or activate a replacement offer first',
  'the last launch-ready offer cannot be paused while a partner link remains active'
);

reset role;
update public.affiliate_links
set status = 'paused'
where id = '60000000-0000-0000-0000-000000000091';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000091', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000091","role":"authenticated","amr":[{"method":"password","timestamp":1787952003}]}',
  true
);
select is(
  public.set_admin_billing_offer_status(
    jsonb_build_object(
      'billing_offer_id', (select id from pg_temp.billing_offer_test_ids where label = 'monthly-v1'),
      'status', 'paused'
    )
  ) ->> 'status',
  'paused',
  'an active offer can be explicitly paused'
);

with created as materialized (
  select public.create_admin_billing_offer(
    '{"product_id":"20000000-0000-0000-0000-000000000091","key":"lifetime","name":"Lifetime","billing_mode":"payment","stripe_price_id":"price_AdminPayment091","currency":"USD","unit_amount_minor":4999,"success_url_template":"https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}","cancel_url":"https://app.kissmyapps.dev/checkout"}'::jsonb
  ) as value
), captured as (
  insert into pg_temp.billing_offer_test_ids (label, id)
  select 'lifetime-v1', (created.value ->> 'id')::uuid from created
  returning id
)
select is(
  (select created.value ->> 'status' from created cross join captured),
  'draft',
  'payment mode can be configured only as a truthful draft'
);
select throws_ok(
  $$select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',(select id from pg_temp.billing_offer_test_ids where label = 'lifetime-v1'),'status','active'))$$,
  'P0001', 'enable the managed checkout integration before activating a one-time offer',
  'the server blocks payment-mode activation'
);

select is(
  public.update_admin_billing_offer(
    jsonb_build_object(
      'billing_offer_id', (select id from pg_temp.billing_offer_test_ids where label = 'monthly-v2'),
      'name', 'Monthly subscription next',
      'billing_mode', 'subscription',
      'stripe_price_id', 'price_AdminMonthlyNext091',
      'currency', 'USD',
      'unit_amount_minor', 2499,
      'success_url_template', 'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
      'cancel_url', 'https://app.kissmyapps.dev/checkout'
    )
  ) ->> 'stripe_price_verified',
  'false',
  'draft edits clear provider verification rather than carrying stale facts forward'
);

reset role;
select * from finish();
rollback;
