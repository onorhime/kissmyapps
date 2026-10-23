begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '10000000-0000-0000-0000-000000000051',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'tracking-partner@example.test', '', now(),
  '{}', '{"full_name":"Tracking Partner"}', now(), now()
);

insert into public.platform_settings (tracking_base_url)
values ('https://go.kissmyapps.dev');

insert into public.products (id, slug, name, status)
values (
  '20000000-0000-0000-0000-000000000051',
  'tracking-product', 'Tracking Product', 'active'
);

insert into public.affiliates (
  id, public_name, slug, reporting_timezone, preferred_currency, status
)
values (
  '30000000-0000-0000-0000-000000000051',
  'Tracking Partner', 'tracking-partner', 'UTC', 'USD', 'active'
);

insert into public.affiliate_users (
  affiliate_id, user_id, role, active, activation_pending, activated_at
)
values (
  '30000000-0000-0000-0000-000000000051',
  '10000000-0000-0000-0000-000000000051',
  'owner', true, false, now()
);

insert into public.agreements (
  id, affiliate_id, product_id, version, model, status, starts_at,
  payout_currency, minimum_payout_minor
)
values
  (
    '40000000-0000-0000-0000-000000000051',
    '30000000-0000-0000-0000-000000000051',
    '20000000-0000-0000-0000-000000000051',
    1, 'cpl', 'draft', now() - interval '1 day', 'USD', 1000
  ),
  (
    '40000000-0000-0000-0000-000000000052',
    '30000000-0000-0000-0000-000000000051',
    '20000000-0000-0000-0000-000000000051',
    2, 'cpa', 'draft', now() - interval '1 day', 'USD', 1000
  );

insert into public.commission_rules (
  id, agreement_id, name, version, status, model, trigger_event,
  fixed_amount_minor, currency
)
values
  (
    '41000000-0000-0000-0000-000000000051',
    '40000000-0000-0000-0000-000000000051',
    'Qualified funnel start', 1, 'active', 'cpl', 'funnel_started', 500, 'USD'
  ),
  (
    '41000000-0000-0000-0000-000000000052',
    '40000000-0000-0000-0000-000000000052',
    'Paid purchase', 1, 'active', 'cpa', 'purchase.completed', 2500, 'USD'
  );

insert into public.documents (
  id, affiliate_id, agreement_id, name, document_type, version, file_path, status,
  effective_at, signed_by_partner_at, signed_by_kissmyapps_at
)
values (
  '42000000-0000-0000-0000-000000000052',
  '30000000-0000-0000-0000-000000000051',
  '40000000-0000-0000-0000-000000000052',
  'Signed affiliate agreement', 'affiliate_agreement', 2,
  '30000000-0000-0000-0000-000000000051/agreements/version-2.pdf',
  'active', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'
);

update public.agreements
set status = 'active'
where id = '40000000-0000-0000-0000-000000000051';
update public.agreements
set status = 'superseded', ends_at = now() + interval '1 day'
where id = '40000000-0000-0000-0000-000000000051';
update public.agreements
set status = 'active'
where id = '40000000-0000-0000-0000-000000000052';

insert into public.billing_offers (
  id, product_id, key, version, name, billing_mode, stripe_price_id, currency,
  unit_amount_minor, success_url_template, cancel_url, status,
  verified_stripe_price_id, verified_currency, verified_unit_amount_minor,
  verified_billing_mode, stripe_livemode_verified_at
)
values (
  '70000000-0000-0000-0000-000000000051',
  '20000000-0000-0000-0000-000000000051',
  'monthly', 1, 'Monthly subscription', 'subscription', 'price_TrackingMonthly051', 'USD',
  1999, 'https://funnel.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
  'https://funnel.kissmyapps.dev/cancel', 'active',
  'price_TrackingMonthly051', 'USD', 1999, 'subscription', now()
);

insert into public.funnels (
  id, product_id, key, name, destination_url, status, is_default
)
values
  (
    '50000000-0000-0000-0000-000000000051',
    '20000000-0000-0000-0000-000000000051',
    'default-funnel', 'Default Funnel', 'https://funnel.example.test/start', 'live', true
  ),
  (
    '50000000-0000-0000-0000-000000000052',
    '20000000-0000-0000-0000-000000000051',
    'alternate-funnel', 'Alternate Funnel', 'https://alternate.example.test/start', 'live', false
  );

insert into public.sources (id, key, name)
values ('51000000-0000-0000-0000-000000000051', 'tracking-fixture-tiktok', 'TikTok');

