begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_table('public', 'billing_offers', 'server-owned billing offers exist');
select has_table('public', 'checkout_attempts', 'durable checkout attempts exist');
select has_column('public', 'provider_events', 'livemode', 'provider environment is explicit');
select has_column('public', 'provider_event_processing', 'claim_token', 'worker claims use opaque tokens');
select has_column('public', 'provider_event_processing', 'lease_expires_at', 'worker claims have bounded leases');
select has_function(
  'public', 'prepare_checkout_attempt', array['jsonb'],
  'service checkout preparation RPC exists'
);
select has_function(
  'public', 'finalize_checkout_attempt', array['jsonb'],
  'service checkout finalization RPC exists'
);
select has_function(
  'public', 'claim_provider_events', array['text', 'integer', 'integer'],
  'provider queue claim RPC exists'
);
select has_function(
  'public', 'complete_provider_event', array['uuid', 'uuid'],
  'provider queue completion RPC exists'
);
select has_function(
  'public', 'fail_provider_event', array['uuid', 'uuid', 'text', 'integer', 'boolean'],
  'provider queue failure RPC exists'
);

select ok(
  not has_function_privilege('authenticated', 'public.prepare_checkout_attempt(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.finalize_checkout_attempt(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_provider_events(text,integer,integer)', 'EXECUTE'),
  'authenticated browsers cannot execute billing or worker boundaries'
);
select ok(
  has_function_privilege('service_role', 'public.prepare_checkout_attempt(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.finalize_checkout_attempt(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_provider_events(text,integer,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.complete_provider_event(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.fail_provider_event(uuid,uuid,text,integer,boolean)', 'EXECUTE'),
  'the Edge service role alone receives the billing and worker RPC grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.billing_offers', 'SELECT')
  and not has_table_privilege('authenticated', 'public.checkout_attempts', 'SELECT')
  and not has_table_privilege('service_role', 'public.billing_offers', 'SELECT')
  and not has_table_privilege('service_role', 'public.checkout_attempts', 'SELECT'),
  'billing base tables are accessible only through constrained functions'
);

insert into public.platform_settings (singleton, tracking_base_url)
values (true, 'https://go.example.test')
on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url;

insert into public.products (id, slug, name, status)
values
  ('20000000-0000-4000-8000-000000000071', 'billing-product', 'Billing Product', 'active'),
  ('20000000-0000-4000-8000-000000000072', 'draft-billing-product', 'Draft Billing Product', 'draft');

insert into public.affiliates (
  id, public_name, slug, reporting_timezone, preferred_currency, status
)
values (
  '30000000-0000-4000-8000-000000000071',
  'Billing Partner', 'billing-partner', 'UTC', 'USD', 'active'
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values (
  '50000000-0000-4000-8000-000000000071',
  '20000000-0000-4000-8000-000000000071',
  'billing-funnel', 'Billing Funnel', 'https://product.example.test/start', 'live', true
);

insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
  sub1, status
)
values (
  '60000000-0000-4000-8000-000000000071',
  '30000000-0000-4000-8000-000000000071',
  '20000000-0000-4000-8000-000000000071',
  '50000000-0000-4000-8000-000000000071',
  'Billing route', 'billingbilling071',
  'https://go.example.test/r/billing-partner/billingbilling071',
  'checkout', 'paused'
);

insert into public.clicks (
  id, public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id,
  sub1, destination_url_snapshot, is_bot
)
values (
  '61000000-0000-4000-8000-000000000071',
  'clickclickclick071',
  '60000000-0000-4000-8000-000000000071',
  '30000000-0000-4000-8000-000000000071',
  '20000000-0000-4000-8000-000000000071',
  '50000000-0000-4000-8000-000000000071',
  'checkout', 'https://product.example.test/start', false
);

insert into public.acquisitions (
  id, product_id, affiliate_id, click_record_id, funnel_id,
  attribution_method, status
)
values (
  '62000000-0000-4000-8000-000000000071',
  '20000000-0000-4000-8000-000000000071',
  '30000000-0000-4000-8000-000000000071',
  '61000000-0000-4000-8000-000000000071',
  '50000000-0000-4000-8000-000000000071',
  'deterministic_web', 'open'
);

