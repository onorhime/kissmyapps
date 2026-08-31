begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

select has_table('public', 'stripe_customer_accounts', 'Stripe customer bindings exist');
select has_table('public', 'stripe_subscription_evidence', 'Stripe subscription evidence exists');
select has_table('public', 'stripe_transaction_evidence', 'Stripe transaction evidence exists');
select has_function(
  'public', 'normalize_stripe_provider_event', array['uuid', 'uuid', 'jsonb'],
  'atomic Stripe normalization RPC exists'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.normalize_stripe_provider_event(uuid,uuid,jsonb)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.normalize_stripe_provider_event(uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  'only the Edge service role can normalize leased provider evidence'
);
select ok(
  not has_table_privilege('service_role', 'public.stripe_customer_accounts', 'SELECT')
  and not has_table_privilege('authenticated', 'public.stripe_customer_accounts', 'SELECT')
  and not has_table_privilege('service_role', 'public.stripe_transaction_evidence', 'INSERT'),
  'evidence tables cannot be read or forged directly by API roles'
);

insert into public.platform_settings (singleton, tracking_base_url, tracking_enabled)
values (true, 'https://go.example.test', true)
on conflict (singleton) do update set
  tracking_base_url = excluded.tracking_base_url,
  tracking_enabled = excluded.tracking_enabled;

insert into public.products (id, slug, name, status)
values ('21000000-0000-4000-8000-000000000081', 'stripe-product', 'Stripe Product', 'active');

insert into public.affiliates (
  id, public_name, slug, reporting_timezone, preferred_currency, status
) values (
  '31000000-0000-4000-8000-000000000081',
  'Stripe Partner', 'stripe-partner', 'UTC', 'USD', 'active'
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
) values (
  '51000000-0000-4000-8000-000000000081',
  '21000000-0000-4000-8000-000000000081',
  'stripe-funnel', 'Stripe Funnel', 'https://product.example.test/start', 'live', true
);

insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
  sub1, status
) values (
  '61000000-0000-4000-8000-000000000081',
  '31000000-0000-4000-8000-000000000081',
  '21000000-0000-4000-8000-000000000081',
  '51000000-0000-4000-8000-000000000081',
  'Stripe route', 'stripestripe0081',
  'https://go.example.test/r/stripe-partner/stripestripe0081',
  'checkout', 'paused'
);

insert into public.clicks (
  id, public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id,
  sub1, destination_url_snapshot, is_bot
) values (
  '62000000-0000-4000-8000-000000000081',
  'stripe-click-click-081',
  '61000000-0000-4000-8000-000000000081',
  '31000000-0000-4000-8000-000000000081',
  '21000000-0000-4000-8000-000000000081',
  '51000000-0000-4000-8000-000000000081',
  'checkout', 'https://product.example.test/start', false
);

insert into public.acquisitions (
  id, product_id, affiliate_id, click_record_id, funnel_id,
  attribution_method, status
) values (
  '63000000-0000-4000-8000-000000000081',
  '21000000-0000-4000-8000-000000000081',
  '31000000-0000-4000-8000-000000000081',
  '62000000-0000-4000-8000-000000000081',
  '51000000-0000-4000-8000-000000000081',
  'deterministic_web', 'open'
);

insert into public.billing_offers (
  id, product_id, key, name, billing_mode, stripe_price_id, currency,
  unit_amount_minor, success_url_template, cancel_url, status
) values (
  '71000000-0000-4000-8000-000000000081',
  '21000000-0000-4000-8000-000000000081',
  'monthly', 'Monthly', 'subscription', 'price_StripeLive081', 'USD', 1999,
  'https://product.example.test/success?session_id={CHECKOUT_SESSION_ID}',
  'https://product.example.test/cancel', 'active'
);

insert into public.checkout_attempts (
  id, public_attempt_id, idempotency_key, billing_offer_id, product_id,
  acquisition_id, click_record_id, affiliate_id, billing_mode, stripe_price_id,
  currency, unit_amount_minor, success_url_snapshot, cancel_url_snapshot
) values (
  '72000000-0000-4000-8000-000000000081',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'stripe_nonce_nonce_081',
  '71000000-0000-4000-8000-000000000081',
  '21000000-0000-4000-8000-000000000081',
  '63000000-0000-4000-8000-000000000081',
  '62000000-0000-4000-8000-000000000081',
  '31000000-0000-4000-8000-000000000081',
  'subscription', 'price_StripeLive081', 'USD', 1999,
  'https://product.example.test/success?session_id={CHECKOUT_SESSION_ID}',
  'https://product.example.test/cancel'
);

