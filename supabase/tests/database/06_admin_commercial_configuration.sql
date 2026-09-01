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
    '10000000-0000-0000-0000-000000000061',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'admin-config-owner@example.test',
    '$2a$10$adminConfigOwnerPasswordHash000000000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000062',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'admin-config-operations@example.test',
    '$2a$10$adminConfigOperationsPasswordHash000000000000000000000',
    now(), '{}', '{}', now(), now()
  ),
  (
    '10000000-0000-0000-0000-000000000063',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'admin-config-partner@example.test',
    '$2a$10$adminConfigPartnerPasswordHash000000000000000000000000',
    now(), '{}', '{}', now(), now()
  );

insert into public.admin_users (user_id, role, active)
values
  ('10000000-0000-0000-0000-000000000061', 'owner', true),
  ('10000000-0000-0000-0000-000000000062', 'operations', true);

insert into public.affiliates (id, public_name, slug, status)
values (
  '30000000-0000-0000-0000-000000000061',
  'Admin Config Partner',
  'admin-config-partner',
  'active'
);

insert into public.affiliate_users (
  affiliate_id, user_id, role, active, activation_pending, activated_at
)
values (
  '30000000-0000-0000-0000-000000000061',
  '10000000-0000-0000-0000-000000000063',
  'owner', true, false, now()
);

insert into public.products (id, slug, name, status)
values (
  '20000000-0000-0000-0000-000000000061',
  'pgtap-admin-commercial-config',
  'pgTAP Admin Commercial Config',
  'draft'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000062', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000062","role":"authenticated","amr":[{"method":"password","timestamp":1787951000}]}',
  true
);

select throws_ok(
  $$select public.configure_admin_tracking('{"base_url":"https://go.example.com","enabled":true,"expected_updated_at":null}'::jsonb)$$,
  '42501', 'admin role cannot configure tracking',
  'operations cannot configure the platform tracking origin'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000061', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000061","role":"authenticated","amr":[{"method":"totp","timestamp":1787951001}]}',
  true
);
select throws_ok(
  $$select public.create_admin_funnel('{"product_id":"20000000-0000-0000-0000-000000000061","key":"primary","name":"Primary","destination_url":"https://funnel.example.com/start","is_default":true}'::jsonb)$$,
  '42501', 'Create Funnels requires a password-authenticated session',
  'configuration mutation requires password authentication'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000061","role":"authenticated","amr":[{"method":"password","timestamp":1787951002}]}',
  true
);

select throws_ok(
  $$select public.create_admin_source('[]'::jsonb)$$,
  '22023', 'source input must contain exactly key and name',
  'source mutation rejects non-object JSON without leaking an internal cast error'
);
select throws_ok(
  $$select public.set_admin_funnel_status('[]'::jsonb)$$,
  '22023', 'funnel status input must contain exactly funnel_id and status',
  'status mutation rejects non-object JSON before reading fields'
);
select throws_ok(
  $$select public.create_admin_agreement('{"affiliate_id":"30000000-0000-0000-0000-000000000061","product_id":61,"model":"cpa","payout_currency":"USD"}'::jsonb)$$,
  '22023', 'agreement input types are invalid',
  'agreement mutation rejects a non-string product UUID'
);
select throws_ok(
  $$select public.issue_admin_main_link('{"affiliate_id":61,"product_id":"20000000-0000-0000-0000-000000000061"}'::jsonb)$$,
  '22023', 'affiliate_id and product_id must be UUIDs',
  'main-link issuance rejects non-string identity values'
);

select throws_ok(
  $$select public.configure_admin_tracking('{"base_url":"http://127.0.0.1:5173","enabled":true,"expected_updated_at":null}'::jsonb)$$,
  '22023', 'tracking base URL must equal https://go.kissmyapps.dev',
  'tracking configuration rejects localhost and non-HTTPS origins'
);
select throws_ok(
  $$select public.configure_admin_tracking('{"base_url":"https://go.example.test","enabled":true,"expected_updated_at":null}'::jsonb)$$,
  '22023', 'tracking base URL must equal https://go.kissmyapps.dev',
  'tracking configuration rejects reserved test domains'
);
select throws_ok(
  $$select public.configure_admin_tracking('{"base_url":"https://go.example.com","enabled":true,"expected_updated_at":null}'::jsonb)$$,
  '22023', 'tracking base URL must equal https://go.kissmyapps.dev',
  'tracking configuration rejects IANA example domains'
);
select is(
  public.configure_admin_tracking('{"base_url":"https://go.kissmyapps.dev","enabled":false,"expected_updated_at":null}'::jsonb) ->> 'enabled',
  'false',
  'an owner can configure a production HTTPS tracking origin while the kill switch remains off'
);

select throws_ok(
  $$select public.create_admin_funnel('{"product_id":"20000000-0000-0000-0000-000000000061","key":"test-host","name":"Test Host","destination_url":"https://funnel.example.test/start","is_default":false}'::jsonb)$$,
  '22023', 'funnel destination must be an HTTPS URL',
  'funnel creation rejects a reserved test destination'
);

