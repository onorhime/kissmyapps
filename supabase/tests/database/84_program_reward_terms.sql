-- Provider-free test of Phase 6, the program form and terms: a program that pays creators
-- for events as well as, or instead of, sales. The form's three new fields and every way
-- they are refused; the terms snapshot and the agreement generated from it; a draft that
-- becomes a published events program; a program that pays for both; changing the rewards
-- of a published program; what the merchant, a creator, the marketplace and the admin
-- review read; the events the form offers; and the one rule a sale needs.
--
-- The agreement of a program that pays for sales only must stay byte for byte what it was
-- before Phase 6. The suite keeps a copy of the Phase 2 generator as it was and compares
-- the two over every shape of sales terms.
--
-- Programs and members are made with the Phase 2 and 3 functions. Sales are inserted
-- directly and judged by the real commission sync. Stripe is never called.
begin;
set local time zone 'UTC';
create temporary table reward_terms_assertions(label text);
create temporary table qa(key text primary key, value text);
create temporary table answers(name text primary key, answer jsonb);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program reward terms assertion failed: %', label; end if;
  insert into reward_terms_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
-- Signs in. KissMyApps staff (kma_...) get a session they opened by signing in themselves.
create function pg_temp.sign_in(who text) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub', pg_temp.q(who), 'role', 'authenticated')
    || case when who like 'kma\_%' then jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'pass' || 'word')))
      else '{}'::jsonb end)::text, true)
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
-- The same with nobody signed in, as one of the API roles.
create function pg_temp.try_signed_out(api_role text, statement text) returns text language plpgsql as $$
declare reason text;
begin
  perform set_config('request.jwt.claims', '', true);
  execute format('set local role %I', api_role);
  execute statement;
  reset role;
  return 'ok';
exception when others then
  reset role;
  get stacked diagnostics reason = pg_exception_detail;
  return btrim(sqlstate || ' ' || coalesce(reason, ''));
end $$;
-- Runs one statement the way an edge function does: as the service role, nobody signed in.
create function pg_temp.service(statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  execute statement into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- Prints one function result as the front ends receive it (kept by KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
-- Keeps an answer so that later statements can look at it without calling again.
create function pg_temp.keep(k text, result jsonb) returns jsonb language sql as $$
  insert into answers values (k, result) on conflict (name) do update set answer = excluded.answer returning answer
$$;
create function pg_temp.kept(k text) returns jsonb language sql as $$ select answer from answers where name = k $$;
create function pg_temp.keys(j jsonb) returns text language sql as $$
  select string_agg(k, ' ' order by k) from jsonb_object_keys(j) k
$$;
-- What the end of the writing transaction does: the deferred commission triggers run.
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;

-- The merchant's program -------------------------------------------------------------------
create function pg_temp.program(workspace text) returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q(workspace) and status <> 'archived'
$$;
create function pg_temp.sql(fn text, workspace text, variadic args text[] default '{}') returns text language sql as $$
  select format('select public.%I(%L%s)', fn, pg_temp.q(workspace),
    (select coalesce(string_agg(', ' || a, '' order by n), '') from unnest(args) with ordinality x(a, n)))
$$;
create function pg_temp.state(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.sql('workspace_program_get', workspace))
$$;
-- Save with the revision the caller last saw (none for the first save).
create function pg_temp.save_sql(workspace text, input jsonb) returns text language sql as $$
  select pg_temp.sql('workspace_program_save', workspace, quote_literal(input
    || case when (pg_temp.program(workspace)).id is null then '{}'::jsonb
      else jsonb_build_object('revision', (pg_temp.program(workspace)).revision) end) || '::jsonb')
$$;
create function pg_temp.save(who text, workspace text, input jsonb) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.save_sql(workspace, input))
$$;
create function pg_temp.save_fails(who text, workspace text, input jsonb) returns text language sql as $$
  select pg_temp.try(who, pg_temp.save_sql(workspace, input))
$$;
create function pg_temp.agreement(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.sql('workspace_program_agreement', workspace))
$$;
-- Open the agreement and press "I have read this".
create function pg_temp.read(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.sql('workspace_program_mark_agreement_read', workspace,
    quote_literal(pg_temp.agreement(who, workspace)->>'sha256')))
$$;
create function pg_temp.submit_sql(workspace text) returns text language sql as $$
  select pg_temp.sql('workspace_program_submit', workspace, (pg_temp.program(workspace)).revision::text)
$$;
create function pg_temp.submit(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.submit_sql(workspace))
$$;
create function pg_temp.reviews() returns jsonb language sql as $$
  select pg_temp.call('kma_owner', 'select public.list_admin_program_reviews()')
$$;
create function pg_temp.review_row(workspace text) returns jsonb language sql as $$
  select r from jsonb_array_elements(pg_temp.reviews()->'programs') r where r->>'workspace_id' = pg_temp.q(workspace)::text
$$;
create function pg_temp.approve(workspace text) returns jsonb language sql as $$
  select pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
    jsonb_build_object('program_id', (pg_temp.program(workspace)).id, 'decision', 'approve')))
$$;
-- The published terms: one version, or the one in force.
create function pg_temp.terms_row(workspace text, v integer default null) returns public.affiliate_program_terms language sql as $$
  select t from public.affiliate_program_terms t, pg_temp.program(workspace) p
  where t.program_id = p.id and t.version = coalesce(v, p.live_terms_version)
$$;
create function pg_temp.connect(workspace text, account text, business text) returns void language plpgsql as $$
declare v_business uuid;
begin
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  select business, 'billing@' || workspace || '.example.test', w.created_by, w.id
  from public.analytics_workspaces w where w.id = pg_temp.q(workspace) returning id into v_business;
  insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
    country, charges_enabled, details_submitted, confirmed_at, verified_at)
  values (v_business, 'acct_KMAPlatform', true, account, 'active', business, 'GB', true, true, now(), now());
end $$;
create function pg_temp.reward_events(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.sql('workspace_program_reward_events', workspace))
$$;

-- Money ------------------------------------------------------------------------------------
create function pg_temp.account(workspace text) returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program(workspace)).id
$$;
-- The balance is opened and a deposit that Stripe confirmed arrives (a fixture: suite 80
-- covers deposits).
create function pg_temp.fund(workspace text, who text, amount bigint) returns void language plpgsql as $$
declare v_topup uuid;
begin
  perform pg_temp.service(format('select public.open_program_balance(%L)', jsonb_build_object(
    'workspace_id', pg_temp.q(workspace), 'user_id', pg_temp.q(who), 'platform_account_id', 'acct_KMAPlatform')));
  insert into public.program_topups(account_id, kind, amount_minor, currency, status, settled_at)
  values ((pg_temp.account(workspace)).id, 'deposit', amount, (pg_temp.account(workspace)).currency, 'succeeded', now())
  returning id into v_topup;
  perform kma_internal.program_balance_post((pg_temp.account(workspace)).id, 'deposit', amount, v_topup);
end $$;