select throws_ok(
  $$insert into public.billing_offers (product_id, key, name, billing_mode, stripe_price_id, currency, unit_amount_minor, success_url_template, cancel_url, status) values ('20000000-0000-4000-8000-000000000072', 'monthly', 'Monthly', 'subscription', 'price_DraftProduct071', 'USD', 1999, 'https://product.example.test/success?session_id={CHECKOUT_SESSION_ID}', 'https://product.example.test/cancel', 'active')$$,
  '23514', 'an active billing offer requires an active product',
  'a draft product cannot expose an active checkout offer'
);

select throws_ok(
  $$insert into public.billing_offers (product_id, key, name, billing_mode, stripe_price_id, currency, unit_amount_minor, success_url_template, cancel_url, status) values ('20000000-0000-4000-8000-000000000071', 'one-time', 'One-time purchase', 'payment', 'price_OneTimeDormant071', 'USD', 4999, 'https://product.example.test/success?session_id={CHECKOUT_SESSION_ID}', 'https://product.example.test/cancel', 'active')$$,
  'P0001', 'enable the managed checkout integration before activating a one-time offer',
  'one-time offers cannot activate without an explicitly enabled managed checkout integration'
);

select lives_ok(
  $$insert into public.billing_offers (product_id, key, name, billing_mode, stripe_price_id, currency, unit_amount_minor, success_url_template, cancel_url, status) values ('20000000-0000-4000-8000-000000000071', 'one-time', 'One-time purchase', 'payment', 'price_OneTimeDormant071', 'USD', 4999, 'https://product.example.test/success?session_id={CHECKOUT_SESSION_ID}', 'https://product.example.test/cancel', 'draft')$$,
  'a real one-time Stripe price can be configured safely while the offer remains dormant'
);

insert into public.managed_payment_products(product_id, enabled)
values('20000000-0000-4000-8000-000000000071', true);
update public.billing_offers set status='active'
where product_id='20000000-0000-4000-8000-000000000071' and key='one-time';
select throws_ok(
  $$select * from public.prepare_checkout_attempt('{"click_id":"clickclickclick071","offer_key":"one-time","idempotency_key":"managedlegacyblocked071"}'::jsonb)$$,
  'P0002', 'billing offer is unavailable',
  'an enabled managed one-time offer cannot bypass its signed order API through legacy checkout'
);

insert into public.billing_offers (
  id, product_id, key, version, name, billing_mode, stripe_price_id, currency,
  unit_amount_minor, success_url_template, cancel_url, status
)
values (
  '70000000-0000-4000-8000-000000000071',
  '20000000-0000-4000-8000-000000000071',
  'monthly', 1, 'Monthly subscription', 'subscription',
  'price_LiveConfigured071', 'USD', 1999,
  'https://product.example.test/success?session_id={CHECKOUT_SESSION_ID}',
  'https://product.example.test/cancel', 'active'
);

select throws_ok(
  $$update public.billing_offers set unit_amount_minor = 1 where id = '70000000-0000-4000-8000-000000000071'$$,
  'P0001', 'activated billing terms are immutable; create a new offer version',
  'activated server-owned amounts cannot be rewritten'
);

set local role authenticated;
select throws_ok(
  $$select * from public.prepare_checkout_attempt('{"click_id":"clickclickclick071","offer_key":"monthly","idempotency_key":"nonce_nonce_nonce_071"}'::jsonb)$$,
  '42501', null,
  'browser roles cannot prepare checkout attempts'
);

reset role;
set local role service_role;

select throws_ok(
  $$select * from public.prepare_checkout_attempt('{"click_id":"clickclickclick071","offer_key":"monthly","idempotency_key":"nonce_nonce_nonce_071","amount_minor":1}'::jsonb)$$,
  '22023', 'checkout input contains unsupported fields',
  'the funnel cannot override price or amount fields'
);

select lives_ok(
  $$select * from public.prepare_checkout_attempt('{"click_id":"clickclickclick071","offer_key":"monthly","idempotency_key":"nonce_nonce_nonce_071"}'::jsonb)$$,
  'the service boundary prepares a checkout from canonical attribution and offer data'
);

