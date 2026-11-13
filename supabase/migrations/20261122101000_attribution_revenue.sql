-- Attribution Phase 3, piece A: revenue comes in, and the exchange rates that show it in the
-- project's currency.
--
-- Revenue from events: every new analytics event is looked at once, after it is stored. An
-- event carrying kma_revenue and kma_currency (the SDKs' revenue call, or a server event with
-- those properties) is a payment, a negative amount a refund. Otherwise an event the merchant
-- named in the console (attribution_revenue_events) is a payment, with the amount and the
-- currency where they said. Everything else costs one primary-key lookup. A payment that
-- cannot be counted (no or a bad currency, a bad amount) is counted per day and reason in
-- attribution_revenue_skips so the console can say why. Whatever goes wrong in here is
-- swallowed: an event is never refused or lost because of revenue. Both environments are kept;
-- reports read production only. Nothing is kept for a project that never turned attribution on.
--
-- Revenue from the app stores: program-store-webhook hands attribution_store_revenue the same
-- body it hands record_program_store_event. A production purchase, renewal or refund of a
-- person the project knows becomes a row; the person is found the way that function finds
-- them. The app's own revenue call and the store tool's webhook for one store transaction are
-- one row: both use the key 'txn:<transaction id>' ('refund:<transaction id>' for a refund).
--
-- Exchange rates: the attribution-fx-worker edge function reads the ECB's reference rates once
-- a day and stores them through attribution_fx_store.
--
-- Console: attribution_revenue_setup (analysts and up) says what is set up and what arrived;
-- attribution_revenue_events_save (developers and up) replaces the list of revenue events.
-- Neither returns emails, user IDs or person IDs.
begin;

-- Helpers -------------------------------------------------------------------------------------