-- Creators ---------------------------------------------------------------------------------
create function pg_temp.join(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_join(%L)', jsonb_build_object(
    'slug', p.slug, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
  from pg_temp.program(workspace) p, pg_temp.terms_row(workspace) t
$$;
create function pg_temp.accept(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_accept_terms(%L)', jsonb_build_object(
    'program_id', p.id, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
  from pg_temp.program(workspace) p, pg_temp.terms_row(workspace) t
$$;
create function pg_temp.detail(creator text, program_slug text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_detail(%L)', program_slug))
$$;
create function pg_temp.card(program_slug text) returns jsonb language sql as $$
  select c from jsonb_array_elements(pg_temp.service('select public.marketplace_programs()')->'programs') c
  where c->>'slug' = program_slug
$$;
-- A visit through the creator's main link: the click row the redirect function writes.
create function pg_temp.click(creator text, workspace text) returns uuid language plpgsql as $$
declare
  l public.affiliate_links;
  v_id uuid := gen_random_uuid();
begin
  select x.* into l from public.affiliate_links x
  where x.affiliate_id = pg_temp.q('creator_' || creator) and x.product_id = (pg_temp.program(workspace)).product_id and x.is_main;
  insert into public.clicks(id, public_click_id, affiliate_link_id, affiliate_id, product_id, source_id, campaign_id,
    funnel_id, sub1, sub2, sub3, destination_url_snapshot, is_bot, commercial_eligible, occurred_at, created_at)
  select v_id, encode(extensions.gen_random_bytes(24), 'hex'), l.id, l.affiliate_id, l.product_id, l.source_id, l.campaign_id,
    l.funnel_id, l.sub1, l.sub2, l.sub3, f.destination_url, false, l.commercial_eligible, now() - interval '1 hour', now() - interval '1 hour'
  from public.funnels f where f.id = l.funnel_id;
  return v_id;
end $$;
-- A payment Stripe reported, tied to a creator's click, then what the end of that
-- transaction does.
create function pg_temp.sale(k text, workspace text, click uuid, amount bigint, paid timestamptz) returns void language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  v_click public.clicks;
  v_id uuid := gen_random_uuid();
begin
  select * into v_click from public.clicks where id = click;
  insert into public.program_sales(id, program_id, connection_id, account_id, payment_intent_id, charge_id,
      checkout_session_id, customer_id, amount_minor, currency, refunded_minor, status, paid_at,
      click_id, click_record_id, affiliate_id, match_source, created_at)
    select v_id, p.id, c.id, c.account_id, 'pi_p6buyer' || k, 'ch_p6buyer' || k, 'cs_p6buyer' || k, 'cus_P6Buyer' || k,
      amount, 'USD', 0, 'paid', paid, v_click.public_click_id, v_click.id, v_click.affiliate_id, 'metadata', now()
    from public.merchant_connections c join public.merchant_businesses b on b.id = c.merchant_id
    where b.workspace_id = p.workspace_id;
  insert into qa values (k, v_id);
  perform pg_temp.flush();
end $$;
-- A sale's commission in one line: <status> <amount> <fee> <reason>.
create function pg_temp.commission(k text) returns text language sql as $$
  select coalesce((select format('%s %s %s %s', x.status, x.amount_minor, x.fee_minor, coalesce(x.reason, '-'))
    from public.program_commissions x where x.sale_id = pg_temp.q(k)), 'none')
$$;

-- The agreement as it was ------------------------------------------------------------------
-- The Phase 2 generator and its one-line commission, copied as they were before Phase 6.
create function pg_temp.headline_before(p_terms jsonb) returns text language sql as $$
  select case p_terms->>'commission_type'
      when 'percent' then kma_internal.program_percent((p_terms->>'commission_rate_bps')::integer) || ' of '
      else kma_internal.program_money((p_terms->>'commission_fixed_minor')::bigint, p_terms->>'currency') || ' on '
    end
    || case p_terms->>'commission_duration'
      when 'first_payment' then 'the first payment'
      when 'months' then 'every payment for ' || kma_internal.program_count((p_terms->>'commission_months')::integer, 'month')
      else 'every payment'
    end
$$;
create function pg_temp.agreement_before(p_terms jsonb) returns jsonb language plpgsql as $$
declare
  v_program text := p_terms->>'program_name';
  v_brand text := coalesce(p_terms->>'brand_name', p_terms->>'program_name');
  v_url text := p_terms->>'landing_url';
  v_type text := p_terms->>'commission_type';
  v_duration text := p_terms->>'commission_duration';
  v_hold integer := (p_terms->>'hold_days')::integer;
  v_minimum bigint := (p_terms->>'minimum_payout_minor')::bigint;
  v_extra text := p_terms->>'extra_terms';
  v_amount text;
  v_minimum_text text;
  v_window text;
  v_names text;
  v_cleared text;
  v_sections jsonb;
begin
  if v_program is null or v_url is null or v_type is null or v_duration is null then
    return null;
  end if;
  v_amount := case v_type
    when 'percent' then kma_internal.program_percent((p_terms->>'commission_rate_bps')::integer) || ' of'
    else kma_internal.program_money((p_terms->>'commission_fixed_minor')::bigint, p_terms->>'currency') || ' for'
  end;
  v_minimum_text := kma_internal.program_money(v_minimum, p_terms->>'currency');
  v_window := kma_internal.program_count((p_terms->>'attribution_window_days')::integer, 'day');
  v_names := case when v_brand = v_program then v_program else v_program || ' or ' || v_brand end;
  v_cleared := case when v_hold > 0 then 'once it has passed the hold' else 'once KissMyApps has confirmed the payment' end;

  v_sections := jsonb_build_array(
    kma_internal.program_section('1. Who this agreement is between',
      format('This agreement is between you, the creator, and %s. KissMyApps is the platform the program runs on. '
        || 'It tracks sales and pays commission on behalf of %s.',
        case when v_brand = v_program then v_brand else format('%s, the business behind %s', v_brand, v_program) end, v_brand),
      format('You sign this agreement by accepting it on KissMyApps. %s agreed to these terms when it published them, '
        || 'so nobody needs to countersign.', v_brand)),
    kma_internal.program_section('2. What you promote',
      format('You promote %s. KissMyApps gives you your own link, and people who click it land on %s.', v_program, v_url),
      case p_terms->>'approval_mode'
        when 'manual' then format('%s approves each creator. You can start once you have been approved.', v_brand)
        else 'You can start as soon as you accept this agreement.'
      end),
    kma_internal.program_section('3. Commission',
      case v_duration
        when 'first_payment' then format('You earn %s the first payment from each customer whose sale is credited to you. '
          || 'Renewals and other later payments from that customer do not earn commission.', v_amount)
        when 'months' then format('You earn %s every payment credited to you, for %s counted from the customer''s first payment. '
          || 'Payments after that do not earn commission.', v_amount,
          kma_internal.program_count((p_terms->>'commission_months')::integer, 'month'))
        else format('You earn %s every payment credited to you, with no time limit.', v_amount)
      end,
      'Section 4 explains which payments are credited to you.'),
    kma_internal.program_section('4. How a sale is credited to you',
      format('A sale is credited to you when a customer clicks your link and pays %s within %s of that click.', v_brand, v_window),
      'If the customer clicked more than one creator''s link in that time, the sale goes to the last link they clicked before paying.',
      'When a sale credited to you starts a subscription, the renewals of that subscription are credited to you as well.',
      'Only sales that KissMyApps has tracked and confirmed as paid count. A sale that cannot be traced to your link earns no commission.'),
    kma_internal.program_section('5. Hold, refunds and chargebacks',
      case when v_hold > 0
        then format('Commission is held for %s after each payment before it can be paid out. This leaves time for refunds and disputes.',
          kma_internal.program_count(v_hold, 'day'))
        else 'There is no hold. Commission is ready for payout once KissMyApps has confirmed the payment.'
      end,
      'If a payment is refunded, disputed or charged back, the commission on it is cancelled, or reduced to match a partial refund.',
      'If that commission was already paid to you, the amount is taken out of your later commission.'),
    kma_internal.program_section('6. Payouts',
      format('KissMyApps pays your commission on behalf of %s, to the payout account you connect on KissMyApps.', v_brand),
      case when v_minimum > 0
        then format('Commission becomes payable %s. It is paid when your payable commission reaches %s.', v_cleared, v_minimum_text)
        else format('Commission becomes payable %s. There is no minimum payout.', v_cleared)
      end,
      format('KissMyApps pays out only from money %s has provided for commission. Until %s provides it, the commission is owed to you by %s, '
        || 'not by KissMyApps.', v_brand, v_brand, v_brand)),
    kma_internal.program_section('7. How you may promote',
      format('Be honest. Only say things about %s that are true.', v_program),
      'Tell your audience clearly that you earn commission when they buy through your link.',
      format('Do not send spam. Do not bid on the %s name in paid search ads. Do not buy through your own link. '
        || 'Do not send fake, automated or paid-for clicks or sign-ups.', v_names),
      'Sales that break these rules earn no commission.'),
    kma_internal.program_section(format('8. The %s name and logo', v_program),
      format('While this agreement is in force you may use the %s name and logo, unchanged, to promote it. '
        || 'Do not present yourself as %s or suggest that you speak for it. Stop using the name and logo when this agreement ends.',
        v_program, v_brand)),
    kma_internal.program_section('9. Changes to these terms',
      format('%s can change these terms by publishing a new version. KissMyApps will ask you to accept it.', v_brand),
      'Commission you have already earned keeps the terms it was earned under.'),
    kma_internal.program_section('10. Ending this agreement',
      format('You or %s can end this agreement at any time.', v_brand),
      case when v_hold > 0
        then 'Commission you earned before it ended is still paid once it has passed the hold.'
        else 'Commission you earned before it ended is still paid.'
      end,
      'Payments made after it ends do not earn commission.'),
    kma_internal.program_section('11. Independent relationship',
      format('You promote %s as an independent creator. You are not an employee, agent or partner of %s or of KissMyApps, '
        || 'and you cannot make commitments on their behalf.', v_program, v_brand)));
  -- The brand's own words come last, exactly as typed, under this heading.
  if v_extra is not null then
    v_sections := v_sections || kma_internal.program_section(format('12. Additional terms from %s', v_brand),
      format('%s added the terms below. They are part of this agreement, but they cannot reduce commission you have already earned.', v_brand));
  end if;

  return jsonb_build_object(
    'title', v_program || ' Affiliate Agreement',
    'brand_name', v_brand,
    'program_name', v_program,
    'summary', jsonb_build_array(
      jsonb_build_object('label', 'Commission', 'value', pg_temp.headline_before(p_terms)),
      jsonb_build_object('label', 'Attribution window', 'value', v_window),
      jsonb_build_object('label', 'Hold before payout', 'value',
        case when v_hold > 0 then kma_internal.program_count(v_hold, 'day') else 'None' end),
      jsonb_build_object('label', 'Minimum payout', 'value', case when v_minimum > 0 then v_minimum_text else 'None' end)),
    'sections', v_sections,
    'extra_terms', v_extra);
end $$;
-- Terms as Phase 2 wrote them: no earn_from, no rewards.
create function pg_temp.old_terms(overrides jsonb default '{}') returns jsonb language sql as $$
  select '{"program_name":"SpeakSix","brand_name":"SpeakSix Ltd","landing_url":"https://speaksix.com/start",
    "commission_type":"percent","commission_rate_bps":3000,"commission_fixed_minor":null,"currency":"USD",
    "commission_duration":"months","commission_months":12,"attribution_window_days":30,"hold_days":30,
    "minimum_payout_minor":2000,"approval_mode":"automatic","extra_terms":null}'::jsonb || overrides
$$;
-- Terms of a program that pays for events only, and the document they give.
create function pg_temp.event_terms(overrides jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.old_terms('{"program_name":"Fluent","brand_name":"Fluent Labs","landing_url":"https://fluent.speaksix.com/start",
    "commission_type":null,"commission_rate_bps":null,"commission_duration":null,"commission_months":null,"earn_from":"events",
    "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},
      {"key":"trial_started","label":"Trial started","amount_minor":500}]}'::jsonb || overrides)
$$;
create function pg_temp.doc(terms jsonb) returns jsonb language sql as $$ select kma_internal.program_agreement(terms) $$;
create function pg_temp.sha(document jsonb) returns text language sql as $$
  select encode(sha256(convert_to(document::text, 'utf8')), 'hex')
$$;
-- The paragraphs of the section with this heading (without its number).
create function pg_temp.section(document jsonb, heading text) returns jsonb language sql as $$
  select s->'paragraphs' from jsonb_array_elements(document->'sections') s
  where regexp_replace(s->>'heading', '^\d+\. ', '') = heading
$$;
create function pg_temp.headings(document jsonb) returns text language sql as $$
  select string_agg(s->>'heading', ' | ' order by n) from jsonb_array_elements(document->'sections') with ordinality x(s, n)
$$;
grant all on qa, reward_terms_assertions, answers to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People -----------------------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('c6000000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{"company":"Fluent"}'),
  ('c6000000-0000-4000-8000-000000000002', 'analyst@fluent.example.test', now(), '{}'),
  ('c6000000-0000-4000-8000-000000000003', 'owner@rival.example.test', now(), '{"company":"Rival"}'),
  ('c6000000-0000-4000-8000-000000000004', 'owner@quiet.example.test', now(), '{"company":"Quiet"}'),
  ('c6000000-0000-4000-8000-000000000005', 'owner@empty.example.test', now(), '{"company":"Empty"}'),
  ('c6000000-0000-4000-8000-000000000006', 'stranger@elsewhere.example.test', now(), '{}'),
  ('c6000000-0000-4000-8000-000000000011', 'owner@kma.example.test', now(), '{}'),
  ('c6000000-0000-4000-8000-000000000021', 'ada@creators.example.test', now(), '{}'),
  ('c6000000-0000-4000-8000-000000000022', 'ben@creators.example.test', now(), '{}');
insert into qa values
  ('owner', 'c6000000-0000-4000-8000-000000000001'), ('analyst', 'c6000000-0000-4000-8000-000000000002'),
  ('rival_owner', 'c6000000-0000-4000-8000-000000000003'), ('quiet_owner', 'c6000000-0000-4000-8000-000000000004'),
  ('empty_owner', 'c6000000-0000-4000-8000-000000000005'), ('stranger', 'c6000000-0000-4000-8000-000000000006'),
  ('kma_owner', 'c6000000-0000-4000-8000-000000000011'),
  ('ada', 'c6000000-0000-4000-8000-000000000021'), ('ben', 'c6000000-0000-4000-8000-000000000022'),
  ('creator_ada', 'c7000000-0000-4000-8000-000000000001'), ('creator_ben', 'c7000000-0000-4000-8000-000000000002');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, legal_name, slug, status, reporting_timezone, country_code, channels) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', 'Ada N. Okafor', 'ada-okafor', 'active', 'UTC', 'NG', array['tiktok']),
  (pg_temp.q('creator_ben'), 'Ben Creator', null, 'ben-creator', 'active', 'UTC', 'GB', array['youtube']);
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  select pg_temp.q('creator_' || c), pg_temp.q(c), 'owner', true, false, now() from unnest(array['ada', 'ben']) c;
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true,
    program_money_enabled = false, program_fee_bps = 1000, program_min_deposit_minor = 5000,
    program_payouts_enabled = false, program_min_payout_minor = 2500;

select pg_temp.sign_in('owner');
insert into qa select 'fluent', public.analytics_bootstrap()->'workspaces'->0->>'id';
select public.analytics_invite_member(pg_temp.q('fluent'), 'analyst@fluent.example.test', 'analyst');
insert into qa select 'project_web', public.analytics_create_project(pg_temp.q('fluent'), 'Fluent web', array['web'], 'UTC')->'project'->>'id';
insert into qa select 'project_app', public.analytics_create_project(pg_temp.q('fluent'), 'Fluent app', array['ios'], 'UTC')->'project'->>'id';
select pg_temp.sign_in('analyst');
select public.analytics_bootstrap();
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
insert into qa select 'project_rival', public.analytics_create_project(pg_temp.q('rival'), 'Rival', array['web'], 'UTC')->'project'->>'id';
select pg_temp.sign_in('quiet_owner');
insert into qa select 'quiet', public.analytics_bootstrap()->'workspaces'->0->>'id';
insert into qa select 'project_quiet', public.analytics_create_project(pg_temp.q('quiet'), 'Quiet', array['web'], 'UTC')->'project'->>'id';
select pg_temp.sign_in('empty_owner');
insert into qa select 'empty', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.connect('fluent', 'acct_Fluent', 'Fluent Labs');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');
select pg_temp.connect('quiet', 'acct_Quiet', 'Quiet Club');

-- Who may call what ------------------------------------------------------------------------
select pg_temp.check((select has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and p.prosecdef and 'search_path=""' = any(p.proconfig)
  from pg_proc p where p.oid = 'public.workspace_program_reward_events(uuid)'::regprocedure),
  'signed-in users may call the new function; it is a security definer function with an empty search path');
select pg_temp.check((select count(*) = 5 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and p.proname in ('program_terms_earn_from', 'program_terms_rewards', 'program_section_add',
    'program_agreement_rewards', 'program_input_rewards'))
  and (select bool_and(not has_function_privilege(r, p.oid, 'execute'))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role']) r
    where n.nspname = 'kma_internal' and p.proname like 'program\_%'),
  'the new internal helpers, and every program helper that was replaced, stay closed to every API role');
select pg_temp.check((select bool_and(pg_get_function_identity_arguments(p.oid) is not null and p.prosecdef = v.definer)
  from (values ('public.workspace_program_save(uuid, jsonb)', true), ('kma_internal.program_apply_input(public.affiliate_programs, jsonb)', false),
    ('kma_internal.program_commission_decide(public.program_sales, bigint)', false)) v(signature, definer)
  join pg_proc p on p.oid = v.signature::regprocedure)
  and (select has_function_privilege('authenticated', 'public.workspace_program_save(uuid, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.workspace_program_save(uuid, jsonb)', 'execute')),
  'the replaced functions keep their signatures and who may call them');

-- The sales agreement is byte for byte what it was ---------------------------------------------
-- Every shape of sales terms: as Phase 2 wrote them, as Phase 6 writes them (earn_from
-- sales, no rewards), and with rewards left in the terms of a program that pays for sales.
create temporary table sales_shapes as
select pg_temp.old_terms(c.o || d.o || h.o || m.o || a.o || b.o || x.o || w.o || y.o) as terms
from (values ('{}'::jsonb), ('{"commission_rate_bps":1250}'),
    ('{"commission_type":"fixed","commission_rate_bps":null,"commission_fixed_minor":125000}')) c(o),
  (values ('{}'::jsonb), ('{"commission_months":1}'), ('{"commission_duration":"first_payment","commission_months":null}'),
    ('{"commission_duration":"lifetime","commission_months":null}')) d(o),
  (values ('{}'::jsonb), ('{"hold_days":0}')) h(o),
  (values ('{}'::jsonb), ('{"minimum_payout_minor":0}')) m(o),
  (values ('{}'::jsonb), ('{"approval_mode":"manual"}')) a(o),
  (values ('{}'::jsonb), ('{"brand_name":null}')) b(o),
  (values ('{}'::jsonb), (jsonb_build_object('extra_terms', E'No coupon sites.\n  Keep it friendly.\n'))) x(o),
  (values ('{}'::jsonb), ('{"attribution_window_days":1}')) w(o),
  (values ('{}'::jsonb), ('{"currency":"EUR"}')) y(o);
grant select on sales_shapes to anon, authenticated, service_role;
select pg_temp.check((select count(*) = 1536 and count(distinct pg_temp.sha(pg_temp.agreement_before(s.terms))) > 1000
    and bool_and(kma_internal.program_agreement(s.terms)::text = pg_temp.agreement_before(s.terms)::text
      and kma_internal.program_agreement_sha256(kma_internal.program_agreement(s.terms)) = pg_temp.sha(pg_temp.agreement_before(s.terms))
      and kma_internal.program_commission_headline(s.terms) = pg_temp.headline_before(s.terms))
  from sales_shapes s),
  'terms from before Phase 6 give the document, the hash and the headline they gave before, in all 1536 shapes');
select pg_temp.check((select bool_and(
      kma_internal.program_agreement(s.terms || '{"earn_from":"sales","rewards":[]}')::text = pg_temp.agreement_before(s.terms)::text
      and kma_internal.program_agreement(s.terms || '{"earn_from":"sales","rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200}]}')::text
        = pg_temp.agreement_before(s.terms)::text
      and kma_internal.program_agreement(s.terms || '{"earn_from":null,"rewards":null}')::text = pg_temp.agreement_before(s.terms)::text)
  from sales_shapes s),
  'terms that say they pay for sales give the same document byte for byte, whatever rewards they carry');
-- The first twelve characters of the hash each of these terms had on the day before Phase 6.
select pg_temp.check(left(pg_temp.sha(pg_temp.doc(pg_temp.old_terms(v.overrides))), 12) = v.fingerprint
  and left(pg_temp.sha(pg_temp.doc(pg_temp.old_terms(v.overrides) || '{"earn_from":"sales","rewards":[]}')), 12) = v.fingerprint,
  format('the sales agreement still hashes to %s', v.fingerprint))
from (values
  ('{}'::jsonb, '1114402db03d'),
  ('{"commission_duration":"first_payment","commission_months":null}', '4a2c60ebf248'),
  ('{"commission_duration":"lifetime","commission_months":null,"commission_rate_bps":1250}', '5ae74229490e'),
  ('{"commission_type":"fixed","commission_rate_bps":null,"commission_fixed_minor":125000,"currency":"EUR","minimum_payout_minor":5005}', '60dbed0c9a6a'),
  ('{"attribution_window_days":1,"hold_days":0,"minimum_payout_minor":0,"approval_mode":"manual"}', 'e9176b845de9'),
  (jsonb_build_object('brand_name', null, 'extra_terms', E'No coupon sites.\n  Keep it friendly.\n'), 'c8d2ed323b6a')) v(overrides, fingerprint);
select pg_temp.check(kma_internal.program_terms_earn_from(pg_temp.old_terms()) = 'sales'
  and kma_internal.program_terms_rewards(pg_temp.old_terms()) = '[]'
  and kma_internal.program_terms_earn_from('{"earn_from":"installs"}') = 'sales'
  and kma_internal.program_terms_earn_from(null) = 'sales' and kma_internal.program_terms_rewards(null) = '[]'
  and kma_internal.program_terms_rewards('{"earn_from":"sales","rewards":[{"key":"a","label":"A","amount_minor":1}]}') = '[]'
  and kma_internal.program_terms_rewards('{"earn_from":"both","rewards":null}') = '[]'
  and kma_internal.program_terms_earn_from(pg_temp.event_terms()) = 'events'
  and jsonb_array_length(kma_internal.program_terms_rewards(pg_temp.event_terms('{"earn_from":"both"}'))) = 2,
  'terms with no earn_from are read as sales with no rewards; sales terms never have rewards');

-- A sales program, published while program money is off, as before Phase 6 -----------------------
select pg_temp.check(pg_temp.state('quiet_owner', 'quiet') = '{"can_manage":true,"stripe_connected":true,"brand_name":"Quiet Club",
    "events_available":false,"app_links_available":false,"program":null,
    "checklist":{"stripe_connected":true,"details":false,"landing_page":false,"commission":false,"agreement_read":false},
    "can_submit":false}'::jsonb, 'a workspace with no program is told that events are not available while program money is off');
select pg_temp.save('quiet_owner', 'quiet', '{"name":"Quiet Club","category":"lifestyle","tagline":"A calmer phone.",
  "landing_url":"https://quietclub.io/join","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.check((select s->'program' @> '{"earn_from":"sales","rewards":[],"reward_budget_minor":null}'
    and s->'events_available' = 'false' and (s->'checklist'->>'commission')::boolean from pg_temp.state('quiet_owner', 'quiet') s),
  'a program pays for sales unless it says otherwise, with no rewards and no budget');