select is(
  (select unit_amount_minor from public.prepare_checkout_attempt('{"click_id":"clickclickclick071","offer_key":"monthly","idempotency_key":"nonce_nonce_nonce_071"}'::jsonb)),
  1999::bigint,
  'checkout retries return the immutable server-owned amount'
);

reset role;
select is(
  (select count(*) from public.checkout_attempts where idempotency_key = 'nonce_nonce_nonce_071'),
  1::bigint,
  'the HMAC nonce-backed idempotency key creates exactly one attempt'
);

set local role service_role;
select lives_ok(
  $$select * from public.finalize_checkout_attempt(jsonb_build_object('attempt_id',(select attempt_id from public.prepare_checkout_attempt('{"click_id":"clickclickclick071","offer_key":"monthly","idempotency_key":"nonce_nonce_nonce_071"}'::jsonb)),'status','open','stripe_session_id','cs_live_abcdefgh071','checkout_url','https://checkout.stripe.com/c/pay/abcdefgh071','expires_at',now() + interval '1 hour'))$$,
  'a valid live Stripe Checkout Session opens the prepared attempt'
);

reset role;
select is(
  (select status from public.checkout_attempts where idempotency_key = 'nonce_nonce_nonce_071'),
  'open',
  'the durable attempt records the open provider state'
);

set local role service_role;
select throws_ok(
  $$select * from public.finalize_checkout_attempt(jsonb_build_object('attempt_id',(select attempt_id from public.prepare_checkout_attempt('{"click_id":"clickclickclick071","offer_key":"monthly","idempotency_key":"nonce_nonce_nonce_071"}'::jsonb)),'status','open','stripe_session_id','cs_test_abcdefgh071','checkout_url','https://checkout.stripe.com/c/pay/abcdefgh071','expires_at',now() + interval '1 hour'))$$,
  '22023', 'Stripe checkout session response is invalid',
  'test-mode Stripe sessions cannot enter the production attempt ledger'
);

reset role;
update public.billing_offers
set status = 'paused'
where id = '70000000-0000-4000-8000-000000000071';
update public.checkout_attempts
set status = 'completed', completed_at = now();
select is(
  (select status from public.checkout_attempts),
  'completed',
  'an existing checkout can complete after new sales for its offer are paused'
);

set local role service_role;
select throws_ok(
  $$select * from public.prepare_checkout_attempt('{"click_id":"clickclickclick071","offer_key":"monthly","idempotency_key":"another_nonce_nonce_071"}'::jsonb)$$,
  'P0002', 'billing offer is unavailable',
  'paused offers fail closed for new checkout attempts'
);
reset role;

insert into public.provider_events (
  id, provider, provider_event_id, event_type, payload, signature_verified
)
values
  (
    '80000000-0000-4000-8000-000000000071', 'stripe', 'evt_live_worker_071',
    'invoice.paid', '{"id":"evt_live_worker_071","livemode":true,"data":{"object":{}}}', true
  ),
  (
    '80000000-0000-4000-8000-000000000072', 'stripe', 'evt_test_worker_071',
    'invoice.paid', '{"id":"evt_test_worker_071","livemode":false,"data":{"object":{}}}', true
  );
insert into public.provider_event_processing (provider_event_id)
values
  ('80000000-0000-4000-8000-000000000071'),
  ('80000000-0000-4000-8000-000000000072');

select is(
  (select livemode from public.provider_events where id = '80000000-0000-4000-8000-000000000071'),
  true,
  'live mode is derived from the signed immutable provider payload'
);
select is(
  (select livemode from public.provider_events where id = '80000000-0000-4000-8000-000000000072'),
  false,
  'test mode remains explicitly non-production'
);

create temporary table first_claim (
  provider_event_id uuid,
  claim_token uuid,
  provider public.provider_name,
  external_event_id text,
  event_type text,
  payload jsonb,
  attempt_count integer,
  received_at timestamptz
);
grant select, insert on first_claim to service_role;
set local role service_role;
insert into first_claim
select * from public.claim_provider_events('stripe-worker', 10, 60);
reset role;