update public.checkout_attempts
set
  status = 'open',
  stripe_checkout_session_id = 'cs_live_stripecheckout081',
  checkout_url = 'https://checkout.stripe.com/c/pay/stripecheckout081',
  stripe_session_expires_at = now() + interval '1 hour'
where id = '72000000-0000-4000-8000-000000000081';

insert into public.provider_events (
  id, provider, provider_event_id, event_type, payload, signature_verified
) values (
  '81000000-0000-4000-8000-000000000081',
  'stripe', 'evt_checkout_live_081', 'checkout.session.completed',
  jsonb_build_object(
    'id', 'evt_checkout_live_081',
    'type', 'checkout.session.completed',
    'livemode', true,
    'created', extract(epoch from now())::bigint,
    'data', jsonb_build_object('object', jsonb_build_object(
      'id', 'cs_live_stripecheckout081',
      'object', 'checkout.session',
      'mode', 'subscription',
      'status', 'complete',
      'payment_status', 'paid',
      'amount_total', 1999,
      'currency', 'usd',
      'customer', 'cus_stripecustomer081',
      'subscription', 'sub_stripesubscription081',
      'client_reference_id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'metadata', jsonb_build_object(
        'kma_attempt_id', '72000000-0000-4000-8000-000000000081',
        'kma_public_attempt_id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'kma_offer_id', '71000000-0000-4000-8000-000000000081',
        'kma_product_id', '21000000-0000-4000-8000-000000000081',
        'kma_acquisition_id', '63000000-0000-4000-8000-000000000081',
        'kma_click_id', '62000000-0000-4000-8000-000000000081',
        'kma_expected_amount_minor', '1999',
        'kma_expected_currency', 'USD'
      )
    ))
  ),
  true
);
insert into public.provider_event_processing (provider_event_id)
values ('81000000-0000-4000-8000-000000000081');

create temporary table stripe_claims as
select * from public.claim_provider_events('stripe-worker', 10, 180) with no data;
grant select, insert, delete on stripe_claims to service_role;

set local role service_role;
insert into stripe_claims select * from public.claim_provider_events('stripe-worker', 10, 180);
select lives_ok(
  format(
    $$select public.normalize_stripe_provider_event(
      '81000000-0000-4000-8000-000000000081',
      %L,
      '{"kind":"checkout_subscription_paid","object_id":"cs_live_stripecheckout081","subscription_id":"sub_stripesubscription081","subscription_customer_id":"cus_stripecustomer081","subscription_attempt_id":"72000000-0000-4000-8000-000000000081","subscription_status":"active","subscription_currency":"USD","period_start":1787904000,"period_end":1790582400,"cancelled_at":null,"subscription_livemode":true}'::jsonb
    )$$,
    (select claim_token from stripe_claims where provider_event_id = '81000000-0000-4000-8000-000000000081')
  ),
  'a paid subscription Checkout atomically resolves attribution and canonical identity'
);
reset role;

select is(
  (select status from public.checkout_attempts where id = '72000000-0000-4000-8000-000000000081'),
  'completed',
  'the matched checkout attempt completes'
);
select is(
  (select status from public.acquisitions where id = '63000000-0000-4000-8000-000000000081'),
  'resolved'::public.acquisition_status,
  'the exact acquisition resolves to the Stripe-backed account'
);
select is((select count(*) from public.stripe_customer_accounts), 1::bigint, 'one PII-free customer binding is created');
select is((select count(*) from public.subscriptions), 1::bigint, 'one canonical subscription is created');
select is((select count(*) from public.events where event_name = 'checkout.completed'), 1::bigint, 'Checkout evidence becomes one non-commercial event fact');
select is(
  (select status from public.provider_event_processing where provider_event_id = '81000000-0000-4000-8000-000000000081'),
  'processed'::public.processing_status,
  'normalization and lease completion commit atomically'
);