select pg_temp.read('quiet_owner', 'quiet');
select pg_temp.submit('quiet_owner', 'quiet');
select pg_temp.approve('quiet');
insert into qa select 'quiet_sha', (pg_temp.terms_row('quiet')).agreement_sha256;
select pg_temp.check((select t.version = 1 and t.terms = '{"program_name":"Quiet Club","brand_name":"Quiet Club","landing_url":"https://quietclub.io/join",
      "commission_type":"percent","commission_rate_bps":2000,"commission_fixed_minor":null,"currency":"USD",
      "commission_duration":"lifetime","commission_months":null,"attribution_window_days":30,"hold_days":14,
      "minimum_payout_minor":2000,"approval_mode":"automatic","extra_terms":null,"earn_from":"sales","rewards":[]}'::jsonb
    and t.agreement::text = pg_temp.agreement_before(t.terms - 'earn_from' - 'rewards')::text
    and t.agreement_sha256 = pg_temp.sha(pg_temp.agreement_before(t.terms - 'earn_from' - 'rewards'))
    and t.agreement->'summary'->0 = '{"label":"Commission","value":"20% of every payment"}'::jsonb
    and jsonb_array_length(t.agreement->'summary') = 4 and jsonb_array_length(t.agreement->'sections') = 11
  from pg_temp.terms_row('quiet') t),
  'the published terms of a sales program say earn_from sales and no rewards; its agreement is the Phase 2 document');
