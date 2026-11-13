-- Phase 6 working with Phases 1 to 5 through the real functions only: a web funnel with no
-- payment rewards a creator for a sign-up and for one later event, within a budget, and the
-- merchant is charged for it. The merchant's analytics already receives the events; the
-- merchant picks two of them, sets a budget and publishes; a creator joins; a visitor opens
-- the creator's link and lands with kma_click; the analytics intake stores the visit and the
-- events exactly as the web SDK sends them; the minute tick judges them; the reward and the
-- KissMyApps fee are set aside from the prepaid balance; the rules (once per person, own
-- action, daily share, monthly budget) hold; the merchant rejects one reward during the hold;
-- after the hold the rest are the creator's and KissMyApps sees them as owed. Stripe is never
-- called: each service function is given what its edge function passes after reading Stripe.
begin;
set local time zone 'UTC';
create temporary table e2e_reward_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program rewards end to end assertion failed: %', label; end if;
  insert into e2e_reward_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.t(k text) returns text language sql as $$ select value from qa where key = k $$;
create function pg_temp.sign_in(who text) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub', pg_temp.q(who), 'role', 'authenticated')
    || case when who like 'kma\_%' then ('{"amr":[{"method":"' || 'pass' || 'word"}]}')::jsonb else '{}'::jsonb end)::text, true)
$$;
-- Runs one statement the way a browser does: signed in, as the authenticated role.
create function pg_temp.call(who text, statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform pg_temp.sign_in(who);
  set local role authenticated;
  execute statement into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- 'ok', or the SQLSTATE and the one-word code the front ends map to a message.
create function pg_temp.try(who text, statement text) returns text language plpgsql as $$
declare reason text;
begin
  perform pg_temp.call(who, statement);
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return btrim(sqlstate || ' ' || coalesce(reason, ''));
end $$;
-- Calls one service function the way an edge function does: as the service role.
create function pg_temp.svc(fn text, input jsonb) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  execute format('select public.%I(%L)', fn, input) into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- What the end of a writing transaction does: the deferred commission triggers run.
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
-- The minute job, as pg_cron runs it.
create function pg_temp.tick() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  result := public.program_rewards_tick('{}'::jsonb);
  perform pg_temp.flush();
  return result;
end $$;
create function pg_temp.program() returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q('workspace')
$$;
create function pg_temp.account() returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program()).id
$$;
create function pg_temp.save(input jsonb) returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
    input || jsonb_build_object('revision', (pg_temp.program()).revision)))
$$;
create function pg_temp.balance() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_balance(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.rewards(input jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_rewards(%L, %L)', pg_temp.q('workspace'), input))
$$;
create function pg_temp.creators() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_creators(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.earnings() returns jsonb language sql as $$
  select pg_temp.call('creator', 'select public.partner_program_earnings()')
$$;
create function pg_temp.performance() returns jsonb language sql as $$
  select pg_temp.call('creator', format('select public.partner_program_performance(%L)',
    jsonb_build_object('slug', (pg_temp.program()).slug, 'days', 30)))
$$;
create function pg_temp.links() returns jsonb language sql as $$
  select pg_temp.call('creator', 'select public.partner_program_links()')
$$;
-- A visitor opens the creator's main link, as the tracking-redirect function asks for it.
create function pg_temp.click() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click('e2e-reward-creator',
    split_part(pg_temp.t('link_url'), '/', 6), '{}'::jsonb) r;
  reset role;
  return result;
end $$;
-- A moment just after everything so far, as the browser's clock writes it: an event can
-- never fall before the click that brought its visitor.
create function pg_temp.soon() returns text language sql volatile as $$
  select to_char((clock_timestamp() + interval '2 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- One request from the web SDK on the merchant's site: the visitor (anonymous, or signed in
-- with traits), the session with its click IDs, and the named events.
create function pg_temp.visit(anon text, user_id text, traits jsonb, session text, ctx jsonb, events text[])
returns jsonb language plpgsql as $$
declare
  v_at text := pg_temp.soon();
  result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.t('ingest_key'), 'sha256'), 'hex'),
    'origin', 'https://fluent-app.io',
    'body', jsonb_strip_nulls(jsonb_build_object(
      'anonymous_id', anon, 'user_id', user_id, 'traits', traits,
      'session', jsonb_build_object('id', session, 'started_at', v_at),
      'context', jsonb_build_object('platform', 'web', 'browser', 'Safari', 'device_type', 'mobile', 'interactions', 3,
        'page_path', '/start') || ctx)) || jsonb_build_object(
      'events', coalesce((select jsonb_agg(jsonb_build_object('name', e, 'insert_id', session || ':' || e || ':' || i || ':' || v_at,
        'time', v_at, 'properties', '{}'::jsonb)) from unnest(events) with ordinality u(e, i)), '[]'::jsonb))));
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- A visitor who came through the creator's link: the click, then the landing with kma_click.
create function pg_temp.arrive(anon text, session text) returns jsonb language sql as $$
  select pg_temp.visit(anon, null, null, session,
    jsonb_build_object('click', jsonb_build_object('kma_click', pg_temp.click()->>'click_id')), array['page_viewed'])
$$;
-- The merchant pays into the balance: the calls the program-balance function and the webhook
-- make around one Stripe Checkout payment.
create function pg_temp.deposit(k text, amount bigint) returns jsonb language plpgsql as $$
declare
  v_opened jsonb;
  v_begun jsonb;
begin
  v_opened := pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform'));
  perform pg_temp.svc('attach_program_balance_customer', jsonb_build_object('account_id', v_opened->>'account_id',
    'stripe_customer_id', 'cus_E2EReward', 'platform_account_id', 'acct_KMAPlatform'));
  v_begun := pg_temp.svc('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform', 'amount_minor', amount));
  perform pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id',
    'checkout_session_id', 'cs_live_' || k));
  return pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id', 'outcome', 'succeeded',
    'payment_intent_id', 'pi_rdep' || k, 'livemode', true, 'amount_minor', amount, 'currency', 'usd',
    'customer_id', 'cus_E2EReward', 'card', jsonb_build_object('payment_method_id', 'pm_E2ERewardVisa', 'brand', 'visa',
      'last4', '4242', 'exp_month', 4, 'exp_year', 2029)));