insert into public.campaigns (id, product_id, key, name, status)
values (
  '52000000-0000-0000-0000-000000000051',
  '20000000-0000-0000-0000-000000000051',
  'launch', 'Launch', 'active'
);

insert into public.affiliate_links (
  id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
  is_main, status, created_by
)
values (
  '60000000-0000-0000-0000-000000000051',
  '30000000-0000-0000-0000-000000000051',
  '20000000-0000-0000-0000-000000000051',
  '50000000-0000-0000-0000-000000000051',
  'Main link', 'mainmainmainmain',
  'https://go.kissmyapps.dev/r/tracking-partner/mainmainmainmain',
  true, 'active', '10000000-0000-0000-0000-000000000051'
);

insert into public.affiliate_links (
  id, affiliate_id, product_id, source_id, campaign_id, funnel_id, name,
  public_code, tracking_url, parent_link_id, sub1, sub2, sub3, status, created_by
)
values (
  '60000000-0000-0000-0000-000000000052',
  '30000000-0000-0000-0000-000000000051',
  '20000000-0000-0000-0000-000000000051',
  '51000000-0000-0000-0000-000000000051',
  '52000000-0000-0000-0000-000000000051',
  '50000000-0000-0000-0000-000000000051',
  'TikTok bio', 'subsubsubsubsub1',
  'https://go.kissmyapps.dev/r/tracking-partner/subsubsubsubsub1',
  '60000000-0000-0000-0000-000000000051',
  'bio', 'profile', 'creative-a', 'active',
  '10000000-0000-0000-0000-000000000051'
);

select is(
  (select tracking_enabled from public.platform_settings where singleton),
  false,
  'production tracking remains disabled until explicitly enabled'
);

select throws_ok(
  $$insert into public.funnels (product_id, key, name, destination_url, status, is_default) values ('20000000-0000-0000-0000-000000000051', 'second-default', 'Second Default', 'https://second.example.test', 'live', true)$$,
  '23505', null,
  'a product cannot have two default funnels'
);

select throws_ok(
  $$insert into public.affiliate_links (affiliate_id, product_id, funnel_id, name, public_code, tracking_url, is_main, status) values ('30000000-0000-0000-0000-000000000051', '20000000-0000-0000-0000-000000000051', '50000000-0000-0000-0000-000000000052', 'Wrong Funnel Main', 'wrongmainwrongmain', 'https://go.kissmyapps.dev/r/tracking-partner/wrongmainwrongmain', true, 'active')$$,
  '23514', 'a main link must route through the product default funnel',
  'a main link cannot route through a non-default funnel'
);

select throws_ok(
  $$insert into public.affiliate_links (affiliate_id, product_id, funnel_id, name, public_code, tracking_url, is_main, sub1, status) values ('30000000-0000-0000-0000-000000000051', '20000000-0000-0000-0000-000000000051', '50000000-0000-0000-0000-000000000051', 'Tagged Main', 'taggedmaintagged1', 'https://go.kissmyapps.dev/r/tracking-partner/taggedmaintagged1', true, 'tagged', 'active')$$,
  '23514', 'main links cannot contain parent, source, campaign, or Sub ID dimensions',
  'a main link cannot carry source or Sub ID attribution'
);

select throws_ok(
  $$insert into public.affiliate_links (affiliate_id, product_id, funnel_id, name, public_code, tracking_url, parent_link_id, sub1, status) values ('30000000-0000-0000-0000-000000000051', '20000000-0000-0000-0000-000000000051', '50000000-0000-0000-0000-000000000051', 'Nested Variant', 'nestednestednest1', 'https://go.kissmyapps.dev/r/tracking-partner/nestednestednest1', '60000000-0000-0000-0000-000000000052', 'nested', 'active')$$,
  '23514', 'parent link must be the current active main link with the same scope',
  'a sub-link cannot be parented to another sub-link'
);

select throws_ok(
  $$update public.affiliate_links set sub1 = 'rewritten' where id = '60000000-0000-0000-0000-000000000052'$$,
  'P0001', 'issued link attribution, commercial scope, and routing are immutable',
  'issued Sub IDs cannot be rewritten after link creation'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000051', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000051","role":"authenticated","email":"tracking-partner@example.test"}', true);

select is(
  (select main_tracking_url from public.partner_product_directory),
  null::text,
  'the coded main link is withheld while production tracking is disabled'
);