-- The three new columns are touched: rewards and a budget are saved while the program
-- still pays for sales, and earn_from is sent as it is.
select pg_temp.check((select s->'program' @> '{"earn_from":"sales","reward_budget_minor":50000,"has_unpublished_changes":false,"agreement_read":true,
      "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200}]}'
    and not (s->>'can_submit')::boolean
  from pg_temp.save('quiet_owner', 'quiet', '{"earn_from":"sales","reward_budget_minor":50000,
    "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200}]}') s)
  and pg_temp.agreement('quiet_owner', 'quiet')->>'sha256' = (select value from qa where key = 'quiet_sha')
  and pg_temp.agreement('quiet_owner', 'quiet')->'agreement' = (pg_temp.terms_row('quiet')).agreement
  and pg_temp.try('quiet_owner', pg_temp.submit_sql('quiet')) = '22023 nothing_to_publish'
  and (select kma_internal.program_terms(p) = (pg_temp.terms_row('quiet')).terms from pg_temp.program('quiet') p),
  'saving rewards and a budget on a sales program changes neither its terms nor the hash of its agreement: nothing to publish');
select pg_temp.check(pg_temp.save_fails('quiet_owner', 'quiet', '{"earn_from":"events"}') = '22023 events_unavailable'
  and pg_temp.save_fails('quiet_owner', 'quiet', '{"earn_from":"both"}') = '22023 events_unavailable'
  and pg_temp.try('empty_owner', pg_temp.sql('workspace_program_save', 'empty', '''{"name":"Empty","earn_from":"events"}''::jsonb'))
    = '22023 events_unavailable'
  and (select count(*) = 0 from public.affiliate_programs where workspace_id = pg_temp.q('empty'))
  and (pg_temp.save('quiet_owner', 'quiet', '{"earn_from":null}')->'program'->>'earn_from') = 'sales',
  'while program money is off a program cannot be set to pay for events; clearing earn_from means sales');
select pg_temp.check(pg_temp.card('quiet-club') @> '{"earn_from":"sales","rewards":[],"commission_type":"percent","terms_version":1}'
  and pg_temp.keys(pg_temp.card('quiet-club')) = 'approval_mode attribution_window_days brand_name category commission_duration '
    || 'commission_fixed_minor commission_months commission_rate_bps commission_type currency earn_from hold_days logo_path '
    || 'minimum_payout_minor name rewards slug tagline terms_version',
  'the card of a sales program says earn_from sales and has no rewards, beside every key it had');

-- The same program as Phase 2 would have published it: its terms in force have neither key.
insert into public.affiliate_program_terms(program_id, version, terms, agreement, agreement_sha256, created_by)
select t.program_id, 2, t.terms - 'earn_from' - 'rewards', t.agreement, t.agreement_sha256, t.created_by from pg_temp.terms_row('quiet', 1) t;
update public.affiliate_programs set live_terms_version = 2 where id = (pg_temp.program('quiet')).id;
select pg_temp.check((select not (t.terms ? 'earn_from') and not (t.terms ? 'rewards') from pg_temp.terms_row('quiet') t)
  and pg_temp.card('quiet-club') @> '{"earn_from":"sales","rewards":[],"commission_type":"percent","commission_rate_bps":2000,"terms_version":2}'
  and (select s->'program' @> '{"has_unpublished_changes":false,"agreement_read":true,"live_terms_version":2}' and not (s->>'can_submit')::boolean
    from pg_temp.state('quiet_owner', 'quiet') s)
  and pg_temp.try('quiet_owner', pg_temp.submit_sql('quiet')) = '22023 nothing_to_publish'
  and pg_temp.agreement('quiet_owner', 'quiet')->>'sha256' = (select value from qa where key = 'quiet_sha'),
  'terms published before Phase 6 read as sales with no rewards, and the program has nothing new to publish');

-- The form: the three new fields ---------------------------------------------------------------
update public.platform_settings set program_money_enabled = true where singleton;
select pg_temp.check((pg_temp.state('owner', 'fluent')->'events_available') = 'true'
  and (pg_temp.state('analyst', 'fluent')->'events_available') = 'true'
  and (pg_temp.state('quiet_owner', 'quiet')->'events_available') = 'true',
  'with program money on, every workspace is told that events are available');
select pg_temp.check((select s->'program' @> '{"status":"draft","name":"Fluent","earn_from":"events","rewards":[],"reward_budget_minor":null}'
    and s->'checklist' = '{"stripe_connected":true,"details":false,"landing_page":false,"commission":false,"agreement_read":false}'::jsonb
  from pg_temp.call('owner', pg_temp.sql('workspace_program_save', 'fluent', '''{"name":"Fluent","earn_from":"events"}''::jsonb')) s),
  'the first save can make a draft that pays for events, with nothing else chosen yet');
insert into qa select 'revision_before_refusals', (pg_temp.program('fluent')).revision::text;
select pg_temp.check(pg_temp.save_fails('owner', 'fluent', v.input) = '22023 ' || v.code,
  format('%s is refused as %s', left(v.input::text, 70), v.code))
from (values
  ('{"earn_from":"installs"}'::jsonb, 'invalid_earn_from'),
  ('{"earn_from":7}', 'invalid_earn_from'),
  ('{"earn_from":["events"]}', 'invalid_earn_from'),
  ('{"rewards":"signup_completed"}', 'invalid_rewards'),
  ('{"rewards":{"key":"signup_completed","label":"Account created","amount_minor":200}}', 'invalid_rewards'),
  ('{"rewards":7}', 'invalid_rewards'),
  ((select jsonb_build_object('rewards', jsonb_agg(jsonb_build_object('key', 'event_' || n, 'label', 'Reward ' || n, 'amount_minor', 100)))
    from generate_series(1, 6) n), 'invalid_rewards'),
  ('{"rewards":["signup_completed"]}', 'invalid_rewards'),
  ('{"rewards":[null]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created"}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","amount_minor":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"label":"Account created","amount_minor":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200,"limit":5}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200,"name":"x"}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","name":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":7,"label":"Account created","amount_minor":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"","label":"Account created","amount_minor":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"1signup","label":"Account created","amount_minor":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup completed","label":"Account created","amount_minor":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"$signup","label":"Account created","amount_minor":200}]}', 'invalid_rewards'),
  (jsonb_build_object('rewards', jsonb_build_array(jsonb_build_object('key', 'e' || repeat('x', 80), 'label', 'Account created', 'amount_minor', 200))),
    'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":7,"amount_minor":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":null,"amount_minor":200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"   ","amount_minor":200}]}', 'invalid_rewards'),
  (jsonb_build_object('rewards', jsonb_build_array(jsonb_build_object('key', 'signup_completed', 'label', repeat('x', 41), 'amount_minor', 200))),
    'invalid_rewards'),
  (jsonb_build_object('rewards', jsonb_build_array(jsonb_build_object('key', 'signup_completed', 'label', E'Account\ncreated', 'amount_minor', 200))),
    'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":0}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":-200}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":100000001}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":2.5}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":"200"}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":null}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},
    {"key":"signup_completed","label":"Signed up","amount_minor":300}]}', 'invalid_rewards'),
  ('{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},
    {"key":"trial_started","label":" account CREATED ","amount_minor":300}]}', 'invalid_rewards'),
  ('{"reward_budget_minor":99}', 'invalid_reward_budget_minor'),
  ('{"reward_budget_minor":100000001}', 'invalid_reward_budget_minor'),
  ('{"reward_budget_minor":500.5}', 'invalid_reward_budget_minor'),
  ('{"reward_budget_minor":"50000"}', 'invalid_reward_budget_minor'),
  ('{"reward_budget_minor":400,"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},
    {"key":"trial_started","label":"Trial started","amount_minor":500}]}', 'invalid_reward_budget_minor'),
  ('{"earn_from":"events","revenue_share":true}', 'invalid_input')) v(input, code);
select pg_temp.check((pg_temp.program('fluent')).revision = (select value::integer from qa where key = 'revision_before_refusals')
  and (pg_temp.program('fluent')).rewards = '[]' and (pg_temp.program('fluent')).reward_budget_minor is null,
  'none of the refused saves touched the draft');

select pg_temp.check((select s->'program'->'rewards' = '[{"key":"signup_completed","label":"Account created","amount_minor":200},
      {"key":"Trial.Started:v2-x","label":"Trial started","amount_minor":500}]'::jsonb
    and (s->'program'->'rewards'->0)::text = '{"key": "signup_completed", "label": "Account created", "amount_minor": 200}'
    and s->'program'->'reward_budget_minor' = 'null' and not (s->'checklist'->>'commission')::boolean
  from pg_temp.save('owner', 'fluent', '{"rewards":[{"amount_minor":200,"label":"  Account created ","key":"signup_completed"},
    {"key":"Trial.Started:v2-x","label":"Trial started","amount_minor":500}]}') s)
  and (select jsonb_typeof(p.rewards->0->'amount_minor') = 'number' from pg_temp.program('fluent') p),
  'the rewards are saved in the merchant''s order with their labels trimmed; without a budget the program is not complete');
select pg_temp.check(pg_temp.save_fails('owner', 'fluent', '{"reward_budget_minor":499}') = '22023 invalid_reward_budget_minor'
  and (pg_temp.save('owner', 'fluent', '{"reward_budget_minor":500}')->'program'->>'reward_budget_minor')::bigint = 500
  and pg_temp.save_fails('owner', 'fluent', '{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":501}]}')
    = '22023 invalid_reward_budget_minor'
  and (pg_temp.save('owner', 'fluent', '{"reward_budget_minor":100000000,
    "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":100000000}]}')->'checklist'->>'commission')::boolean,
  'the budget must cover the largest reward, whichever of the two a save changes; both go up to 1,000,000.00');
select pg_temp.check((pg_temp.save('owner', 'fluent', '{"rewards":null}')->'program'->'rewards') = '[]'
  and (select s->'program'->'reward_budget_minor' = '100000000' and not (s->'checklist'->>'commission')::boolean
    from pg_temp.state('owner', 'fluent') s)
  and (pg_temp.save('owner', 'fluent', '{"rewards":[{"key":"a","label":"A","amount_minor":1}]}')->'program'->'rewards')
    = '[{"key":"a","label":"A","amount_minor":1}]'
  and (pg_temp.save('owner', 'fluent', '{"rewards":[]}')->'program'->'rewards') = '[]'
  and (pg_temp.save('owner', 'fluent', '{"reward_budget_minor":null}')->'program'->'reward_budget_minor') = 'null',
  'null or an empty list clears the rewards, and null clears the budget; a save replaces the whole list');