end $$;
-- The awards of one visitor, newest last.
create function pg_temp.awards_of(anon text) returns setof public.program_reward_awards language sql as $$
  select w.* from public.program_reward_awards w
  join public.analytics_events e on e.id = w.event_id
  join public.analytics_people pe on pe.id = e.person_id
  where pe.distinct_id = anon or pe.anonymous_ids @> array[anon]
  order by w.occurred_at, w.id
$$;
create function pg_temp.commission_of(award uuid) returns public.program_commissions language sql as $$
  select c from public.program_commissions c where c.award_id = award
$$;
-- The admin's payout list, and the creator's row in it.
create function pg_temp.listed() returns jsonb language sql as $$
  select c from jsonb_array_elements(pg_temp.call('kma_owner', 'select public.get_admin_program_payouts()')->'creators') c
  where c->>'affiliate_id' = 'ec870000-0000-4000-8000-000000000001' and c->>'currency' = 'USD'
$$;
-- On a test cluster made without UTF-8 the readable link address cannot run normalize();
-- there, and only inside this rolled-back transaction, the same rule runs without it.
do $$
begin
  if current_setting('server_encoding') <> 'UTF8' then
    create or replace function kma_internal.readable_handle(p_text text, p_fallback text, p_max integer) returns text
    language sql immutable set search_path = '' as $f$
      select coalesce(nullif(trim(both '-' from left(regexp_replace(lower(coalesce(p_text, '')),
        '[^[:alnum:]]+', '-', 'g'), p_max)), ''), p_fallback)
    $f$;
  end if;
end $$;
grant all on qa, e2e_reward_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('eb870000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{"company":"Fluent"}'),
  ('eb870000-0000-4000-8000-000000000011', 'founder@kma.example.test', now(), '{}'),
  ('eb870000-0000-4000-8000-000000000021', 'mira@creators.example.test', now(), '{}');