-- An amount as the merchant sent it: a JSON number, or (p_strings) a plain decimal string such
-- as "4.99". Null for anything else. The range is checked by the caller.
create function kma_internal.attribution_revenue_number(p_value jsonb, p_strings boolean) returns numeric
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_value) = 'number' then p_value::numeric
    when p_strings and jsonb_typeof(p_value) = 'string' and btrim(p_value #>> '{}') ~ '^[+-]?[0-9]{1,15}(\.[0-9]{1,12})?$'
      then btrim(p_value #>> '{}')::numeric
  end
$$;

-- A product or transaction ID: a string of 1 to 200 characters without control characters,
-- spaces around it dropped. Null for anything else.
create function kma_internal.attribution_revenue_text(p_value jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_value) = 'string' and length(btrim(p_value #>> '{}')) between 1 and 200
    and btrim(p_value #>> '{}') !~ '[[:cntrl:]]' then btrim(p_value #>> '{}') end
$$;

-- Counts one payment that could not be counted, on the UTC day it happened.
create function kma_internal.attribution_revenue_skip(p_project uuid, p_at timestamptz, p_reason text) returns void
language sql volatile set search_path = '' as $$
  insert into public.attribution_revenue_skips as s(project_id, day, reason, events, last_at)
  values (p_project, (p_at at time zone 'UTC')::date, p_reason, 1, now())
  on conflict (project_id, day, reason) do update set events = s.events + 1, last_at = excluded.last_at
$$;

-- A date written YYYY-MM-DD, or null.
create function kma_internal.attribution_day(p_value text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return to_date(p_value, 'YYYY-MM-DD');
exception when others then
  return null;
end $$;

-- The store tool's app user ID and aliases, as record_program_store_event lists them for
-- kma_internal.program_store_person: each name once (ignoring case), the app user ID first, at
-- most 20.
create function kma_internal.attribution_store_ids(p jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select array(select u.v from unnest(array(
      select distinct on (lower(i.v)) i.v from (
        select p->>'app_user_id' as v, 0::bigint as place
        union all
        select a.value #>> '{}', a.place
        from jsonb_array_elements(case when jsonb_typeof(p->'aliases') = 'array' then p->'aliases' else '[]'::jsonb end)
          with ordinality a(value, place)
        where jsonb_typeof(a.value) = 'string') i
      where i.v ~ '^[[:print:]]{1,200}$'
      order by lower(i.v), i.place)) with ordinality u(v, n)
    order by (u.v = p->>'app_user_id') desc, u.n
    limit 20)
$$;

-- The event intake ------------------------------------------------------------------------------

-- Records the payment a new event stands for, if it stands for one. For every other event this
-- is one primary-key lookup (attribution_revenue_events), done before anything else; an event
-- with kma_revenue needs none. Whatever goes wrong after that is swallowed.
create function kma_internal.attribution_revenue_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  m public.attribution_revenue_events;
  v_reserved boolean := new.properties ? 'kma_revenue';
  v_amount numeric;
  v_currency text;
  v_txn text;
  v_reason text;
begin
  if not v_reserved then
    select * into m from public.attribution_revenue_events r
    where r.project_id = new.project_id and r.event_name = new.name;
    if m.project_id is null then
      return null;
    end if;
  end if;
  begin
    if not exists (select 1 from public.attribution_settings s where s.project_id = new.project_id) then
      return null;
    end if;
    if v_reserved then
      v_amount := kma_internal.attribution_revenue_number(new.properties->'kma_revenue', false);
      v_currency := nullif(upper(btrim(new.properties->>'kma_currency')), '');
    else
      v_amount := kma_internal.attribution_revenue_number(new.properties->m.amount_property, true);
      v_currency := coalesce(m.currency, nullif(upper(btrim(new.properties->>m.currency_property)), ''));
    end if;
    if v_amount is null then
      v_reason := 'bad_amount';
    elsif v_currency is null then
      v_reason := 'no_currency';
    elsif v_currency !~ '^[A-Z]{3}$' then
      v_reason := 'bad_currency';
    else
      -- An amount in cents (minor) by the currency's decimals: 499 USD is 4.99, 500 JPY is 500.
      if not v_reserved and m.unit = 'minor' then
        v_amount := v_amount / power(10::numeric, kma_internal.currency_exponent(v_currency));
      end if;
      v_amount := round(v_amount, 6);
      if v_amount = 0 or abs(v_amount) > 1000000000 then
        v_reason := 'bad_amount';
      end if;
    end if;
    if v_reason is not null then
      perform kma_internal.attribution_revenue_skip(new.project_id, new.occurred_at, v_reason);
      return null;
    end if;

    v_txn := kma_internal.attribution_revenue_text(new.properties->'kma_transaction_id');
    insert into public.attribution_revenue(project_id, person_id, environment, occurred_at, amount, currency, origin,
        event_id, event_name, product_id, transaction_id, dedupe_key)
      values (new.project_id, new.person_id, new.environment, new.occurred_at, v_amount, v_currency, 'event',
        new.id, new.name, kma_internal.attribution_revenue_text(new.properties->'kma_product_id'), v_txn,
        case when v_txn is null then 'event:' || new.id
          when v_amount < 0 then 'refund:' || v_txn
          else 'txn:' || v_txn end)
      on conflict (project_id, dedupe_key) do nothing;
  exception when others then
    null;
  end;
  return null;
end $$;
create trigger analytics_events_attribution_revenue
  after insert on public.analytics_events
  for each row execute function kma_internal.attribution_revenue_event();

-- Store revenue (service role) ----------------------------------------------------------------

-- Records the payment one RevenueCat or Adapty call reports, after record_program_store_event
-- took the same body. Production purchases and renewals at the gross price the buyer paid
-- (amount_minor in the purchase currency), dated when the store says they were made; refunds as
-- the negative refunded amount (the whole recorded payment when the tool gave no amount), dated
-- when they arrive. Output {outcome: recorded | duplicate | skipped | ignored, reason?}:
--   skipped: no_person (nobody of the project has the app user ID or an alias), no_currency,
--     bad_currency, bad_amount; each is counted in attribution_revenue_skips;
--   ignored: attribution_off, sandbox, not_a_payment (cancellation or another type), free (no
--     amount), no_transaction, no_payment (a refund of a payment never recorded, with no amount).
-- A malformed body is refused 22023 invalid_event, an unknown connection 28000, as the webhook's
-- first call does.
create function public.attribution_store_revenue(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.program_store_connections;
  v_type text := p->>'type';
  v_refund boolean := p->>'type' = 'refund';
  v_tx text := kma_internal.attribution_revenue_text(p->'transaction_id');
  v_currency text := nullif(upper(btrim(p->>'currency')), '');
  v_minor numeric;
  v_amount numeric;
  v_paid public.attribution_revenue;
  v_at timestamptz := clock_timestamp();
  v_person uuid;
  v_key text;
  v_id bigint;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object'
    or coalesce(p->>('header' || '_sha256'), '') !~ '^[a-f0-9]{64}$'
    or coalesce(p->>'provider', '') not in ('revenuecat', 'adapty')
  then
    raise exception 'Invalid store event' using errcode = '22023', detail = 'invalid_event';
  end if;
  select * into c from public.program_store_connections x
  where x.header_sha256 = p->>('header' || '_sha256') and x.status = 'active' and x.provider = p->>'provider';
  if c.id is null then
    raise exception 'Unknown store connection' using errcode = '28000';
  end if;

  if not exists (select 1 from public.attribution_settings s where s.project_id = c.project_id) then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'attribution_off');
  elsif p->>'environment' is distinct from 'production' then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'sandbox');
  elsif v_type is null or v_type not in ('initial_purchase', 'renewal', 'refund') then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'not_a_payment');
  elsif v_tx is null then
    return jsonb_build_object('outcome', 'ignored', 'reason', 'no_transaction');
  end if;
  v_key := case when v_refund then 'refund:' else 'txn:' end || v_tx;
  if exists (select 1 from public.attribution_revenue r where r.project_id = c.project_id and r.dedupe_key = v_key) then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  if v_refund then
    select * into v_paid from public.attribution_revenue r
    where r.project_id = c.project_id and r.dedupe_key = 'txn:' || v_tx;
    if jsonb_typeof(p->'refunded_minor') = 'number' then
      v_minor := abs((p->'refunded_minor')::numeric);
    end if;
    if v_minor = 0 then
      return jsonb_build_object('outcome', 'ignored', 'reason', 'free');
    elsif v_minor is null or v_currency is null then
      -- No amount said: all of the payment, as it was recorded.
      if v_paid.id is null then
        return jsonb_build_object('outcome', 'ignored', 'reason', 'no_payment');
      end if;
      v_amount := -v_paid.amount;
      v_currency := v_paid.currency;
    end if;
  else
    if jsonb_typeof(p->'amount_minor') = 'number' then
      v_minor := (p->'amount_minor')::numeric;
    end if;
    if coalesce(v_minor, 0) <= 0 then
      return jsonb_build_object('outcome', 'ignored', 'reason', 'free');
    end if;
    if jsonb_typeof(p->'purchased_at') = 'number' and (p->>'purchased_at') ~ '^[0-9]{1,11}$' then
      if (p->>'purchased_at')::bigint > 0 then
        v_at := least(to_timestamp((p->>'purchased_at')::bigint), clock_timestamp());
      end if;
    end if;
  end if;

  if v_amount is null then
    if v_currency is null then
      perform kma_internal.attribution_revenue_skip(c.project_id, v_at, 'no_currency');
      return jsonb_build_object('outcome', 'skipped', 'reason', 'no_currency');
    elsif v_currency !~ '^[A-Z]{3}$' then
      perform kma_internal.attribution_revenue_skip(c.project_id, v_at, 'bad_currency');
      return jsonb_build_object('outcome', 'skipped', 'reason', 'bad_currency');
    end if;
    v_amount := round(v_minor / power(10::numeric, kma_internal.currency_exponent(v_currency)), 6)
      * case when v_refund then -1 else 1 end;
    if v_amount = 0 or abs(v_amount) > 1000000000 then
      perform kma_internal.attribution_revenue_skip(c.project_id, v_at, 'bad_amount');
      return jsonb_build_object('outcome', 'skipped', 'reason', 'bad_amount');
    end if;
  end if;

  -- A refund goes to whoever the payment was recorded for; otherwise the person the tool names.
  v_person := coalesce(v_paid.person_id,
    kma_internal.program_store_person(c.project_id, kma_internal.attribution_store_ids(p)));
  if v_person is null then
    perform kma_internal.attribution_revenue_skip(c.project_id, v_at, 'no_person');
    return jsonb_build_object('outcome', 'skipped', 'reason', 'no_person');
  end if;

  insert into public.attribution_revenue(project_id, person_id, environment, occurred_at, amount, currency, origin,
      store, product_id, transaction_id, dedupe_key)
    values (c.project_id, v_person, 'production', v_at, v_amount, v_currency, 'store',
      c.provider, kma_internal.attribution_revenue_text(p->'product_id'), v_tx, v_key)
    on conflict (project_id, dedupe_key) do nothing
    returning id into v_id;
  return jsonb_build_object('outcome', case when v_id is null then 'duplicate' else 'recorded' end);
end $$;

-- Exchange rates (service role) ---------------------------------------------------------------

-- Stores the ECB's reference rates the attribution-fx-worker read. Input {rates: [{day:
-- "YYYY-MM-DD", currency: "USD", per_eur: 1.0823}, ...]} (at most 20000; the euro itself is
-- skipped; a day and currency given twice keeps the last). All or nothing: one bad rate refuses
-- the call (22023 invalid_input). Output {stored: rates written, latest_day: the newest day
-- stored for any currency, or null}.
create function public.attribution_fx_store(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_bad bigint;
  v_stored integer;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(p_input->'rates') is distinct from 'array'
    or jsonb_array_length(p_input->'rates') > 20000
  then
    raise exception 'rates must be a list of at most 20000 rates' using errcode = '22023', detail = 'invalid_input';
  end if;
  select min(r.n) into v_bad
  from jsonb_array_elements(p_input->'rates') with ordinality r(x, n)
  where not coalesce(case when jsonb_typeof(r.x) = 'object' and jsonb_typeof(r.x->'currency') = 'string'
      and jsonb_typeof(r.x->'per_eur') = 'number' then
    kma_internal.attribution_day(r.x->>'day') between date '1999-01-01' and (now() at time zone 'UTC')::date + 1
    and (r.x->>'currency') ~ '^[A-Z]{3}$'
    and round((r.x->'per_eur')::numeric, 8) > 0 and (r.x->'per_eur')::numeric < 1000000000000 end, false);
  if v_bad is not null then
    raise exception 'Rate % is not a day, a currency and a positive rate', v_bad
      using errcode = '22023', detail = 'invalid_input';
  end if;

  insert into public.attribution_fx_rates as f(currency, day, per_eur)
  select distinct on (r.x->>'currency', r.x->>'day') r.x->>'currency', (r.x->>'day')::date, round((r.x->'per_eur')::numeric, 8)
  from jsonb_array_elements(p_input->'rates') with ordinality r(x, n)
  where r.x->>'currency' <> 'EUR'
  order by r.x->>'currency', r.x->>'day', r.n desc
  on conflict (currency, day) do update set per_eur = excluded.per_eur;
  get diagnostics v_stored = row_count;
  return jsonb_build_object('stored', v_stored,
    'latest_day', (select to_char(max(f.day), 'YYYY-MM-DD') from public.attribution_fx_rates f));
end $$;

-- Console -------------------------------------------------------------------------------------

-- What Settings > Revenue shows. Counts and money only; the last 7 days are production
-- payments of people not marked as bots, in the project's currency at the ECB rate of each
-- payment's UTC day (a currency without a rate is counted in unconverted). Skips are the last 7
-- UTC days, both environments (the table keeps no environment, and a developer testing the
-- revenue call wants to see them).
create function kma_internal.attribution_revenue_setup_json(p_project uuid) returns jsonb
language sql stable set search_path = '' as $$
  with st as (
    select s.currency from public.attribution_settings s where s.project_id = p_project
  ), recent as (
    select r.person_id, r.amount, r.currency, r.origin, (r.occurred_at at time zone 'UTC')::date as day
    from public.attribution_revenue r
    where r.project_id = p_project and r.environment = 'production' and r.occurred_at >= now() - interval '7 days'
      and not exists (select 1 from public.analytics_bot_overrides b
        where b.project_id = p_project and b.verdict = 'bot' and b.person_id = r.person_id)
  ), groups as (
    select g.day, g.currency, g.amount, g.n, kma_internal.attribution_fx_rate(g.currency, st.currency, g.day) as rate
    from (select x.day, x.currency, sum(x.amount) as amount, count(*) as n from recent x group by x.day, x.currency) g
    cross join st
  )
  select jsonb_build_object(
    'currency', st.currency,
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event_name, 'amount_property', e.amount_property,
        'unit', e.unit, 'currency_property', e.currency_property, 'currency', e.currency) order by e.position, e.event_name)
      from public.attribution_revenue_events e where e.project_id = p_project), '[]'::jsonb),
    'stores', (select jsonb_agg(jsonb_build_object('provider', v.provider, 'connected', exists (
        select 1 from public.program_store_connections c
        where c.project_id = p_project and c.provider = v.provider and c.status = 'active')) order by v.n)
      from (values ('revenuecat', 1), ('adapty', 2)) v(provider, n)),
    'last_7d', jsonb_build_object(
      'payments', (select count(*) from recent x where x.amount > 0),
      'refunds', (select count(*) from recent x where x.amount < 0),
      'payers', (select count(distinct x.person_id) from recent x where x.amount > 0),
      'revenue', (select round(coalesce(sum(g.amount * g.rate), 0), 2) from groups g where g.rate is not null),
      'unconverted', (select coalesce(sum(g.n), 0) from groups g where g.rate is null)),
    'last_received_at', (select max(r.received_at) from public.attribution_revenue r
      where r.project_id = p_project and r.environment = 'production'),
    'last_development_at', (select max(r.received_at) from public.attribution_revenue r
      where r.project_id = p_project and r.environment = 'development'),
    'by_origin', coalesce((select jsonb_agg(jsonb_build_object('origin', o.origin, 'payments', o.n) order by o.origin)
      from (select x.origin, count(*) as n from recent x where x.amount > 0 group by x.origin) o), '[]'::jsonb),
    'skipped_7d', coalesce((select jsonb_agg(jsonb_build_object('reason', k.reason, 'events', k.n) order by k.n desc, k.reason)
      from (select s.reason, sum(s.events) as n from public.attribution_revenue_skips s
        where s.project_id = p_project and s.day >= (now() at time zone 'UTC')::date - 6
        group by s.reason) k), '[]'::jsonb),
    'rates_day', (select to_char(max(f.day), 'YYYY-MM-DD') from public.attribution_fx_rates f))
  from st