-- A draft may be incomplete; what it pays for decides what it needs ------------------------------
select pg_temp.save('owner', 'fluent', '{"landing_url":"https://fluent.speaksix.com/start",
  "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},
    {"key":"trial_started","label":"Trial started","amount_minor":500}]}');
select pg_temp.check(pg_temp.agreement('owner', 'fluent') = '{"agreement":null,"sha256":null,"complete":false}'::jsonb
  and (select kma_internal.program_terms(p) is null from pg_temp.program('fluent') p)
  and pg_temp.try('owner', pg_temp.submit_sql('fluent')) = '22023 program_incomplete',
  'an events program with rewards and no budget has no terms and no agreement yet');
select pg_temp.check((select s->'checklist' = '{"stripe_connected":true,"details":false,"landing_page":true,"commission":true,"agreement_read":false}'::jsonb
    from pg_temp.save('owner', 'fluent', '{"reward_budget_minor":50000}') s)
  and (pg_temp.agreement('analyst', 'fluent')->>'complete')::boolean
  and pg_temp.try('owner', pg_temp.submit_sql('fluent')) = '22023 program_incomplete',
  'with a reward and a budget the checklist item is ticked and the agreement can be read; publishing also needs the card');
select pg_temp.check((select not (s->'checklist'->>'commission')::boolean and s->'program' @> '{"earn_from":"both","commission_type":null}'
    from pg_temp.save('owner', 'fluent', '{"earn_from":"both"}') s)
  and pg_temp.agreement('owner', 'fluent')->'agreement' = 'null'
  and (select (s->'checklist'->>'commission')::boolean from pg_temp.save('owner', 'fluent',
    '{"commission_type":"percent","commission_rate_bps":3000,"commission_duration":"lifetime"}') s)
  and pg_temp.agreement('owner', 'fluent')->'agreement'->'summary'->0 = '{"label":"Commission","value":"30% of every payment"}'::jsonb
  and (select not (s->'checklist'->>'commission')::boolean from pg_temp.save('owner', 'fluent', '{"rewards":[]}') s)
  and (select (s->'checklist'->>'commission')::boolean and s->'program'->'rewards' = '[]'
    from pg_temp.save('owner', 'fluent', '{"earn_from":"sales"}') s)
  and jsonb_array_length(pg_temp.agreement('owner', 'fluent')->'agreement'->'sections') = 11,
  'a draft that pays for both needs a commission as well as a reward and a budget; one that pays for sales needs only the commission');
select pg_temp.check((select s->'program' @> '{"earn_from":"events","commission_type":"percent","commission_rate_bps":3000,"commission_duration":"lifetime",
      "reward_budget_minor":50000}' and (s->'checklist'->>'commission')::boolean
    from pg_temp.save('owner', 'fluent', '{"earn_from":"events","category":"education","tagline":"Speak a new language in ten minutes a day.",
      "approval_mode":"manual","rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},
        {"key":"trial_started","label":"Trial started","amount_minor":500}]}') s)
  and (select kma_internal.program_terms(p) = pg_temp.event_terms('{"approval_mode":"manual"}') from pg_temp.program('fluent') p),
  'going back to events keeps the commission on the form but leaves it out of the terms');
select pg_temp.capture('workspace_program_get.events_draft', pg_temp.state('owner', 'fluent'));
select pg_temp.check(pg_temp.keys(pg_temp.state('owner', 'fluent')) = 'app_links_available brand_name can_manage can_submit checklist events_available program stripe_connected'
  and pg_temp.keys(pg_temp.state('owner', 'fluent')->'program') = 'agreement_read app_link approval_mode attribution_window_days category '
    || 'commission_duration commission_fixed_minor commission_months commission_rate_bps commission_type currency earn_from extra_terms '
    || 'first_published_at has_unpublished_changes hold_days id landing_url live_terms_version logo_path marketplace_listed '
    || 'minimum_payout_minor name pause_reason review_note revision reward_budget_minor rewards slug status submitted_at tagline updated_at',
  'ProgramState gains events_available, and its program gains earn_from, rewards and reward_budget_minor');

-- The events the form offers ---------------------------------------------------------------------
insert into public.analytics_event_definitions(project_id, name, status, description, first_seen, last_seen) values
  (pg_temp.q('project_web'), 'signup_completed', 'live', 'An account was made', '2026-10-03 09:00+00', '2026-11-12 18:30+00'),
  (pg_temp.q('project_app'), 'signup_completed', 'live', null, '2026-09-20 08:00+00', '2026-11-13 07:15+00'),
  (pg_temp.q('project_web'), 'trial_started', 'live', null, '2026-10-05 10:00+00', '2026-11-13 09:00+00'),
  (pg_temp.q('project_app'), 'lesson_finished', 'live', 'A lesson was finished', '2026-10-01 10:00+00', '2026-11-01 10:00+00'),
  (pg_temp.q('project_web'), 'lesson_finished', 'blocked', 'Blocked on the web', '2026-08-01 10:00+00', '2026-11-13 11:00+00'),
  (pg_temp.q('project_web'), 'debug_ping', 'blocked', null, '2026-10-01 10:00+00', '2026-11-13 12:00+00'),
  (pg_temp.q('project_rival'), 'chapter_read', 'live', null, '2026-10-01 10:00+00', '2026-11-13 12:00+00');
insert into public.analytics_event_definitions(project_id, name, first_seen, last_seen)
select pg_temp.q('project_quiet'), 'event_' || lpad(n::text, 3, '0'), '2026-10-01 10:00+00', timestamptz '2026-11-01 00:00+00' + make_interval(mins => n)
from generate_series(1, 205) n;
select pg_temp.capture('workspace_program_reward_events.listed', pg_temp.reward_events('owner', 'fluent'));
select pg_temp.capture('workspace_program_reward_events.none', pg_temp.reward_events('empty_owner', 'empty'));
select pg_temp.check(pg_temp.reward_events('owner', 'fluent') = '{"events":[
    {"name":"trial_started","description":null,"first_seen":"2026-10-05T10:00:00+00:00","last_seen":"2026-11-13T09:00:00+00:00","suggested_label":null},
    {"name":"signup_completed","description":"An account was made","first_seen":"2026-09-20T08:00:00+00:00","last_seen":"2026-11-13T07:15:00+00:00","suggested_label":null},
    {"name":"lesson_finished","description":"A lesson was finished","first_seen":"2026-10-01T10:00:00+00:00","last_seen":"2026-11-01T10:00:00+00:00","suggested_label":null}]}'::jsonb
  and pg_temp.reward_events('analyst', 'fluent') = pg_temp.reward_events('owner', 'fluent'),
  'the events the workspace has received are listed once per name over its projects, the latest first; blocked ones are left out');
select pg_temp.check(pg_temp.reward_events('empty_owner', 'empty') = '{"events":[]}'::jsonb
  and pg_temp.reward_events('rival_owner', 'rival') = '{"events":[{"name":"chapter_read","description":null,
    "first_seen":"2026-10-01T10:00:00+00:00","last_seen":"2026-11-13T12:00:00+00:00","suggested_label":null}]}'::jsonb,
  'a workspace sees only its own events, and none when nothing has arrived');
select pg_temp.check((select jsonb_array_length(e->'events') = 200 and e->'events'->0->>'name' = 'event_205'
    and e->'events'->199->>'name' = 'event_006' from pg_temp.reward_events('quiet_owner', 'quiet') e),
  'at most 200 events are listed, the most recently seen');
select pg_temp.check(pg_temp.try('stranger', pg_temp.sql('workspace_program_reward_events', 'fluent')) like 'P0002%'
  and pg_temp.try('rival_owner', pg_temp.sql('workspace_program_reward_events', 'fluent')) like 'P0002%'
  and pg_temp.try('owner', 'select public.workspace_program_reward_events(null)') like 'P0002%'
  and pg_temp.try_signed_out('authenticated', pg_temp.sql('workspace_program_reward_events', 'fluent')) = '42501'
  and pg_temp.try_signed_out('anon', pg_temp.sql('workspace_program_reward_events', 'fluent')) = '42501'
  and pg_temp.try_signed_out('service_role', pg_temp.sql('workspace_program_reward_events', 'fluent')) = '42501',
  'only members of the workspace can list its events');

-- The agreement of a program that pays for events --------------------------------------------------
select pg_temp.capture('workspace_program_agreement.events', pg_temp.agreement('owner', 'fluent'));
select pg_temp.check((select a->>'sha256' = pg_temp.sha(a->'agreement') and (a->>'complete')::boolean
    and a->'agreement' = pg_temp.doc(pg_temp.event_terms('{"approval_mode":"manual"}'))
    and pg_temp.keys(a->'agreement') = 'brand_name extra_terms program_name sections summary title'
  from pg_temp.agreement('owner', 'fluent') a),
  'the agreement of an events program is generated from its terms and nothing else, in the shape every agreement has');