insert into qa values ('owner', 'eb870000-0000-4000-8000-000000000001'),
  ('kma_owner', 'eb870000-0000-4000-8000-000000000011'), ('creator', 'eb870000-0000-4000-8000-000000000021');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, slug, status) values
  ('ec870000-0000-4000-8000-000000000001', 'Mira Maker', 'e2e-reward-creator', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  ('ec870000-0000-4000-8000-000000000001', pg_temp.q('creator'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true;

-- The merchant's site already sends its analytics -------------------------------------------------
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Fluent', array['web'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'ingest_key', r->'key'->>'token' from created;
select public.analytics_update_project(pg_temp.q('project'), '{"allowed_origins":["https://fluent-app.io"]}'::jsonb);
select set_config('request.jwt.claims', '', true);
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Fluent Ltd', 'billing@fluent.example.test', pg_temp.q('owner'), pg_temp.q('workspace')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
  country, charges_enabled, details_submitted, confirmed_at, verified_at)
select id, 'acct_KMAPlatform', true, 'acct_E2EReward', 'active', 'Fluent Ltd', 'GB', true, true, now(), now() from business;

select pg_temp.visit('anon-early', 'u-early', null, 'sess-early', '{}'::jsonb,
  array['page_viewed', 'signup_completed', 'trial_started']);
select pg_temp.check(
  (select count(*) = 3 from public.analytics_events where project_id = pg_temp.q('project'))
  and (select count(*) = 0 from public.program_reward_queue),
  'the site''s events are stored, and with no program paying for them nothing waits to be judged');

-- KissMyApps switches program money on -----------------------------------------------------------
select pg_temp.check(
  (select m @> '{"enabled":true,"fee_bps":1000}'
    from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('enabled', true,
      'expected_updated_at', pg_temp.call('kma_owner', 'select public.get_admin_program_money()')->'updated_at'))) m),
  'the KissMyApps owner switches program money on with a 10% fee');

-- The merchant picks two events, sets a budget and publishes ------------------------------------
select pg_temp.check(
  (select e @> '{"events":[{"name":"signup_completed"},{"name":"trial_started"}]}'
    from pg_temp.call('owner', format('select public.workspace_program_reward_events(%L)', pg_temp.q('workspace'))) e),
  'the program form offers the events the merchant''s analytics already receives');
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
  '{"name":"Fluent","category":"education","tagline":"Speak a new language in a month.",
    "landing_url":"https://fluent-app.io/start","earn_from":"events","hold_days":14,
    "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},
               {"key":"trial_started","label":"Trial started","amount_minor":500}],
    "reward_budget_minor":10000}'::jsonb));
select pg_temp.check(
  (select p.earn_from = 'events' and p.reward_budget_minor = 10000 and jsonb_array_length(p.rewards) = 2 and p.status = 'draft'
    from pg_temp.program() p),
  'the merchant saves a program that pays 2.00 per account and 5.00 per trial, within 100.00 a month');
select pg_temp.call('owner', format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q('workspace'),
  pg_temp.call('owner', format('select public.workspace_program_agreement(%L)', pg_temp.q('workspace')))->>'sha256'));
select pg_temp.check(
  pg_temp.try('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision))
    = '22023 balance_required',
  'a program that pays for events cannot be published before its balance has funds either');
select pg_temp.check(
  (select d @> '{"status":"succeeded","amount_minor":5000}' from pg_temp.deposit('first', 5000) d)
  and (select b->'account' @> '{"available_minor":5000,"reserved_minor":0}' from pg_temp.balance() b),
  'the merchant pays 50.00 into the balance');
select pg_temp.call('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision));
select pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
  jsonb_build_object('program_id', (pg_temp.program()).id, 'decision', 'approve', 'note', null)));
select pg_temp.check((pg_temp.program()).status = 'live'
  and (select count(*) = 2 from public.program_reward_events
    where project_id = pg_temp.q('project') and event_name in ('signup_completed', 'trial_started')),
  'once approved the program is live and the intake knows which two events it pays for');

-- A creator joins ---------------------------------------------------------------------------------
insert into qa select 'shown', pg_temp.call('creator',
  format('select public.partner_program_detail(%L)', (pg_temp.program()).slug))::text;
select pg_temp.check(
  (select d->'program' @> '{"earn_from":"events","rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},
      {"key":"trial_started","label":"Trial started","amount_minor":500}]}'
      and d::text not like '%reward_budget_minor%' and d::text not like '%10000%'
    from (select pg_temp.t('shown')::jsonb d) x),
  'the creator reads what each event pays, and never the merchant''s budget');
insert into qa select 'link_url', pg_temp.call('creator', format('select public.partner_program_join(%L)',
  jsonb_build_object('slug', d->'program'->>'slug', 'terms_version', d->'program'->'terms_version',
    'agreement_sha256', d->'program'->>'agreement_sha256')))->'membership'->'link'->>'url'
from (select pg_temp.t('shown')::jsonb as d) x;
select pg_temp.check(pg_temp.t('link_url') like 'https://go.kissmyapps.dev/r/e2e-reward-creator/%',
  'the creator accepts the agreement and has a link');