$$;

create function public.attribution_revenue_setup(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project);
  perform kma_internal.attribution_require_settings(p_project);
  return kma_internal.attribution_revenue_setup_json(p_project);
end $$;

-- Replaces the project's revenue events with p_events: a list of 0 to 10 entries {event,
-- amount_property, unit?: major | minor (default major), currency_property? | currency?}, with
-- exactly one of the last two (a JSON null counts as left out). Events carrying kma_revenue are
-- counted without an entry. Refuses 22023 invalid_input with a message naming the problem.
-- Returns what attribution_revenue_setup returns.
create function public.attribution_revenue_events_save(p_project uuid, p_events jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_n integer := 0;
  v_key text;
  v_label text;
  v_event text;
  v_amount text;
  v_unit text;
  v_property text;
  v_currency text;
  v_names text[] := '{}';
  v_rows jsonb := '[]'::jsonb;
  v_name_rule constant text := '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$';
  v_property_rule constant text := '^[A-Za-z_$][A-Za-z0-9_.$:-]{0,79}$';
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  perform kma_internal.attribution_require_settings(p_project);
  if jsonb_typeof(p_events) is distinct from 'array' then
    perform kma_internal.program_fail('invalid_input', 'Send the revenue events as a list');
  end if;
  if jsonb_array_length(p_events) > 10 then
    perform kma_internal.program_fail('invalid_input', 'List up to 10 revenue events');
  end if;
  for v_item in select x.value from jsonb_array_elements(p_events) x loop
    v_n := v_n + 1;
    v_label := 'Revenue event ' || v_n;
    if jsonb_typeof(v_item) is distinct from 'object' then
      perform kma_internal.program_fail('invalid_input', v_label || ' needs an event name and an amount property');
    end if;
    select k into v_key from jsonb_object_keys(v_item) k
    where k <> all(array['event', 'amount_property', 'unit', 'currency_property', 'currency']) order by k limit 1;
    if v_key is not null then
      perform kma_internal.program_fail('invalid_input', format('%s has a field that cannot be saved: %s', v_label, left(v_key, 40)));
    end if;
    if coalesce(jsonb_typeof(v_item->'event'), 'null') not in ('string', 'null')
      or coalesce(jsonb_typeof(v_item->'amount_property'), 'null') not in ('string', 'null')
      or coalesce(jsonb_typeof(v_item->'unit'), 'null') not in ('string', 'null')
      or coalesce(jsonb_typeof(v_item->'currency_property'), 'null') not in ('string', 'null')
      or coalesce(jsonb_typeof(v_item->'currency'), 'null') not in ('string', 'null')
    then
      perform kma_internal.program_fail('invalid_input', v_label || ': each value is text');
    end if;

    v_event := nullif(btrim(v_item->>'event'), '');
    if v_event is null then
      perform kma_internal.program_fail('invalid_input', v_label || ' needs an event name');
    end if;
    if v_event !~ v_name_rule then
      perform kma_internal.program_fail('invalid_input', v_label || ': an event name starts with a letter and has up to 80 letters, numbers and _ . : -');
    end if;
    v_label := 'Revenue event ' || v_n || ' (' || v_event || ')';
    if v_event = any(v_names) then
      perform kma_internal.program_fail('invalid_input', format('%s is listed twice; list each event once', v_event));
    end if;
    v_names := v_names || v_event;

    v_amount := nullif(btrim(v_item->>'amount_property'), '');
    if v_amount is null then
      perform kma_internal.program_fail('invalid_input', v_label || ' needs the name of the property that holds the amount');
    end if;
    if v_amount !~ v_property_rule then
      perform kma_internal.program_fail('invalid_input', v_label || ': a property name starts with a letter or _ and has up to 80 letters, numbers and _ . $ : -');
    end if;
    if v_amount = 'kma_revenue' then
      perform kma_internal.program_fail('invalid_input', v_label || ': events with kma_revenue are counted without an entry');
    end if;

    v_unit := coalesce(nullif(lower(btrim(v_item->>'unit')), ''), 'major');
    if v_unit not in ('major', 'minor') then
      perform kma_internal.program_fail('invalid_input', v_label || ': the amount is in whole units (major) or in cents (minor)');
    end if;

    v_property := nullif(btrim(v_item->>'currency_property'), '');
    v_currency := nullif(upper(btrim(v_item->>'currency')), '');
    if v_property is not null and v_currency is not null then
      perform kma_internal.program_fail('invalid_input', v_label || ': give the property that holds the currency or one currency, not both');
    end if;
    if v_property is null and v_currency is null then
      perform kma_internal.program_fail('invalid_input', v_label || ' needs the property that holds the currency, or one currency for every such event');
    end if;
    if v_property is not null and v_property !~ v_property_rule then
      perform kma_internal.program_fail('invalid_input', v_label || ': a property name starts with a letter or _ and has up to 80 letters, numbers and _ . $ : -');
    end if;
    if v_currency is not null and v_currency !~ '^[A-Z]{3}$' then
      perform kma_internal.program_fail('invalid_input', v_label || ': a currency is a three-letter code such as USD');
    end if;
    v_rows := v_rows || jsonb_build_object('event', v_event, 'amount_property', v_amount, 'unit', v_unit,
      'currency_property', v_property, 'currency', v_currency, 'position', v_n - 1);
  end loop;

  perform pg_advisory_xact_lock(hashtextextended('attribution-revenue-events:' || p_project::text, 0));
  delete from public.attribution_revenue_events e where e.project_id = p_project and not e.event_name = any(v_names);
  insert into public.attribution_revenue_events as e(project_id, event_name, amount_property, unit, currency_property,
      currency, position, updated_by)
  select p_project, r->>'event', r->>'amount_property', r->>'unit', r->>'currency_property', r->>'currency',
    (r->>'position')::smallint, auth.uid()
  from jsonb_array_elements(v_rows) r
  on conflict (project_id, event_name) do update set amount_property = excluded.amount_property, unit = excluded.unit,
    currency_property = excluded.currency_property, currency = excluded.currency, position = excluded.position,
    updated_at = now(), updated_by = excluded.updated_by;
  return kma_internal.attribution_revenue_setup_json(p_project);
end $$;

-- Who may call what ---------------------------------------------------------------------------

revoke all on function
    kma_internal.attribution_revenue_number(jsonb, boolean), kma_internal.attribution_revenue_text(jsonb),
    kma_internal.attribution_revenue_skip(uuid, timestamptz, text), kma_internal.attribution_day(text),
    kma_internal.attribution_store_ids(jsonb), kma_internal.attribution_revenue_event(),
    kma_internal.attribution_revenue_setup_json(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.attribution_store_revenue(jsonb), public.attribution_fx_store(jsonb)
  from public, anon, authenticated;
grant execute on function public.attribution_store_revenue(jsonb), public.attribution_fx_store(jsonb) to service_role;
revoke all on function public.attribution_revenue_setup(uuid), public.attribution_revenue_events_save(uuid, jsonb)
  from public, anon;
grant execute on function public.attribution_revenue_setup(uuid), public.attribution_revenue_events_save(uuid, jsonb)
  to authenticated;

commit;