select pg_temp.check((select d - 'sections' = '{"title":"Fluent Affiliate Agreement","brand_name":"Fluent Labs","program_name":"Fluent",
      "summary":[{"label":"Rewards","value":"$2.00 per Account created, $5.00 per Trial started"},
        {"label":"Attribution window","value":"30 days"},{"label":"Hold before payout","value":"30 days"},
        {"label":"Minimum payout","value":"$20.00"}],"extra_terms":null}'::jsonb
    and pg_temp.headings(d) = '1. Who this agreement is between | 2. What you promote | 3. Rewards | 4. How a reward is credited to you | '
      || '5. Limits on rewards | 6. Hold and rejected rewards | 7. Payouts | 8. How you may promote | 9. The Fluent name and logo | '
      || '10. Changes to these terms | 11. Ending this agreement | 12. Independent relationship'
    and (select bool_and(jsonb_array_length(s->'paragraphs') between 1 and 5
        and (select bool_and(jsonb_typeof(x) = 'string' and length(x #>> '{}') between 15 and 400) from jsonb_array_elements(s->'paragraphs') x))
      from jsonb_array_elements(d->'sections') s)
  from pg_temp.doc(pg_temp.event_terms()) d),
  'it has a title, a summary that starts with the rewards, and twelve numbered sections of short paragraphs');
select pg_temp.check((select pg_temp.section(d, 'Rewards') = '["You earn a reward when a person who opened your link does one of the things below. Each reward is a fixed amount.",
      "Account created: $2.00.", "Trial started: $5.00.",
      "Each reward is earned once per person. If the same person does the same thing again, you earn nothing more for it.",
      "This program pays these rewards only. Sales made through your link earn no commission."]'::jsonb
    and pg_temp.section(d, 'How a reward is credited to you') = '["A reward is credited to you when a person opens your link and, within 30 days of that click, does what the reward is for.",
      "If that person opened more than one creator''s link in that time, the reward goes to the last link they opened.",
      "Only actions that KissMyApps has tracked count. Your own actions earn nothing: you cannot earn a reward by signing up to Fluent or using it yourself."]'::jsonb
    and pg_temp.section(d, 'Limits on rewards') = '["Fluent Labs sets a budget for rewards for each calendar month and can change it at any time. KissMyApps sets a limit on what one creator can earn in rewards in one day.",
      "Rewards stop when the monthly budget or your daily limit is reached, and start again with the next month or the next day. Actions in between earn no reward."]'::jsonb
    and pg_temp.section(d, 'Hold and rejected rewards') = '["A reward is held for 30 days after it is earned before it can be paid out.",
      "During the hold Fluent Labs may reject a reward that is fake, a duplicate or your own action. A rejected reward is cancelled and pays nothing."]'::jsonb
    and pg_temp.section(d, 'Payouts')->>1 = 'Rewards become payable once they have passed the hold. They are paid when what is payable to you reaches $20.00.'
    and pg_temp.section(d, 'Who this agreement is between')->>0 = 'This agreement is between you, the creator, and Fluent Labs, the business behind Fluent. '
      || 'KissMyApps is the platform the program runs on. It tracks what people do after they open your link and pays your rewards on behalf of Fluent Labs.'
    and pg_temp.section(d, 'Commission') is null and pg_temp.section(d, 'How a sale is credited to you') is null
    and d::text !~* 'commission and|budget of|\d{4}-\d{2}-\d{2}|signup_completed|trial_started'
  from pg_temp.doc(pg_temp.event_terms()) d),
  'it says what the rewards are, once per person, the last link in the window, the limits, the hold and rejection, and that sales earn nothing');
select pg_temp.check((select d->'summary' @> '[{"label":"Rewards","value":"1,250.00 EUR per Paid plan"},{"label":"Attribution window","value":"1 day"},
      {"label":"Hold before payout","value":"None"},{"label":"Minimum payout","value":"None"}]'
    and pg_temp.section(d, 'Rewards')->>1 = 'Paid plan: 1,250.00 EUR.'
    and pg_temp.section(d, 'How a reward is credited to you')->>0 like '%within 1 day of that click%'
    and pg_temp.section(d, 'Hold on rewards') = '["Rewards are not held. A reward is ready for payout once KissMyApps has recorded it."]'::jsonb
    and pg_temp.section(d, 'Hold and rejected rewards') is null
    and pg_temp.section(d, 'Payouts')->>1 = 'Rewards become payable once KissMyApps has confirmed them. There is no minimum payout.'
    and pg_temp.section(d, 'Ending this agreement')->>1 = 'What you earned before it ended is still paid.'
    and pg_temp.section(d, 'What you promote')->>1 = 'You can start as soon as you accept this agreement.'
    and pg_temp.section(d, 'Who this agreement is between')->>0 like 'This agreement is between you, the creator, and Fluent. KissMyApps%'
    and d->>'extra_terms' = 'No coupon sites.' and jsonb_array_length(d->'sections') = 13
    and d->'sections'->12 = '{"heading":"13. Additional terms from Fluent","paragraphs":["Fluent added the terms below. They are part of this agreement, but they cannot reduce what you have already earned."]}'::jsonb
  from pg_temp.doc(pg_temp.event_terms('{"brand_name":null,"currency":"EUR","attribution_window_days":1,"hold_days":0,"minimum_payout_minor":0,
    "extra_terms":"No coupon sites.","rewards":[{"key":"plan_paid","label":"Paid plan","amount_minor":125000}]}')) d),
  'the window, the hold, the minimum payout, the currency and the brand''s extra terms are written as they were set');
select pg_temp.check(pg_temp.doc(pg_temp.event_terms('{"rewards":[]}')) is null and pg_temp.doc(pg_temp.event_terms('{"rewards":null}')) is null
  and pg_temp.doc(pg_temp.event_terms('{"program_name":null}')) is null and pg_temp.doc(pg_temp.event_terms('{"landing_url":null}')) is null
  and pg_temp.doc(pg_temp.event_terms('{"earn_from":"both"}')) is null
  and pg_temp.doc(pg_temp.event_terms()) = pg_temp.doc(pg_temp.event_terms())
  and pg_temp.sha(pg_temp.doc(pg_temp.event_terms())) <> pg_temp.sha(pg_temp.doc(pg_temp.event_terms('{"hold_days":31}')))
  and pg_temp.sha(pg_temp.doc(pg_temp.event_terms())) <> pg_temp.sha(pg_temp.doc(pg_temp.event_terms(
    '{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":201},{"key":"trial_started","label":"Trial started","amount_minor":500}]}')))
  and (select provolatile = 'i' from pg_proc where oid = 'kma_internal.program_agreement(jsonb)'::regprocedure),
  'with too little to go on there is no document; the same terms always give the same one, and a changed amount changes its hash');
select pg_temp.check(kma_internal.program_commission_headline(pg_temp.event_terms()) = '$2.00 per Account created, $5.00 per Trial started'
  and kma_internal.program_commission_headline(pg_temp.event_terms('{"rewards":[{"key":"a","label":"Account created","amount_minor":200}]}'))
    = '$2.00 per Account created'
  and kma_internal.program_commission_headline(pg_temp.event_terms(
    '{"earn_from":"both","commission_type":"percent","commission_rate_bps":3000,"commission_duration":"lifetime"}'))
    = '30% of every payment, plus rewards'
  and kma_internal.program_commission_headline(pg_temp.event_terms(
    '{"earn_from":"both","commission_type":"fixed","commission_fixed_minor":2000,"commission_duration":"months","commission_months":6}'))
    = '$20.00 on every payment for 6 months, plus rewards',
  'the one-line headline names the rewards for events, and the commission "plus rewards" for both');

-- A draft becomes a published events program -------------------------------------------------------
select pg_temp.read('owner', 'fluent');
select pg_temp.check(pg_temp.try('owner', pg_temp.submit_sql('fluent')) = '22023 balance_required',
  'with program money on, publishing needs money in the balance, as for any program');
select pg_temp.fund('fluent', 'owner', 200000);
select pg_temp.check((select s->'program' @> '{"status":"in_review","earn_from":"events","live_terms_version":null}' from pg_temp.submit('owner', 'fluent') s),
  'the events program is sent for review');
select pg_temp.capture('list_admin_program_reviews.events', pg_temp.reviews());
select pg_temp.check((select r @> '{"status":"in_review","earn_from":"events","reward_budget_minor":50000,"commission_type":"percent",
      "workspace_name":"Fluent","brand_name":"Fluent Labs","stripe_account_id":"acct_Fluent",
      "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},{"key":"trial_started","label":"Trial started","amount_minor":500}]}'
    and r->'agreement' = pg_temp.doc(pg_temp.event_terms('{"approval_mode":"manual"}'))
    and r - 'agreement' = pg_temp.state('owner', 'fluent')->'program' || jsonb_build_object(
      'workspace_id', pg_temp.q('fluent'), 'workspace_name', 'Fluent', 'brand_name', 'Fluent Labs',
      'stripe_account_id', 'acct_Fluent', 'stripe_country', 'GB', 'reviewed_at', null)
  from pg_temp.review_row('fluent') r)
  and (pg_temp.review_row('quiet') @> '{"earn_from":"sales","reward_budget_minor":50000,"status":"live"}'),
  'the review shows what the program pays for, its rewards, its budget and the agreement creators would accept');
select pg_temp.check(pg_temp.approve('fluent') = jsonb_build_object('program_id', (pg_temp.program('fluent')).id, 'status', 'live'),
  'KissMyApps approves it');
select pg_temp.capture('workspace_program_get.events_live', pg_temp.state('owner', 'fluent'));
select pg_temp.check((select t.version = 1 and t.terms = '{"program_name":"Fluent","brand_name":"Fluent Labs","landing_url":"https://fluent.speaksix.com/start",
      "commission_type":null,"commission_rate_bps":null,"commission_fixed_minor":null,"currency":"USD",
      "commission_duration":null,"commission_months":null,"attribution_window_days":30,"hold_days":30,
      "minimum_payout_minor":2000,"approval_mode":"manual","extra_terms":null,"earn_from":"events",
      "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},{"key":"trial_started","label":"Trial started","amount_minor":500}]}'::jsonb
    and not (t.terms ? 'reward_budget_minor') and t.agreement = kma_internal.program_agreement(t.terms) and t.agreement_sha256 = pg_temp.sha(t.agreement)
  from pg_temp.terms_row('fluent') t)
  and (select s->'program' @> '{"status":"live","earn_from":"events","live_terms_version":1,"has_unpublished_changes":false,"agreement_read":true,
      "reward_budget_minor":50000,"commission_type":"percent"}' and not (s->>'can_submit')::boolean from pg_temp.state('owner', 'fluent') s)
  and (select x.status = 'active' from public.products x where x.id = (pg_temp.program('fluent')).product_id),
  'terms version 1 has the rewards and no commission, and never the budget; the program is live');
select pg_temp.check((select c = '{"slug":"fluent","name":"Fluent","category":"education","tagline":"Speak a new language in ten minutes a day.",
      "logo_path":null,"brand_name":"Fluent Labs","commission_type":null,"commission_rate_bps":null,"commission_fixed_minor":null,
      "currency":"USD","commission_duration":null,"commission_months":null,"attribution_window_days":30,"hold_days":30,
      "minimum_payout_minor":2000,"approval_mode":"manual","terms_version":1,"earn_from":"events",
      "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200},{"key":"trial_started","label":"Trial started","amount_minor":500}]}'::jsonb
    from pg_temp.card('fluent') c),
  'the card of an events program has its rewards and no commission');

-- A published program stays complete for what it pays for ------------------------------------------
select pg_temp.check(pg_temp.save_fails('owner', 'fluent', v.input) = '22023 ' || v.code,
  format('a published events program cannot be saved with %s', v.input))
from (values ('{"rewards":[]}'::jsonb, 'invalid_rewards'), ('{"rewards":null}', 'invalid_rewards'),
  ('{"reward_budget_minor":null}', 'invalid_reward_budget_minor'), ('{"reward_budget_minor":499}', 'invalid_reward_budget_minor'),
  ('{"earn_from":"sales","commission_type":null}', 'invalid_commission_type'),
  ('{"earn_from":"both","commission_duration":null}', 'invalid_commission_duration'),
  ('{"earn_from":"both","commission_rate_bps":null}', 'invalid_commission_rate_bps'),
  ('{"earn_from":"installs"}', 'invalid_earn_from'), ('{"name":null}', 'invalid_name')) v(input, code);
select pg_temp.check((select s->'program' @> '{"commission_type":null,"commission_duration":null,
      "earn_from":"events","has_unpublished_changes":false,"agreement_read":true}'
    from pg_temp.save('owner', 'fluent', '{"commission_type":null,"commission_duration":null}') s)
  and pg_temp.save_fails('owner', 'fluent', '{"earn_from":"sales"}') = '22023 invalid_commission_type'
  and pg_temp.save_fails('owner', 'fluent', '{"earn_from":"both"}') = '22023 invalid_commission_type'
  and pg_temp.save_fails('owner', 'fluent', '{"earn_from":"both","commission_type":"percent","commission_rate_bps":3000}')
    = '22023 invalid_commission_duration',
  'the commission codes do not apply to a published events program, and apply again the moment it would pay for sales');