-- A visitor comes through the link and creates an account -----------------------------------------
select pg_temp.arrive('anon-ann', 'sess-ann');
select pg_temp.check((select count(*) = 0 from public.program_reward_queue),
  'a page view is not one of the program''s events, so the intake lets it go');
select pg_temp.visit('anon-ann', 'u-ann', null, 'sess-ann', '{}'::jsonb, array['signup_completed']);
select pg_temp.check((select count(*) = 1 from public.program_reward_queue q where q.event_name = 'signup_completed'),
  'the sign-up is queued to be judged');
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":1,"remaining":0}', 'the minute tick judges it and it earns');
select pg_temp.check(
  (select w.status = 'earned' and w.reward_label = 'Account created' and w.amount_minor = 200 and w.currency = 'USD'
      and w.affiliate_id = 'ec870000-0000-4000-8000-000000000001' and w.click_record_id is not null
      and (pg_temp.commission_of(w.id)).status = 'held' and (pg_temp.commission_of(w.id)).amount_minor = 200
      and (pg_temp.commission_of(w.id)).fee_minor = 20 and (pg_temp.commission_of(w.id)).commission_type = 'reward'
      and (pg_temp.commission_of(w.id)).hold_until between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour'
    from pg_temp.awards_of('anon-ann') w where w.reward_key = 'signup_completed'),
  'the account earns the creator 2.00 with a 0.20 fee on top, held for the 14 days of the terms');
select pg_temp.check(
  (select b->'account' @> '{"available_minor":4780,"reserved_minor":220,"creators_pending_minor":200,"fees_minor":20}'
      and exists (select 1 from jsonb_array_elements(b->'activity') a
        where a @> '{"kind":"commission_reserved","amount_minor":-200,"creator_name":"Mira Maker","reward_label":"Account created"}')
    from pg_temp.balance() b),
  'the reward and the fee are set aside from the merchant''s balance the moment it earns');

-- The same visitor starts a trial, and signs up again --------------------------------------------
select pg_temp.visit('anon-ann', 'u-ann', null, 'sess-ann', '{}'::jsonb, array['trial_started', 'signup_completed']);
select pg_temp.check(pg_temp.tick() @> '{"judged":2,"earned":1,"remaining":0}',
  'the later event earns and the repeated sign-up does not');
select pg_temp.check(
  (select count(*) filter (where w.status = 'earned') = 2
      and count(*) filter (where w.status = 'not_earned' and w.reason = 'already_rewarded' and w.reward_key = 'signup_completed') = 1
      and sum(w.amount_minor) filter (where w.status = 'earned') = 700
    from pg_temp.awards_of('anon-ann') w),
  'one person earns each reward once: 2.00 for the account and 5.00 for the trial');

-- The creator signs up through their own link ----------------------------------------------------
select pg_temp.arrive('anon-self', 'sess-self');
select pg_temp.visit('anon-self', 'u-self', '{"email":"Mira@Creators.example.test"}'::jsonb, 'sess-self', '{}'::jsonb,
  array['signup_completed']);
select pg_temp.tick();
select pg_temp.check(
  (select w.status = 'not_earned' and w.reason = 'own_action' and pg_temp.commission_of(w.id) is null
    from pg_temp.awards_of('anon-self') w),
  'a sign-up with the creator''s own email earns nothing');

-- The daily share: one creator can use a tenth of the month's budget in a day ---------------------
select pg_temp.arrive('anon-ben', 'sess-ben');
select pg_temp.visit('anon-ben', 'u-ben', null, 'sess-ben', '{}'::jsonb, array['signup_completed']);
select pg_temp.arrive('anon-cy', 'sess-cy');
select pg_temp.visit('anon-cy', 'u-cy', null, 'sess-cy', '{}'::jsonb, array['signup_completed']);
select pg_temp.check(pg_temp.tick() @> '{"judged":2,"earned":1}', 'of two more sign-ups the same day, one earns');
select pg_temp.check(
  (select w.status = 'earned' from pg_temp.awards_of('anon-ben') w)
  and (select w.status = 'not_earned' and w.reason = 'daily_limit' from pg_temp.awards_of('anon-cy') w),
  '9.00 earned today plus 2.00 would pass the 10.00 a creator can earn in a day, so the third account counts for nothing');