reset role;
set local role service_role;

select throws_ok(
  $$select * from public.register_tracking_click('tracking-partner', 'subsubsubsubsub1', '{"country_code":"US"}'::jsonb)$$,
  'P0002', 'tracking route is unavailable',
  'the redirect boundary fails closed while tracking is disabled'
);

reset role;
update public.platform_settings set tracking_enabled = true where singleton;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000051', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000051","role":"authenticated","email":"tracking-partner@example.test"}', true);

select is(
  (select main_tracking_url from public.partner_product_directory),
  'https://go.kissmyapps.dev/r/tracking-partner/mainmainmainmain',
  'the product directory returns the actual issued coded main link'
);

reset role;
set local role service_role;

select lives_ok(
  $$select * from public.register_tracking_click('tracking-partner', 'subsubsubsubsub1', '{"country_code":"US","session_id_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","user_agent_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ip_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","is_bot":false}'::jsonb)$$,
  'the service role atomically registers a valid production click'
);

reset role;

select set_config(
  'test.tracking_click_id',
  (select public_click_id from public.clicks where not is_bot),
  true
);
select set_config(
  'test.tracking_click_occurred_at',
  (select occurred_at::text from public.clicks where not is_bot),
  true
);

select is((select count(*) from public.clicks), 1::bigint, 'one accepted redirect creates exactly one click');
select is((select count(*) from public.acquisitions), 1::bigint, 'the same redirect creates exactly one acquisition');
select is((select sub1 from public.clicks), 'bio', 'clicks snapshot sub1');
select is((select sub2 from public.clicks), 'profile', 'clicks snapshot sub2');
select is((select sub3 from public.clicks), 'creative-a', 'clicks snapshot sub3');
select is(
  (select destination_url_snapshot from public.clicks),
  'https://funnel.example.test/start',
  'clicks snapshot the exact resolved funnel destination'
);
select is(
  (select status from public.acquisitions),
  'open'::public.acquisition_status,
  'a non-bot click starts an open deterministic acquisition'
);

select throws_ok(
  $$insert into public.clicks (public_click_id, affiliate_link_id, affiliate_id, product_id, source_id, campaign_id, funnel_id, sub1, sub2, sub3, destination_url_snapshot) values ('mismatchmismatch12', '60000000-0000-0000-0000-000000000052', '30000000-0000-0000-0000-000000000051', '20000000-0000-0000-0000-000000000051', '51000000-0000-0000-0000-000000000051', '52000000-0000-0000-0000-000000000051', '50000000-0000-0000-0000-000000000051', 'wrong', 'profile', 'creative-a', 'https://funnel.example.test/start')$$,
  '23514', 'click dimensions, commercial scope, and destination must match the issued link',
  'raw click inserts cannot forge a different Sub ID snapshot'
);

update public.funnels
set destination_url = 'https://funnel.example.test/revised'
where id = '50000000-0000-0000-0000-000000000051';

select is(
  (select destination_url_snapshot from public.clicks),
  'https://funnel.example.test/start',
  'later funnel edits cannot rewrite a historical click destination'
);

insert into public.accounts (id, external_key)
values ('42000000-0000-0000-0000-000000000051', 'tracking-account-51');

update public.acquisitions
set
  account_id = '42000000-0000-0000-0000-000000000051',
  status = 'resolved',
  resolved_at = now()
where click_record_id = (select id from public.clicks where not is_bot);

set local role service_role;

select lives_ok(
  $$select * from public.ingest_browser_event(jsonb_build_object('event_id','80000000-0000-0000-0000-000000000051','event_name','funnel_started','click_id',current_setting('test.tracking_click_id'),'occurred_at',current_setting('test.tracking_click_occurred_at'),'properties',jsonb_build_object('step','landing')))$$,
  'the service boundary accepts an allowlisted browser event'
);

select is(
  (select duplicate from public.ingest_browser_event(jsonb_build_object('event_id','80000000-0000-0000-0000-000000000051','event_name','funnel_started','click_id',current_setting('test.tracking_click_id'),'occurred_at',current_setting('test.tracking_click_occurred_at'),'properties',jsonb_build_object('step','landing')))),
  true,
  'browser event retries are idempotent'
);

select throws_ok(
  $$select * from public.ingest_browser_event(jsonb_build_object('event_id','80000000-0000-0000-0000-000000000052','event_name','purchase','click_id',current_setting('test.tracking_click_id'),'occurred_at',now(),'properties','{}'::jsonb))$$,
  '22023', 'browser event name is not allowed',
  'browser clients cannot submit a commercial purchase event'
);