select is(
  public.create_admin_funnel(
    '{"product_id":"20000000-0000-0000-0000-000000000061","key":"primary","name":"Primary Funnel","destination_url":"https://funnel.kissmyapps.dev/start","is_default":true}'::jsonb
  ) ->> 'status',
  'draft',
  'a production funnel begins in draft'
);
select is(
  public.set_admin_funnel_status(
    jsonb_build_object(
      'funnel_id', (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{funnels,0,id}')::uuid,
      'status', 'live'
    )
  ) ->> 'status',
  'live',
  'a configured HTTPS funnel can become live'
);

select is(
  public.create_admin_source('{"key":"tiktok-organic","name":"TikTok organic"}'::jsonb) ->> 'active',
  'true',
  'a canonical traffic source begins active'
);
select throws_ok(
  $$select public.create_admin_source('{"key":"TikTok","name":"Bad source"}'::jsonb)$$,
  '22023', 'source key and name are invalid',
  'source creation enforces canonical keys'
);

select is(
  public.create_admin_campaign(
    '{"product_id":"20000000-0000-0000-0000-000000000061","key":"launch","name":"Launch"}'::jsonb
  ) ->> 'status',
  'draft',
  'a campaign begins in draft'
);
select is(
  public.set_admin_campaign_status(
    jsonb_build_object(
      'campaign_id', (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{campaigns,0,id}')::uuid,
      'status', 'active'
    )
  ) ->> 'status',
  'active',
  'a draft campaign can become active'
);

select is(
  public.create_admin_agreement(
    '{"affiliate_id":"30000000-0000-0000-0000-000000000061","product_id":"20000000-0000-0000-0000-000000000061","model":"cpa","attribution_window_days":30,"payout_frequency_days":14,"payout_currency":"USD","minimum_payout_minor":10000}'::jsonb
  ) ->> 'status',
  'draft',
  'commercial terms begin as a versioned draft agreement'
);

select throws_ok(
  $$select public.create_admin_commission_rule(jsonb_build_object('agreement_id',(public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{agreements,0,id}')::uuid,'name','Missing amount','model','cpa','trigger_event','purchase.completed','currency','USD'))$$,
  '23514', null,
  'a fixed commission cannot omit its amount'
);
select is(
  public.create_admin_commission_rule(
    jsonb_build_object(
      'agreement_id', (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{agreements,0,id}')::uuid,
      'name', 'First paid customer',
      'model', 'cpa',
      'trigger_event', 'purchase.completed',
      'fixed_amount_minor', 2500,
      'currency', 'USD',
      'validation_window_hours', 72
    )
  ) ->> 'status',
  'draft',
  'a complete commission rule begins in draft'
);
select is(
  public.set_admin_commission_rule_status(
    jsonb_build_object(
      'commission_rule_id', (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{agreements,0,rules,0,id}')::uuid,
      'status', 'active'
    )
  ) ->> 'status',
  'active',
  'a valid commission rule can become active'
);
select throws_ok(
  $$select public.activate_admin_agreement(jsonb_build_object('agreement_id',(public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{agreements,0,id}')::uuid))$$,
  'P0001', 'agreement activation requires a current bilaterally signed document',
  'an unsigned agreement cannot become effective'
);

reset role;
insert into public.documents (
  affiliate_id, agreement_id, name, document_type, version, file_path, status,
  effective_at, signed_by_partner_at, signed_by_kissmyapps_at
)
values (
  '30000000-0000-0000-0000-000000000061',
  (
    select id from public.agreements
    where affiliate_id = '30000000-0000-0000-0000-000000000061'
      and product_id = '20000000-0000-0000-0000-000000000061'
      and version = 1
  ),
  'Signed affiliate agreement', 'affiliate_agreement', 1,
  '30000000-0000-0000-0000-000000000061/agreements/version-1.pdf',
  'active', now(), now(), now()
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000061', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000061","role":"authenticated","amr":[{"method":"password","timestamp":1787951002}]}',
  true
);
select is(
  public.activate_admin_agreement(
    jsonb_build_object(
      'agreement_id', (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{agreements,0,id}')::uuid
    )
  ) ->> 'status',
  'active',
  'an agreement with an active rule can become effective'
);
select is(
  public.activate_admin_product('{"product_id":"20000000-0000-0000-0000-000000000061"}'::jsonb) ->> 'status',
  'active',
  'the product activates only after its production gates are satisfied'
);

reset role;
insert into public.billing_offers (
  product_id, key, version, name, billing_mode, stripe_price_id, currency,
  unit_amount_minor, success_url_template, cancel_url, status,
  verified_stripe_price_id, verified_currency, verified_unit_amount_minor,
  verified_billing_mode, stripe_livemode_verified_at
)
values (
  '20000000-0000-0000-0000-000000000061',
  'monthly', 1, 'Monthly subscription', 'subscription', 'price_AdminCommercial061', 'USD',
  1999, 'https://funnel.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
  'https://funnel.kissmyapps.dev/cancel', 'active',
  'price_AdminCommercial061', 'USD', 1999, 'subscription', now()
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000061', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000061","role":"authenticated","amr":[{"method":"password","timestamp":1787951002}]}',
  true
);

select is(
  public.configure_admin_tracking(
    jsonb_build_object(
      'base_url', 'https://go.kissmyapps.dev',
      'enabled', true,
      'expected_updated_at', public.get_admin_platform_settings() #>> '{tracking,updated_at}'
    )
  ) ->> 'enabled',
  'true',
  'the owner can enable tracking after the correlated production gates are satisfied'
);

select is(
  public.issue_admin_main_link(
    '{"affiliate_id":"30000000-0000-0000-0000-000000000061","product_id":"20000000-0000-0000-0000-000000000061"}'::jsonb
  ) ->> 'is_main',
  'true',
  'the administrator can issue the canonical partner-product main link'
);
select matches(
  (
    public.issue_admin_main_link(
      '{"affiliate_id":"30000000-0000-0000-0000-000000000061","product_id":"20000000-0000-0000-0000-000000000061"}'::jsonb
    ) ->> 'tracking_url'
  ),
  '^https://go\.kissmyapps\.dev/r/admin-config-partner/[a-f0-9]{36}$',
  'main-link issuance is idempotent and uses the configured coded route'
);
select is(
  (
    select jsonb_array_length(
      public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') -> 'main_links'
    )
  ),
  1::integer,
  'only one current main link exists for a partner and product'
);

select ok(
  (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{readiness,has_live_default_funnel}')::boolean
  and (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{readiness,has_active_agreement}')::boolean
  and (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{readiness,has_active_billing_offer}')::boolean
  and (public.get_admin_product_configuration('20000000-0000-0000-0000-000000000061') #>> '{readiness,tracking_ready}')::boolean,
  'the admin configuration returns its authoritative production readiness gates'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000063', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000063","role":"authenticated","amr":[{"method":"password","timestamp":1787951003}]}',
  true
);

select is(
  (select count(*) from public.partner_product_directory where id = '20000000-0000-0000-0000-000000000061' and main_tracking_url is not null),
  1::bigint,
  'the active partner receives the server-issued main link from the product directory'
);
select is(
  (select count(*) from public.partner_link_directory),
  0::bigint,
  'the main link is not misrepresented as a partner-created dimensional link'
);

select is(
  (
    select count(*)
    from public.create_partner_link(
      jsonb_build_object(
        'name', 'TikTok launch',
        'product_id', '20000000-0000-0000-0000-000000000061',
        'funnel_id', (select id from public.partner_link_option_directory where kind = 'funnel' and key = 'primary'),
        'source_id', (select id from public.partner_link_option_directory where kind = 'source' and key = 'tiktok-organic'),
        'campaign_id', (select id from public.partner_link_option_directory where kind = 'campaign' and key = 'launch'),
        'sub1', 'bio',
        'sub2', null,
        'sub3', null,
        'parent_link_id', null
      )
    )
  ),
  1::bigint,
  'a partner can create a dimensional link after production readiness is established'
);
select throws_ok(
  $$select * from public.update_partner_link((select id from public.partner_link_directory where name = 'TikTok launch'), '{"source_id":null}'::jsonb)$$,
  '22023', 'issued link attribution is immutable; only name may be updated',
  'issued source, campaign, funnel, and Sub ID dimensions cannot be rewritten'
);
select is(
  (select name from public.update_partner_link((select id from public.partner_link_directory where name = 'TikTok launch'), '{"name":"TikTok profile"}'::jsonb)),
  'TikTok profile',
  'a partner can rename a custom link without changing attribution identity'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000061', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000061","role":"authenticated","amr":[{"method":"password","timestamp":1787951004}]}',
  true
);
select throws_ok(
  $$select public.archive_admin_source((select id from public.get_admin_sources() where key = 'tiktok-organic'))$$,
  'P0001', 'pause or archive active links before archiving this source',
  'an administrator cannot invalidate an active link by archiving its source'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000063', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000063","role":"authenticated","amr":[{"method":"password","timestamp":1787951005}]}',
  true
);
select is(
  (select status from public.set_partner_link_status((select id from public.partner_link_directory where name = 'TikTok profile'), 'paused')),
  'paused'::public.link_status,
  'the partner can pause a custom link before its source is archived'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000061', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000061","role":"authenticated","amr":[{"method":"password","timestamp":1787951006}]}',
  true
);
select is(
  public.archive_admin_source((select id from public.get_admin_sources() where key = 'tiktok-organic')) ->> 'active',
  'false',
  'an unused source can be archived without deleting history'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000063', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000063","role":"authenticated","amr":[{"method":"password","timestamp":1787951007}]}',
  true
);
select is(
  (select count(*) from public.partner_link_option_directory where kind = 'source' and key = 'tiktok-organic'),
  0::bigint,
  'archived sources disappear from partner link options'
);
select throws_ok(
  $$select * from public.set_partner_link_status((select id from public.partner_link_directory where name = 'TikTok profile'), 'active')$$,
  '23514', 'active links require an active source',
  'a custom link cannot reactivate against an archived source'
);

reset role;
select * from finish();
rollback;