-- The monthly budget, which the merchant can change at any time ----------------------------------
select pg_temp.save('{"reward_budget_minor":1000}'::jsonb);
select pg_temp.check(
  (select p.reward_budget_minor = 1000 from pg_temp.program() p)
  and not (pg_temp.call('owner', format('select public.workspace_program_get(%L)', pg_temp.q('workspace')))
    ->'program'->>'has_unpublished_changes')::boolean,
  'the merchant lowers the budget to 10.00; it applies at once and is not a change of terms');
select pg_temp.arrive('anon-dee', 'sess-dee');
select pg_temp.visit('anon-dee', 'u-dee', null, 'sess-dee', '{}'::jsonb, array['signup_completed']);
select pg_temp.tick();
select pg_temp.check(
  (select w.status = 'not_earned' and w.reason = 'budget_reached' from pg_temp.awards_of('anon-dee') w)
  and (select (r->'budget') @> '{"budget_minor":1000,"used_minor":900}' from pg_temp.rewards() r),
  'with 9.00 of 10.00 used this month, another 2.00 does not fit the budget');
select pg_temp.check(
  (select (p->>'budget_reached')::boolean from pg_temp.performance() p),
  'the creator is told the program has used its budget for the month, without the amount');
select pg_temp.save('{"reward_budget_minor":10000}'::jsonb);

-- What everyone sees ------------------------------------------------------------------------------
select pg_temp.check(
  (select r->'program' @> '{"earn_from":"events","status":"live"}'
      and r->'rewards' @> '[{"key":"signup_completed","count":2,"amount_total_minor":400},{"key":"trial_started","count":1,"amount_total_minor":500}]'
      and (select count(*) = 3 from jsonb_array_elements(r->'awards') a where a @> '{"status":"pending","can_reject":true}')
      and (select count(*) = 4 from jsonb_array_elements(r->'awards') a where a @> '{"status":"not_counted","can_reject":false}')
      and r->'creators'->0 @> '{"name":"Mira Maker","earned_minor":900,"pending_minor":900}'
    from pg_temp.rewards() r),
  'the merchant''s Rewards page lists the three rewards waiting out the hold and the four events that did not count');
select pg_temp.check(
  (select c->'totals' @> '{"events":3}' and c->'creators'->0 @> '{"events":3}' and c->>'earn_from' = 'events'
    from pg_temp.creators() c),
  'the merchant''s Creators page counts the creator''s three events');
select pg_temp.check(
  (select e->'programs'->0 @> '{"name":"Fluent","pending_minor":900,"approved_minor":0,"events":3,"sales":0}'
      and exists (select 1 from jsonb_array_elements(e->'recent') r
        where r @> '{"kind":"reward","reward_label":"Trial started","amount_minor":500,"status":"held"}')
    from pg_temp.earnings() e),
  'the creator''s Earnings page shows 9.00 pending from three events');
select pg_temp.check(
  (select p->'totals' @> '{"events":3,"earnings_minor":900}' and p->'program'->>'earn_from' = 'events'
      and p->'rewards' @> '[{"key":"signup_completed","count":2},{"key":"trial_started","count":1}]'
      and exists (select 1 from jsonb_array_elements(p->'channels') c where c @> '{"kind":"main","events":3}')
    from pg_temp.performance() p)
  and exists (select 1 from jsonb_array_elements(pg_temp.links()->'programs'->0->'links') l where l @> '{"kind":"main","events":3}'),
  'the creator''s Performance and Links pages put the three events on the main link');
select pg_temp.check(
  (select bool_and(not (x::text ~* '(u-ann|u-ben|anon-|creators\.example|fluent\.example|session|person_id|event_id)'))
    from (values (pg_temp.earnings()), (pg_temp.performance()), (pg_temp.links()), (pg_temp.t('shown')::jsonb)) v(x))
  and (select bool_and(not (pg_temp.rewards()::text like '%' || w.person_id::text || '%')) from public.program_reward_awards w),
  'no visitor, person, session or event id and no email reaches the creator, and no person id reaches the merchant');

-- The merchant rejects a reward during the hold --------------------------------------------------
select pg_temp.check(
  (select r @> '{"rejected":1,"returned_minor":220}'
    from pg_temp.call('owner', format('select public.workspace_program_reward_reject(%L, %L)', pg_temp.q('workspace'),
      jsonb_build_object('award_ids', jsonb_build_array((select w.id from pg_temp.awards_of('anon-ben') w)),
        'reason', 'fake', 'note', 'Signed up twice with throwaway emails.'))) r),
  'the merchant rejects Ben''s account as fake and 2.20 goes back to the balance');