select lives_ok(
  $$select * from public.ingest_funnel_event(jsonb_build_object('event_id','81000000-0000-0000-0000-000000000051','event_name','funnel_started','click_id',current_setting('test.tracking_click_id'),'occurred_at',current_setting('test.tracking_click_occurred_at'),'properties',jsonb_build_object('verified',true)))$$,
  'the authenticated funnel boundary records trusted evidence'
);

reset role;

select is(
  (select trust from public.events where source_event_id = 'browser:80000000-0000-0000-0000-000000000051'),
  'browser'::public.event_trust,
  'browser events retain the browser trust classification'
);
select is(
  (select commercial_eligible from public.events where source_event_id = 'browser:80000000-0000-0000-0000-000000000051'),
  false,
  'browser events are never marked commercially eligible'
);
select is(
  (select trust from public.events where source_event_id = 'funnel:81000000-0000-0000-0000-000000000051'),
  'funnel_server'::public.event_trust,
  'authenticated funnel events retain the trusted server classification'
);
select is(
  (select commercial_eligible from public.events where source_event_id = 'funnel:81000000-0000-0000-0000-000000000051'),
  true,
  'authenticated funnel events can support a configured commercial rule'
);

select throws_ok(
  $$insert into public.events (source, source_event_id, event_name, product_id, affiliate_id, acquisition_id, account_id, source_id, campaign_id, funnel_id, properties, occurred_at, trust, commercial_eligible) select 'first_party', 'mismatched-event-51', 'funnel_started', acquisition.product_id, acquisition.affiliate_id, acquisition.id, acquisition.account_id, acquisition.source_id, acquisition.campaign_id, '50000000-0000-0000-0000-000000000052', '{}', now(), 'funnel_server', true from public.acquisitions as acquisition where acquisition.click_record_id = (select id from public.clicks where not is_bot)$$,
  '23514', 'event dimensions must match its canonical acquisition',
  'trusted ingestion cannot forge a different funnel dimension'
);

select throws_ok(
  $$insert into public.conversions (acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, qualified, occurred_at) select event.acquisition_id, event.affiliate_id, event.product_id, '40000000-0000-0000-0000-000000000051', '41000000-0000-0000-0000-000000000051', event.id, event.event_name, event.account_id, true, event.occurred_at from public.events as event where event.source_event_id = 'browser:80000000-0000-0000-0000-000000000051'$$,
  '23514', 'conversions require commercially eligible attribution and events',
  'a browser event cannot qualify a CPL conversion'
);

select lives_ok(
  $$insert into public.conversions (acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id, event_id, event_name, account_id, qualified, occurred_at) select event.acquisition_id, event.affiliate_id, event.product_id, '40000000-0000-0000-0000-000000000051', '41000000-0000-0000-0000-000000000051', event.id, event.event_name, event.account_id, true, event.occurred_at from public.events as event where event.source_event_id = 'funnel:81000000-0000-0000-0000-000000000051'$$,
  'trusted funnel evidence can qualify the configured CPL conversion'
);

set local role service_role;

select lives_ok(
  $$select * from public.register_tracking_click('tracking-partner', 'subsubsubsubsub1', '{"country_code":"US","is_bot":true}'::jsonb)$$,
  'the redirect boundary records recognized bot traffic for auditability'
);

reset role;
select set_config(
  'test.tracking_bot_click_id',
  (select public_click_id from public.clicks where is_bot),
  true
);
set local role service_role;

select throws_ok(
  $$select * from public.ingest_browser_event(jsonb_build_object('event_id','80000000-0000-0000-0000-000000000053','event_name','landing_viewed','click_id',current_setting('test.tracking_bot_click_id'),'occurred_at',now(),'properties','{}'::jsonb))$$,
  'P0002', 'click is unavailable for event ingestion',
  'recognized bot clicks cannot send canonical browser events'
);

reset role;

select is(
  (select status from public.acquisitions where click_record_id = (select id from public.clicks where is_bot)),
  'rejected'::public.acquisition_status,
  'recognized bot clicks create rejected rather than open acquisitions'
);
select is(
  (select rejection_reason from public.acquisitions where click_record_id = (select id from public.clicks where is_bot)),
  'automated_traffic',
  'the rejected acquisition retains the non-sensitive bot reason'
);

select * from finish();
rollback;