select pg_temp.check((select s->'program' @> '{"reward_budget_minor":80000,"has_unpublished_changes":false,"agreement_read":true,"live_terms_version":1}'
    and not (s->>'can_submit')::boolean from pg_temp.save('owner', 'fluent', '{"reward_budget_minor":80000}') s)
  and pg_temp.try('owner', pg_temp.submit_sql('fluent')) = '22023 nothing_to_publish'
  and (pg_temp.program('fluent')).reward_budget_minor = 80000
  and pg_temp.card('fluent')::text !~ 'budget|80000',
  'the budget changes at once with nothing to publish and nothing for creators to accept; no card carries it');

-- Creators join; then the rewards change ------------------------------------------------------------
select pg_temp.join('ada', 'fluent');
select pg_temp.call('owner', format('select public.workspace_program_creator_decide(%L, %L)', pg_temp.q('fluent'),
  jsonb_build_object('member_id', (select m.id from public.affiliate_program_members m
    where m.program_id = (pg_temp.program('fluent')).id and m.affiliate_id = pg_temp.q('creator_ada')), 'action', 'approve')));
select pg_temp.check((select d->'membership' @> '{"status":"active","terms_version":1,"needs_new_terms":false}'
    and d->'membership'->'program' = pg_temp.card('fluent') and d->'program'->'agreement' = (pg_temp.terms_row('fluent')).agreement
  from pg_temp.detail('ada', 'fluent') d),
  'a creator joins the events program under terms version 1');
select pg_temp.check((select (s->'program'->>'has_unpublished_changes')::boolean and not (s->'program'->>'agreement_read')::boolean
    and not (s->>'can_submit')::boolean and s->'program'->'rewards'->0->'amount_minor' = '300'
  from pg_temp.save('owner', 'fluent', '{"rewards":[{"key":"signup_completed","label":"Account created","amount_minor":300},
    {"key":"trial_started","label":"Trial started","amount_minor":500},{"key":"lesson_finished","label":"First lesson","amount_minor":100}]}') s)
  and pg_temp.card('fluent')->'rewards'->0->'amount_minor' = '200' and jsonb_array_length(pg_temp.card('fluent')->'rewards') = 2
  and pg_temp.try('owner', pg_temp.submit_sql('fluent')) = '22023 agreement_not_read',
  'changed rewards wait on the working copy: creators keep seeing the published ones until the new agreement is read and published');
select pg_temp.read('owner', 'fluent');
select pg_temp.check((select s->'program' @> '{"live_terms_version":2,"has_unpublished_changes":false,"agreement_read":true,"status":"live"}'
    from pg_temp.submit('owner', 'fluent') s)
  and (select t.terms->'rewards' = '[{"key":"signup_completed","label":"Account created","amount_minor":300},
      {"key":"trial_started","label":"Trial started","amount_minor":500},{"key":"lesson_finished","label":"First lesson","amount_minor":100}]'::jsonb
      and t.agreement->'summary'->0->>'value' = '$3.00 per Account created, $5.00 per Trial started, $1.00 per First lesson'
      and t.agreement_sha256 <> (pg_temp.terms_row('fluent', 1)).agreement_sha256
    from pg_temp.terms_row('fluent') t)
  and (pg_temp.terms_row('fluent', 1)).terms->'rewards'->0->'amount_minor' = '200'
  and pg_temp.card('fluent') @> '{"terms_version":2}' and jsonb_array_length(pg_temp.card('fluent')->'rewards') = 3,
  'publishing writes terms version 2 with the new rewards, with no second review; version 1 is untouched');
select pg_temp.check((select d->'membership' @> '{"status":"active","terms_version":1,"needs_new_terms":true}'
    and d->'program' @> '{"terms_version":2}' and d->'program'->>'agreement_sha256' = (pg_temp.terms_row('fluent')).agreement_sha256
  from pg_temp.detail('ada', 'fluent') d),
  'a member who joined under version 1 is asked to accept the new terms');
select pg_temp.capture('partner_program_detail.events', pg_temp.detail('ada', 'fluent'));
select pg_temp.check((select pg_temp.keys(d) = 'accept_name membership program'
    and pg_temp.keys(d->'program') = 'agreement agreement_sha256 approval_mode attribution_window_days brand_name category commission_duration '
      || 'commission_fixed_minor commission_months commission_rate_bps commission_type currency earn_from hold_days id landing_url logo_path '
      || 'minimum_payout_minor name rewards slug status tagline terms_version'
    and d->'program' @> '{"earn_from":"events","commission_type":null,"commission_duration":null}'
    and d::text !~ 'reward_budget|80000'
  from pg_temp.detail('ada', 'fluent') d),
  'the program detail has earn_from and the rewards beside every key it had, and nothing about the budget');
-- Only the event behind a reward changes: the words creators read stay the same.
select pg_temp.check((select (s->'program'->>'has_unpublished_changes')::boolean and (s->'program'->>'agreement_read')::boolean
    and (s->>'can_submit')::boolean
  from pg_temp.save('owner', 'fluent', '{"rewards":[{"key":"account_created","label":"Account created","amount_minor":300},
    {"key":"trial_started","label":"Trial started","amount_minor":500},{"key":"lesson_finished","label":"First lesson","amount_minor":100}]}') s)
  and pg_temp.agreement('owner', 'fluent')->>'sha256' = (pg_temp.terms_row('fluent')).agreement_sha256
  and (pg_temp.submit('owner', 'fluent')->'program'->>'live_terms_version')::integer = 3
  and (pg_temp.terms_row('fluent')).terms->'rewards'->0->>'key' = 'account_created'
  and (pg_temp.terms_row('fluent')).agreement_sha256 = (pg_temp.terms_row('fluent', 2)).agreement_sha256
  and pg_temp.try('owner', pg_temp.submit_sql('fluent')) = '22023 nothing_to_publish',
  'a reward that moves to another event is a new terms version too, though the agreement reads the same');

-- A program that pays for both ------------------------------------------------------------------------
select pg_temp.save('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","earn_from":"both","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"months","commission_months":6,"hold_days":14,"reward_budget_minor":30000,
  "rewards":[{"key":"chapter_read","label":"First chapter read","amount_minor":150}]}');
select pg_temp.capture('workspace_program_agreement.both', pg_temp.agreement('rival_owner', 'rival'));
select pg_temp.check((select d - 'sections' = '{"title":"Rival Reader Affiliate Agreement","brand_name":"Rival Media","program_name":"Rival Reader",
      "summary":[{"label":"Commission","value":"20% of every payment for 6 months"},{"label":"Rewards","value":"$1.50 per First chapter read"},
        {"label":"Attribution window","value":"30 days"},{"label":"Hold before payout","value":"14 days"},
        {"label":"Minimum payout","value":"$20.00"}],"extra_terms":null}'::jsonb
    and pg_temp.headings(d) = '1. Who this agreement is between | 2. What you promote | 3. Commission | 4. How a sale is credited to you | '
      || '5. Rewards | 6. How a reward is credited to you | 7. Limits on rewards | 8. Hold, refunds and chargebacks | '
      || '9. Hold and rejected rewards | 10. Payouts | 11. How you may promote | 12. The Rival Reader name and logo | '
      || '13. Changes to these terms | 14. Ending this agreement | 15. Independent relationship'
    and pg_temp.section(d, 'Commission') = pg_temp.section(b, 'Commission')
    and pg_temp.section(d, 'How a sale is credited to you') = pg_temp.section(b, 'How a sale is credited to you')
    and pg_temp.section(d, 'Rewards') = '["You also earn a reward when a person who opened your link does one of the things below, whether or not they buy. Each reward is a fixed amount.",
      "First chapter read: $1.50.",
      "Each reward is earned once per person. If the same person does the same thing again, you earn nothing more for it."]'::jsonb
    and pg_temp.section(d, 'Hold, refunds and chargebacks')->>0 = pg_temp.section(b, 'Hold, refunds and chargebacks')->>0
    and pg_temp.section(d, 'Hold and rejected rewards')->>0 = 'A reward is held for 14 days after it is earned before it can be paid out.'
    and pg_temp.section(d, 'Payouts')->>1 = 'Commission and rewards become payable once they have passed the hold. They are paid when what is payable to you reaches $20.00.'
    and pg_temp.section(d, 'How you may promote')->>3 = 'Sales and actions that break these rules earn nothing.'
    and d::text !~ 'Sales made through your link earn no commission'
  from pg_temp.agreement('rival_owner', 'rival') a, lateral (select a->'agreement' as d) x,
    lateral (select pg_temp.agreement_before((select kma_internal.program_terms(p) from pg_temp.program('rival') p)) as b) y),
  'the agreement of a program that pays for both has the commission and the sale sections as a sales program has them, and the reward sections');
select pg_temp.fund('rival', 'rival_owner', 100000);
select pg_temp.read('rival_owner', 'rival');
select pg_temp.submit('rival_owner', 'rival');
select pg_temp.approve('rival');
select pg_temp.capture('workspace_program_get.both_live', pg_temp.state('rival_owner', 'rival'));
select pg_temp.capture('workspace_program_get.sales_live', pg_temp.state('quiet_owner', 'quiet'));
select pg_temp.check((select t.terms @> '{"earn_from":"both","commission_type":"percent","commission_rate_bps":2000,"commission_duration":"months",
      "commission_months":6,"rewards":[{"key":"chapter_read","label":"First chapter read","amount_minor":150}]}'
    from pg_temp.terms_row('rival') t)
  and pg_temp.card('rival-reader') @> '{"earn_from":"both","commission_type":"percent","commission_rate_bps":2000,"terms_version":1,
    "rewards":[{"key":"chapter_read","label":"First chapter read","amount_minor":150}]}'
  and (select s->'program' @> '{"status":"live","earn_from":"both","reward_budget_minor":30000}' from pg_temp.state('rival_owner', 'rival') s),
  'a program that pays for both is published with its commission and its rewards');