select pg_temp.check(
  (select w.status = 'rejected' and w.reject_reason = 'fake' and (pg_temp.commission_of(w.id)).status = 'reversed'
      and (pg_temp.commission_of(w.id)).amount_minor = 0 and (pg_temp.commission_of(w.id)).fee_minor = 0
    from pg_temp.awards_of('anon-ben') w)
  and (select b->'account' @> '{"available_minor":4230,"reserved_minor":770,"creators_pending_minor":700,"fees_minor":70}'
    from pg_temp.balance() b)
  and (select e->'programs'->0 @> '{"pending_minor":700,"events":2}'
      and exists (select 1 from jsonb_array_elements(e->'recent') r where r @> '{"kind":"reward","status":"reversed","amount_minor":0}')
    from pg_temp.earnings() e),
  'the rejected reward is returned in full, and the creator sees it was taken back');
select pg_temp.check(
  pg_temp.try('owner', format('select public.workspace_program_reward_reject(%L, %L)', pg_temp.q('workspace'),
    jsonb_build_object('award_ids', jsonb_build_array((select w.id from pg_temp.awards_of('anon-cy') w)), 'reason', 'fake')))
    = '22023 not_rejectable'
  and pg_temp.try('creator', format('select public.workspace_program_reward_reject(%L, %L)', pg_temp.q('workspace'),
    jsonb_build_object('award_ids', jsonb_build_array((select w.id from pg_temp.awards_of('anon-ann') w limit 1)), 'reason', 'fake')))
    <> 'ok',
  'an event that never earned cannot be rejected, and nobody outside the workspace can reject');
select pg_temp.visit('anon-ben', 'u-ben', null, 'sess-ben', '{}'::jsonb, array['signup_completed']);
select pg_temp.tick();
select pg_temp.check(
  (select count(*) = 1 from pg_temp.awards_of('anon-ben') w where w.status = 'not_earned' and w.reason = 'already_rewarded'),
  'a person whose reward was rejected does not earn it again');

-- The hold passes -------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.tick() @> '{"approved":0}', 'nothing is approved while the hold is running');
-- Fourteen days go by.
update public.program_commissions set hold_until = now() - interval '1 minute'
where award_id in (select w.id from pg_temp.awards_of('anon-ann') w where w.status = 'earned');
select pg_temp.check(pg_temp.tick() @> '{"approved":2}' and pg_temp.tick() @> '{"approved":0}',
  'after the hold the tick approves both of Ann''s rewards, once');
select pg_temp.check(
  (select count(*) = 2 and sum(e.amount_minor) = 700 from public.program_creator_entries e
    where e.affiliate_id = 'ec870000-0000-4000-8000-000000000001' and e.kind = 'commission_approved')
  and (select b->'account' @> '{"available_minor":4230,"reserved_minor":0,"creators_pending_minor":0,
      "creators_approved_minor":700,"fees_minor":70}' from pg_temp.balance() b)
  and (select e->'programs'->0 @> '{"pending_minor":0,"approved_minor":700,"events":2}' from pg_temp.earnings() e)
  and (select r->'awards' @> '[{"status":"approved","can_reject":false}]' from pg_temp.rewards() r),
  'the approved rewards are the creator''s: 7.00 approved, and the balance no longer holds them');
select pg_temp.check(pg_temp.listed() @> '{"payable_minor":700,"blocker":"payouts_off"}',
  'KissMyApps sees the 7.00 it owes the creator, ready to pay once payouts are on');

-- Every cent is accounted for ----------------------------------------------------------------------
select pg_temp.check(
  (select a.available_minor = (select sum(e.amount_minor) from public.program_balance_entries e where e.account_id = a.id)
      and a.available_minor = 5000 - 200 - 20 - 500 - 50
    from pg_temp.account() a)
  and public.program_balance_health()->>'ledger_mismatches' = '0'
  and public.program_reward_health() @> '{"ledger_mismatches":0,"events_out_of_step":0}'
  and (public.program_reward_health()->'queue') @> '{"due":0}',
  'the balance equals its entries, deposits less rewards and fees is what is left, and nothing waits or drifts');

select format('ok %s program rewards end to end assertions', count(*)) from e2e_reward_assertions;
rollback;