insert into public.provider_events (
  id, provider, provider_event_id, event_type, payload, signature_verified
) values (
  '81000000-0000-4000-8000-000000000082',
  'stripe', 'evt_invoice_live_081', 'invoice.paid',
  jsonb_build_object(
    'id', 'evt_invoice_live_081', 'type', 'invoice.paid', 'livemode', true,
    'created', extract(epoch from now())::bigint,
    'data', jsonb_build_object('object', jsonb_build_object(
      'id', 'in_stripeinvoice081', 'object', 'invoice', 'status', 'paid', 'paid', true,
      'amount_paid', 1999, 'total', 1999, 'total_excluding_tax', 1799,
      'currency', 'usd', 'customer', 'cus_stripecustomer081',
      'subscription', 'sub_stripesubscription081',
      'billing_reason', 'subscription_create',
      'status_transitions', jsonb_build_object('paid_at', extract(epoch from now())::bigint)
    ))
  ), true
);
insert into public.provider_event_processing (provider_event_id)
values ('81000000-0000-4000-8000-000000000082');
delete from stripe_claims;
set local role service_role;
insert into stripe_claims select * from public.claim_provider_events('stripe-worker', 10, 180);
select lives_ok(
  format(
    $$select public.normalize_stripe_provider_event(
      '81000000-0000-4000-8000-000000000082', %L,
      '{"kind":"invoice_paid","object_id":"in_stripeinvoice081","subscription_id":"sub_stripesubscription081","customer_id":"cus_stripecustomer081","payment_intent_id":"pi_stripeintent081","charge_id":"ch_stripecharge081","balance_transaction_id":"txn_stripebalance081","charge_amount_minor":1999,"charge_currency":"USD","charge_paid":true,"charge_livemode":true,"payment_intent_status":"succeeded","payment_intent_livemode":true,"balance_amount_minor":1999,"balance_fee_minor":100,"balance_net_minor":1899,"balance_currency":"USD"}'::jsonb
    )$$,
    (select claim_token from stripe_claims where provider_event_id = '81000000-0000-4000-8000-000000000082')
  ),
  'an exactly reconciled paid invoice creates one canonical transaction'
);
reset role;

select is((select gross_minor from public.transactions), 1999::bigint, 'signed invoice gross is retained exactly');
select is((select fee_minor from public.transactions), 100::bigint, 'retrieved balance fee is retained exactly');
select is((select tax_minor from public.transactions), 200::bigint, 'invoice tax evidence is retained exactly');
select is((select eligible_net_minor from public.transactions), 1699::bigint, 'eligible net is exact, not estimated');
select is((select count(*) from public.stripe_transaction_evidence), 1::bigint, 'charge and PaymentIntent evidence map to the transaction');
select is((select count(*) from public.events where event_name = 'purchase.completed' and commercial_eligible), 1::bigint, 'paid invoice creates one commercially eligible purchase event');

insert into public.provider_events (
  id, provider, provider_event_id, event_type, payload, signature_verified
) values (
  '81000000-0000-4000-8000-000000000083',
  'stripe', 'evt_refund_live_081', 'refund.created',
  '{"id":"evt_refund_live_081","type":"refund.created","livemode":true,"created":1787904000,"data":{"object":{"id":"re_striperefund081","object":"refund","status":"succeeded","charge":"ch_stripecharge081","amount":500,"currency":"usd","created":1787904000}}}'::jsonb,
  true
), (
  '81000000-0000-4000-8000-000000000084',
  'stripe', 'evt_dispute_live_081', 'charge.dispute.created',
  '{"id":"evt_dispute_live_081","type":"charge.dispute.created","livemode":true,"created":1787904000,"data":{"object":{"id":"dp_stripedispute081","object":"dispute","status":"needs_response","charge":"ch_stripecharge081","amount":600,"currency":"usd","created":1787904000,"balance_transactions":[{"id":"txn_disputebalance081","amount":-600,"fee":15,"net":-615,"currency":"usd","created":1787904000}]}}}'::jsonb,
  true
);
insert into public.provider_event_processing (provider_event_id)
values
  ('81000000-0000-4000-8000-000000000083'),
  ('81000000-0000-4000-8000-000000000084');
delete from stripe_claims;
set local role service_role;
insert into stripe_claims select * from public.claim_provider_events('stripe-worker', 10, 180);
select lives_ok(
  format(
    $$select public.normalize_stripe_provider_event('81000000-0000-4000-8000-000000000083', %L, '{"kind":"refund_succeeded","object_id":"re_striperefund081"}'::jsonb)$$,
    (select claim_token from stripe_claims where provider_event_id = '81000000-0000-4000-8000-000000000083')
  ),
  'a succeeded refund maps through the exact canonical charge'
);
select lives_ok(
  format(
    $$select public.normalize_stripe_provider_event('81000000-0000-4000-8000-000000000084', %L, '{"kind":"dispute_changed","object_id":"dp_stripedispute081"}'::jsonb)$$,
    (select claim_token from stripe_claims where provider_event_id = '81000000-0000-4000-8000-000000000084')
  ),
  'an open dispute records its exact signed withdrawal and fee impact'
);
reset role;

select is((select amount_minor from public.refunds), 500::bigint, 'refund amount is exact');
select is((select balance_impact_minor from public.refunds), (-500)::bigint, 'refund reversal is exact');
select is((select disputed_minor from public.disputes), 600::bigint, 'disputed amount is exact');
select is((select fee_minor from public.disputes), 15::bigint, 'dispute fee comes from signed balance evidence');
select is((select balance_impact_minor from public.disputes), (-615)::bigint, 'dispute withdrawal reconciles amount plus fee');

select * from finish();
rollback;