select is((select count(*) from first_claim), 1::bigint, 'only one live verified Stripe event is claimable');
select is(
  (select provider_event_id from first_claim),
  '80000000-0000-4000-8000-000000000071'::uuid,
  'the worker claim excludes test-mode provider callbacks'
);
select is(
  (select status from public.provider_event_processing where provider_event_id = '80000000-0000-4000-8000-000000000072'),
  'pending'::public.processing_status,
  'test-mode callbacks remain quarantined and unprocessed'
);

set local role service_role;
select is(
  public.complete_provider_event(
    '80000000-0000-4000-8000-000000000071',
    '99999999-9999-4999-8999-999999999999'
  ),
  false,
  'an incorrect claim token cannot complete another worker lease'
);
select is(
  public.fail_provider_event(
    '80000000-0000-4000-8000-000000000071',
    (select claim_token from first_claim),
    'transient_provider_error', 0, false
  ),
  'pending'::public.processing_status,
  'a leased event can be returned to the retry queue with a safe error code'
);
reset role;
create temporary table second_claim (
  provider_event_id uuid,
  claim_token uuid,
  provider public.provider_name,
  external_event_id text,
  event_type text,
  payload jsonb,
  attempt_count integer,
  received_at timestamptz
);
grant select, insert on second_claim to service_role;
set local role service_role;
insert into second_claim
select * from public.claim_provider_events('stripe-worker', 10, 60);
select is((select attempt_count from second_claim), 2, 'a retry increments the durable attempt counter');
select is(
  public.complete_provider_event(
    '80000000-0000-4000-8000-000000000071',
    (select claim_token from second_claim)
  ),
  true,
  'the current lease holder can atomically complete the provider event'
);
reset role;

select is(
  (select status from public.provider_event_processing where provider_event_id = '80000000-0000-4000-8000-000000000071'),
  'processed'::public.processing_status,
  'completed provider processing is durable'
);
select is(
  (select count(*) from public.transactions where acquisition_id = '62000000-0000-4000-8000-000000000071'),
  0::bigint,
  'queue handling alone never fabricates canonical money'
);

insert into public.accounts (id, external_key)
values ('90000000-0000-4000-8000-000000000071', 'billing-account-071');
update public.acquisitions
set
  account_id = '90000000-0000-4000-8000-000000000071',
  status = 'resolved',
  resolved_at = now()
where id = '62000000-0000-4000-8000-000000000071';
insert into public.subscriptions (
  id, account_id, product_id, acquisition_id, stripe_customer_id,
  stripe_subscription_id, status, currency
)
values (
  '91000000-0000-4000-8000-000000000071',
  '90000000-0000-4000-8000-000000000071',
  '20000000-0000-4000-8000-000000000071',
  '62000000-0000-4000-8000-000000000071',
  'cus_live_billing071', 'sub_live_billing071', 'active', 'USD'
);

select throws_ok(
  $$insert into public.transactions (subscription_id, acquisition_id, provider_event_id, stripe_invoice_id, kind, gross_minor, fee_minor, tax_minor, eligible_net_minor, currency, settled_currency, occurred_at) values ('91000000-0000-4000-8000-000000000071','62000000-0000-4000-8000-000000000071','80000000-0000-4000-8000-000000000072','in_test_billing071','first_purchase',1999,100,0,1899,'USD','USD',now())$$,
  '23514', 'transaction requires a signature-verified live Stripe payment event',
  'test-mode provider evidence cannot create canonical payable money'
);

select lives_ok(
  $$insert into public.transactions (subscription_id, acquisition_id, provider_event_id, stripe_invoice_id, kind, gross_minor, fee_minor, tax_minor, eligible_net_minor, currency, settled_currency, occurred_at) values ('91000000-0000-4000-8000-000000000071','62000000-0000-4000-8000-000000000071','80000000-0000-4000-8000-000000000071','in_live_billing071','first_purchase',1999,100,0,1899,'USD','USD',now())$$,
  'live signature-verified Stripe evidence can create the existing subscription-backed canonical transaction'
);

select * from finish();
rollback;