select pg_temp.check(pg_temp.save_fails('rival_owner', 'rival', v.input) = '22023 ' || v.code,
  format('a published program that pays for both cannot be saved with %s', v.input))
from (values ('{"rewards":[]}'::jsonb, 'invalid_rewards'), ('{"reward_budget_minor":null}', 'invalid_reward_budget_minor'),
  ('{"commission_type":null}', 'invalid_commission_type'), ('{"commission_duration":null}', 'invalid_commission_duration'),
  ('{"commission_type":"fixed"}', 'invalid_commission_fixed_minor')) v(input, code);
select pg_temp.check((select (s->'program'->>'has_unpublished_changes')::boolean and s->'program' @> '{"earn_from":"sales","reward_budget_minor":30000}'
      and jsonb_array_length(s->'program'->'rewards') = 1
    from pg_temp.save('rival_owner', 'rival', '{"earn_from":"sales"}') s)
  and pg_temp.agreement('rival_owner', 'rival')->'agreement'
    = pg_temp.agreement_before((select kma_internal.program_terms(p) from pg_temp.program('rival') p))
  and (select kma_internal.program_terms(p)->'rewards' = '[]' from pg_temp.program('rival') p)
  and (select not (s->'program'->>'has_unpublished_changes')::boolean and (s->'program'->>'agreement_read')::boolean
    from pg_temp.save('rival_owner', 'rival', '{"earn_from":"both"}') s),
  'going back to sales keeps the rewards and the budget on the form and gives the plain sales agreement; going forward again changes nothing');
select pg_temp.call('rival_owner', pg_temp.sql('workspace_program_set_status', 'rival', '''paused''', (pg_temp.program('rival')).revision::text));
select pg_temp.check(pg_temp.save_fails('rival_owner', 'rival', '{"rewards":[]}') = '22023 invalid_rewards'
  and pg_temp.save_fails('rival_owner', 'rival', '{"reward_budget_minor":null}') = '22023 invalid_reward_budget_minor'
  and pg_temp.save_fails('rival_owner', 'rival', '{"commission_type":null}') = '22023 invalid_commission_type'
  and (pg_temp.save('rival_owner', 'rival', '{"reward_budget_minor":40000}')->'program' @> '{"status":"paused","reward_budget_minor":40000}')
  and (pg_temp.call('rival_owner', pg_temp.sql('workspace_program_set_status', 'rival', '''live''',
    (pg_temp.program('rival')).revision::text))->'program'->>'status') = 'live',
  'a paused program is held to the same rules, and its budget can still be changed');

-- What creators and the marketplace read ---------------------------------------------------------------
select pg_temp.join('ada', 'rival');
select pg_temp.capture('partner_program_detail.both', pg_temp.detail('ada', 'rival-reader'));
select pg_temp.capture('marketplace_programs.mixed', pg_temp.service('select public.marketplace_programs()'));
select pg_temp.check((select jsonb_array_length(r->'programs') = 3
    and (select string_agg(c->>'slug' || ':' || (c->>'earn_from') || ':' || jsonb_array_length(c->'rewards') || ':' || coalesce(c->>'commission_type', '-'),
        ' ' order by c->>'slug') from jsonb_array_elements(r->'programs') c)
      = 'fluent:events:3:- quiet-club:sales:0:percent rival-reader:both:1:percent'
    and (select bool_and(pg_temp.keys(c) = pg_temp.keys(pg_temp.card('quiet-club'))) from jsonb_array_elements(r->'programs') c)
    and r::text !~ 'budget'
  from pg_temp.service('select public.marketplace_programs()') r),
  'the marketplace lists a sales, an events and a both program, each card with earn_from and its rewards');
select pg_temp.check((select d->'program' @> '{"earn_from":"both","commission_type":"percent","commission_rate_bps":2000,
      "rewards":[{"key":"chapter_read","label":"First chapter read","amount_minor":150}]}'
    and d->'membership' @> '{"status":"active","terms_version":1,"needs_new_terms":false}'
    and d->'membership'->'program' = pg_temp.card('rival-reader')
    and d->'program'->'agreement'->'summary'->1 = '{"label":"Rewards","value":"$1.50 per First chapter read"}'::jsonb
  from pg_temp.detail('ada', 'rival-reader') d)
  and pg_temp.service('select public.marketplace_program(''fluent'')')->'program' = pg_temp.detail('ada', 'fluent')->'program'
  and (select (select string_agg(c->>'slug' || ':' || (c->>'earn_from') || ':' || coalesce(c->>'membership_status', '-'), ' ' order by c->>'slug')
        from jsonb_array_elements(m->'programs') c) = 'fluent:events:active quiet-club:sales:- rival-reader:both:active'
      and (select bool_and(x->'program' ? 'earn_from' and x->'program' ? 'rewards') from jsonb_array_elements(m->'memberships') x)
      and jsonb_array_length(m->'memberships') = 2
    from pg_temp.call('ada', 'select public.partner_marketplace()') m),
  'the program detail, the public program page, the signed-in marketplace and a creator''s memberships all carry earn_from and the rewards');

-- A sale of a program that pays for events only earns nothing -------------------------------------------
select pg_temp.fund('quiet', 'quiet_owner', 100000);
select pg_temp.join('ben', 'quiet');
update public.affiliate_program_members set activated_at = now() - interval '90 days';
insert into qa select 'click_' || v.k, pg_temp.click(v.creator, v.workspace)
from (values ('fluent', 'ada', 'fluent'), ('rival', 'ada', 'rival'), ('quiet', 'ben', 'quiet')) v(k, creator, workspace);
insert into qa select 'fluent_available', (pg_temp.account('fluent')).available_minor::text;
select pg_temp.sale('f1', 'fluent', pg_temp.q('click_fluent'), 10000, now());
select pg_temp.sale('r1', 'rival', pg_temp.q('click_rival'), 10000, now());
select pg_temp.sale('q1', 'quiet', pg_temp.q('click_quiet'), 10000, now());
select pg_temp.check(pg_temp.commission('f1') = 'not_earned 0 0 sales_not_rewarded'
  and (select x.member_id is not null and x.terms_version = 1 and x.commission_type is null and x.hold_until is null
    from public.program_commissions x where x.sale_id = pg_temp.q('f1'))
  and (pg_temp.account('fluent')).available_minor = (select value::bigint from qa where key = 'fluent_available')
  and (pg_temp.program('fluent')).status = 'live',
  'a sale through a member of an events program earns nothing: sales_not_rewarded, no money set aside, the program stays live');
select pg_temp.check(pg_temp.commission('r1') = 'held 2000 200 -' and pg_temp.commission('q1') = 'held 2000 200 -'
  and (select x.terms_version = 2 from public.program_commissions x where x.sale_id = pg_temp.q('q1')),
  'a sale of a program that pays for both, and of one whose terms are from before Phase 6, earns its commission as before');
-- Fluent starts paying for sales too. Ada has not accepted that yet.
select pg_temp.save('owner', 'fluent', '{"earn_from":"both","commission_type":"percent","commission_rate_bps":1000,"commission_duration":"lifetime"}');
select pg_temp.read('owner', 'fluent');
select pg_temp.check((pg_temp.submit('owner', 'fluent')->'program'->>'live_terms_version')::integer = 4
  and pg_temp.card('fluent') @> '{"earn_from":"both","commission_type":"percent","commission_rate_bps":1000,"terms_version":4}',
  'the events program publishes terms that pay for sales as well');
select pg_temp.sale('f2', 'fluent', pg_temp.q('click_fluent'), 10000, clock_timestamp());
select pg_temp.check(pg_temp.commission('f2') = 'not_earned 0 0 sales_not_rewarded',
  'a member who has only accepted the events terms still earns nothing on a sale');
select pg_temp.accept('ada', 'fluent');
select pg_temp.sale('f3', 'fluent', pg_temp.q('click_fluent'), 10000, clock_timestamp());
select pg_temp.check(pg_temp.commission('f3') = 'held 1000 100 -'
  and (select x.terms_version = 4 from public.program_commissions x where x.sale_id = pg_temp.q('f3'))
  and pg_temp.commission('f1') = 'not_earned 0 0 sales_not_rewarded' and pg_temp.commission('f2') = 'not_earned 0 0 sales_not_rewarded',
  'once they accept the terms that pay for sales, their next sale earns; the earlier ones stay as they were judged');

-- Program money is switched off again -------------------------------------------------------------------------
update public.platform_settings set program_money_enabled = false where singleton;
select pg_temp.check((select s->'events_available' = 'false' and s->'program' @> '{"earn_from":"both","tagline":"Ten minutes a day.","status":"live"}'
    from pg_temp.save('owner', 'fluent', '{"tagline":"Ten minutes a day."}') s)
  and (pg_temp.save('owner', 'fluent', '{"earn_from":"both","reward_budget_minor":90000}')->'program'->>'reward_budget_minor')::bigint = 90000
  and pg_temp.save_fails('owner', 'fluent', '{"earn_from":"events"}') = '22023 events_unavailable'
  and pg_temp.save_fails('quiet_owner', 'quiet', '{"earn_from":"both"}') = '22023 events_unavailable'
  and pg_temp.card('fluent') @> '{"earn_from":"both"}' and jsonb_array_length(pg_temp.card('fluent')->'rewards') = 3,
  'with program money off again a program that pays for events can still be edited as it is; none can be changed to pay for events');
update public.platform_settings set program_money_enabled = true where singleton;

-- Housekeeping ---------------------------------------------------------------------------------------------
select pg_temp.check((select count(*) = 7 and bool_and(t.agreement_sha256 = pg_temp.sha(t.agreement)
      and t.agreement = kma_internal.program_agreement(t.terms))
    from public.affiliate_program_terms t)
  and (select bool_and(p.revision = 1 + (select count(*) from public.audit_logs a
      where a.target_table = 'affiliate_programs' and a.target_id = p.id and a.action <> 'affiliate_program_created'))
    from public.affiliate_programs p)
  and (select count(*) filter (where a.after_data @> '{"earn_from":"both"}' and a.before_data @> '{"earn_from":"events"}') = 2
      and count(*) filter (where a.after_data ? 'rewards' and a.before_data ? 'rewards') >= 8
      and count(*) filter (where a.after_data @> '{"reward_budget_minor":80000}' and a.before_data @> '{"reward_budget_minor":50000}') = 1
    from public.audit_logs a where a.action = 'affiliate_program_saved' and a.target_id = (pg_temp.program('fluent')).id),
  'every stored agreement still matches its terms and its hash, and every save of the new fields is in the audit log');

select 'ok ' || count(*) || ' program reward terms assertions' from reward_terms_assertions;
rollback;
