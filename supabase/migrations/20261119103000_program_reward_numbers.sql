-- Affiliate self-serve, Phase 6: the numbers everyone reads, now with events.
--
-- A program can pay for events (rewards) as well as, or instead of, sales. This migration
-- grows the answers the creator's Earnings, Links and Performance pages and the merchant's
-- Creators and Balance pages read, so that a reward shows where a sale does. Nothing here
-- writes: it only counts what the reward engine recorded.
--
-- An event that counts is a row of program_reward_awards with status 'earned' whose
-- commission (program_commissions.award_id) is held or approved. Its earnings are what that
-- commission is worth now. It is placed in time by the award's occurred_at, by the rule a
-- sale's paid_at follows (calendar days in the creator's time zone), and it belongs to the
-- link of the click that earned it.
--
-- Every answer keeps the keys it had with the meaning they had. For a program that pays for
-- sales only the new keys hold their neutral values: events 0, earn_from "sales",
-- rewards [], budget_reached false, kind "sale", reward_label null. What a program earns
-- from is read from its published terms; terms written before this phase name neither
-- earn_from nor rewards and are read as "sales" with no rewards.
--
-- No answer names the person who did an event: no person, session or event id, no email.
begin;

-- What the published terms say ---------------------------------------------------------------

-- What creators of a program earn from: 'sales', 'events' or 'both'. A program that was
-- never published, and terms from before this phase, are 'sales'.
create function kma_internal.program_link_earn_from(p public.affiliate_programs) returns text
language sql stable set search_path = '' as $$
  select coalesce((
    select case when t.terms->>'earn_from' in ('events', 'both') then t.terms->>'earn_from' end
    from public.affiliate_program_terms t
    where t.program_id = p.id and t.version = p.live_terms_version), 'sales')
$$;

-- The rewards of the published terms, in the merchant's order. None for a program that pays
-- for sales only. An item that is not a key, a label and a whole amount a reward can have
-- is left out.
create function kma_internal.program_link_rewards(p public.affiliate_programs)
returns table (place bigint, key text, label text, amount_minor bigint)
language sql stable set search_path = '' as $$
  select q.place, q.key, q.label, q.amount_minor
  from (
    select r.place,
      case when jsonb_typeof(r.item->'key') = 'string' then r.item->>'key' end as key,
      case when jsonb_typeof(r.item->'label') = 'string' then r.item->>'label' end as label,
      case when v.amount = trunc(v.amount) and v.amount between 1 and 100000000 then v.amount::bigint end as amount_minor
    from public.affiliate_program_terms t
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(t.terms->'rewards') = 'array' then t.terms->'rewards' else '[]'::jsonb end)
      with ordinality r(item, place)
    cross join lateral (
      select case when jsonb_typeof(r.item->'amount_minor') = 'number' then (r.item->>'amount_minor')::numeric end as amount) v
    where t.program_id = p.id and t.version = p.live_terms_version
      and t.terms->>'earn_from' in ('events', 'both')) q
  where q.key is not null and q.label is not null and q.amount_minor is not null
$$;

-- Whether the program's reward budget for this calendar month (UTC) is used up: what its
-- rewards earned this month, plus its smallest reward, no longer fits in the budget. The
-- month's use is counted as the reward engine counts it: the amounts of the awards that
-- earned (a rejected reward gives its part back). Always false for a program that pays for
-- sales only. The budget itself is never in an answer a creator reads.
create function kma_internal.program_link_budget_reached(p public.affiliate_programs) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((
    select p.reward_budget_minor is null or u.used_minor + r.smallest_minor > p.reward_budget_minor
    from (select min(x.amount_minor) as smallest_minor from kma_internal.program_link_rewards(p) x) r
    cross join (
      select coalesce(sum(w.amount_minor), 0) as used_minor
      from public.program_reward_awards w
      where w.program_id = p.id and w.status = 'earned'
        and w.occurred_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
        and w.occurred_at < (date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC') u
    where r.smallest_minor is not null), false)
$$;

-- What a creator reads -----------------------------------------------------------------------

-- Clicks, sales, events and earnings of a creator in a program between two moments, per
-- link. A link with nothing in that time has no row. Sales and events tied to no click come
-- under a null link. Earnings are the commissions of the sales and of the events together.
-- (The row gains a column, so the function is made again rather than replaced.)
drop function kma_internal.program_link_stats(uuid, uuid, timestamptz, timestamptz);
create function kma_internal.program_link_stats(p_program uuid, p_affiliate uuid, p_from timestamptz, p_to timestamptz)
returns table (link_id uuid, clicks bigint, sales bigint, earnings_minor bigint, events bigint)
language sql stable set search_path = '' as $$
  select q.link_id, sum(q.clicks)::bigint, sum(q.sales)::bigint, sum(q.earnings_minor)::bigint, sum(q.events)::bigint
  from (
    select k.affiliate_link_id as link_id, count(*) as clicks, 0::bigint as sales, 0::bigint as earnings_minor,
      0::bigint as events
    from public.affiliate_programs p
    join public.clicks k on k.affiliate_id = p_affiliate and k.product_id = p.product_id and not k.is_bot
      and k.occurred_at >= p_from and k.occurred_at < p_to
    join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
    where p.id = p_program
    group by k.affiliate_link_id
    union all
    select k.affiliate_link_id, 0, count(*), coalesce(sum(x.amount_minor), 0)::bigint, 0
    from public.program_sales s
    join public.program_commissions x on x.sale_id = s.id and x.status in ('held', 'approved')
    left join public.clicks k on k.id = s.click_record_id
    where s.program_id = p_program and s.affiliate_id = p_affiliate and s.paid_at >= p_from and s.paid_at < p_to
    group by k.affiliate_link_id
    union all
    select k.affiliate_link_id, 0, 0, coalesce(sum(x.amount_minor), 0)::bigint, count(*)
    from public.program_reward_awards w
    join public.program_commissions x on x.award_id = w.id and x.status in ('held', 'approved')
    left join public.clicks k on k.id = w.click_record_id
    where w.program_id = p_program and w.affiliate_id = p_affiliate and w.status = 'earned'
      and w.occurred_at >= p_from and w.occurred_at < p_to
    group by k.affiliate_link_id) q
  group by q.link_id
$$;

-- The same in one line: {"clicks", "sales", "events", "earnings_minor"}.
create or replace function kma_internal.program_link_totals(p_program uuid, p_affiliate uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('clicks', coalesce(sum(t.clicks), 0)::bigint, 'sales', coalesce(sum(t.sales), 0)::bigint,
    'events', coalesce(sum(t.events), 0)::bigint, 'earnings_minor', coalesce(sum(t.earnings_minor), 0)::bigint)
  from kma_internal.program_link_stats(p_program, p_affiliate, p_from, p_to) t
$$;

-- One program on the Links page: the member's links that are not archived, with what each
-- brought in the last 30 days of the creator's calendar, and what the program pays for.
create or replace function kma_internal.program_links_json(p public.affiliate_programs, p_affiliate uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_zone text := kma_internal.program_link_timezone(p_affiliate);
  v_today date := (now() at time zone v_zone)::date;
  v_from timestamptz := (v_today - 29)::timestamp at time zone v_zone;
  v_to timestamptz := (v_today + 1)::timestamp at time zone v_zone;
  v_working boolean;
begin
  v_working := kma_internal.program_links_live(p) and exists (
    select 1 from public.affiliate_program_members m
    join public.affiliate_links l on l.id = m.main_link_id and l.status = 'active'
    where m.program_id = p.id and m.affiliate_id = p_affiliate and m.status = 'active');
  return (
    select jsonb_build_object(
      'program_id', p.id, 'slug', p.slug, 'name', p.name, 'currency', kma_internal.program_link_currency(p),
      'earn_from', kma_internal.program_link_earn_from(p),
      'working', v_working,
      'paused_reason', case when v_working then null
        when p.status = 'paused' and p.pause_reason = 'balance_empty' then 'balance_empty'
        else 'program_paused' end,
      'custom_links', count(*) filter (where r.kind = 'custom'),
      'links', coalesce(jsonb_agg(jsonb_build_object(
          'link_id', r.link_id, 'kind', r.kind, 'channel', r.channel, 'name', r.name, 'url', r.url,
          'created_at', r.created_at,
          'clicks', coalesce(t.clicks, 0), 'sales', coalesce(t.sales, 0), 'events', coalesce(t.events, 0),
          'earnings_minor', coalesce(t.earnings_minor, 0),
          'removable', r.kind = 'custom'
            and not exists (select 1 from public.clicks k where k.affiliate_link_id = r.link_id))
        order by r.place), '[]'::jsonb))
    from kma_internal.program_link_rows(p.id, p_affiliate) r
    left join kma_internal.program_link_stats(p.id, p_affiliate, v_from, v_to) t on t.link_id = r.link_id
    where r.status <> 'archived');
end $$;

-- A program in the picker of the Performance page.
create or replace function kma_internal.program_link_brief(p public.affiliate_programs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('program_id', p.id, 'slug', p.slug, 'name', p.name,
    'currency', kma_internal.program_link_currency(p), 'earn_from', kma_internal.program_link_earn_from(p))
$$;

-- The Performance page: one program of the signed-in creator over the last 7, 30 or 90
-- days of their calendar, the same number of days before it, each day, each link, each
-- reward of the program, their money in the program and their latest commissions. No data
-- about a buyer or about the person who did an event.
create or replace function public.partner_program_performance(p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_affiliate uuid := kma_internal.program_creator(false);
  v_days integer;
  v_zone text;
  v_today date;
  v_start date;
  v_from timestamptz;
  v_to timestamptz;
  v_programs public.affiliate_programs[];
  p public.affiliate_programs;
  v_answer jsonb;
begin
  perform kma_internal.program_member_input(p_input, array['slug', 'days']);
  if jsonb_typeof(p_input->'days') is distinct from 'number' or p_input->>'days' not in ('7', '30', '90') then
    perform kma_internal.program_fail('invalid_input', 'days must be 7, 30 or 90');
  end if;
  if p_input ? 'slug' and jsonb_typeof(p_input->'slug') not in ('string', 'null') then
    perform kma_internal.program_fail('invalid_input', 'slug must be text');
  end if;
  v_days := (p_input->>'days')::integer;
  v_zone := kma_internal.program_link_timezone(v_affiliate);
  v_today := (now() at time zone v_zone)::date;
  v_start := v_today - (v_days - 1);
  v_from := v_start::timestamp at time zone v_zone;
  v_to := (v_today + 1)::timestamp at time zone v_zone;

  -- Every program the creator is or was an active member of, or has earned in.
  select coalesce(array_agg(q order by q.name, q.id), '{}') into v_programs
  from public.affiliate_programs q
  where exists (select 1 from public.affiliate_program_members m
      where m.program_id = q.id and m.affiliate_id = v_affiliate and m.activated_at is not null)
    or exists (select 1 from public.program_commissions x
      where x.program_id = q.id and x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed'))
    or exists (select 1 from public.program_creator_entries e
      where e.program_id = q.id and e.affiliate_id = v_affiliate);
  if p_input->>'slug' is not null then
    select q.* into p from unnest(v_programs) q where q.slug = p_input->>'slug';
    if p.id is null then
      perform kma_internal.program_fail('program_not_found', 'Program not found', 'P0002');
    end if;
  elsif cardinality(v_programs) > 0 then
    p := v_programs[1];
  end if;

  v_answer := jsonb_build_object(
    'days', v_days, 'timezone', v_zone, 'starts_on', v_start, 'ends_on', v_today,
    'programs', coalesce((select jsonb_agg(kma_internal.program_link_brief(v_programs[n]) order by n)
      from generate_subscripts(v_programs, 1) n), '[]'::jsonb));
  if p.id is null then
    return v_answer || jsonb_build_object(
      'program', null,
      'totals', '{"clicks":0,"sales":0,"events":0,"earnings_minor":0}'::jsonb,
      'previous', '{"clicks":0,"sales":0,"events":0,"earnings_minor":0}'::jsonb,
      'daily', '[]'::jsonb, 'channels', '[]'::jsonb, 'rewards', '[]'::jsonb, 'budget_reached', false,
      'money', null, 'latest', '[]'::jsonb);
  end if;

  return v_answer || jsonb_build_object(
    'program', kma_internal.program_link_brief(p),
    'totals', kma_internal.program_link_totals(p.id, v_affiliate, v_from, v_to),
    'previous', kma_internal.program_link_totals(p.id, v_affiliate,
      (v_start - v_days)::timestamp at time zone v_zone, v_from),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', d.day, 'clicks', coalesce(c.clicks, 0),
          'sales', coalesce(s.sales, 0), 'events', coalesce(e.events, 0),
          'earnings_minor', coalesce(s.earnings_minor, 0) + coalesce(e.earnings_minor, 0)) order by d.day)
      from (select g::date as day from generate_series(v_start::timestamp, v_today::timestamp, interval '1 day') g) d
      left join (
        select (k.occurred_at at time zone v_zone)::date as day, count(*) as clicks
        from public.clicks k
        join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
        where k.affiliate_id = v_affiliate and k.product_id = p.product_id and not k.is_bot
          and k.occurred_at >= v_from and k.occurred_at < v_to
        group by 1) c on c.day = d.day
      left join (
        select (s.paid_at at time zone v_zone)::date as day, count(*) as sales, sum(x.amount_minor)::bigint as earnings_minor
        from public.program_sales s
        join public.program_commissions x on x.sale_id = s.id and x.status in ('held', 'approved')
        where s.program_id = p.id and s.affiliate_id = v_affiliate and s.paid_at >= v_from and s.paid_at < v_to
        group by 1) s on s.day = d.day
      left join (
        select (w.occurred_at at time zone v_zone)::date as day, count(*) as events, sum(x.amount_minor)::bigint as earnings_minor
        from public.program_reward_awards w
        join public.program_commissions x on x.award_id = w.id and x.status in ('held', 'approved')
        where w.program_id = p.id and w.affiliate_id = v_affiliate and w.status = 'earned'
          and w.occurred_at >= v_from and w.occurred_at < v_to
        group by 1) e on e.day = d.day),
    'channels', (
      -- The links that are not archived, then one line for whatever belongs to no such link.
      select coalesce(jsonb_agg(q.line order by q.place), '[]'::jsonb)
      from (
        select r.place, jsonb_build_object('link_id', r.link_id, 'kind', r.kind, 'channel', r.channel, 'name', r.name,
          'clicks', coalesce(t.clicks, 0), 'sales', coalesce(t.sales, 0), 'events', coalesce(t.events, 0),
          'earnings_minor', coalesce(t.earnings_minor, 0)) as line
        from kma_internal.program_link_rows(p.id, v_affiliate) r
        left join kma_internal.program_link_stats(p.id, v_affiliate, v_from, v_to) t on t.link_id = r.link_id
        where r.status <> 'archived'
        union all
        select 1000000, jsonb_build_object('link_id', null, 'kind', 'none', 'channel', null, 'name', 'No link',
          'clicks', coalesce(sum(t.clicks), 0)::bigint, 'sales', coalesce(sum(t.sales), 0)::bigint,
          'events', coalesce(sum(t.events), 0)::bigint,
          'earnings_minor', coalesce(sum(t.earnings_minor), 0)::bigint)
        from kma_internal.program_link_stats(p.id, v_affiliate, v_from, v_to) t
        where not exists (select 1 from kma_internal.program_link_rows(p.id, v_affiliate) r
          where r.link_id = t.link_id and r.status <> 'archived')
        having coalesce(sum(t.sales), 0) + coalesce(sum(t.events), 0) > 0) q),
    -- The rewards the program pays now, each with the events of the window that count.
    'rewards', coalesce((
      select jsonb_agg(jsonb_build_object('key', r.key, 'label', r.label, 'amount_minor', r.amount_minor,
          'count', coalesce(e.events, 0), 'earnings_minor', coalesce(e.earnings_minor, 0)) order by r.place)
      from kma_internal.program_link_rewards(p) r
      left join (
        select w.reward_key, count(*) as events, sum(x.amount_minor)::bigint as earnings_minor
        from public.program_reward_awards w
        join public.program_commissions x on x.award_id = w.id and x.status in ('held', 'approved')
        where w.program_id = p.id and w.affiliate_id = v_affiliate and w.status = 'earned'
          and w.occurred_at >= v_from and w.occurred_at < v_to
        group by w.reward_key) e on e.reward_key = r.key), '[]'::jsonb),
    'budget_reached', kma_internal.program_link_budget_reached(p),
    'money', kma_internal.program_link_money(p.id, v_affiliate),
    'latest', coalesce((
      select jsonb_agg(jsonb_build_object('paid_at', q.paid_at, 'link_name', q.link_name,
          'amount_minor', q.amount_minor, 'status', q.status, 'kind', q.kind, 'reward_label', q.reward_label)
        order by q.place)
      from (
        -- A sale is placed by when it was paid, a reward by when its event happened.
        select coalesce(s.paid_at, w.occurred_at) as paid_at, coalesce(b.name, 'No link') as link_name,
          x.amount_minor, x.status, case when x.award_id is null then 'sale' else 'reward' end as kind, w.reward_label,
          row_number() over (order by coalesce(s.paid_at, w.occurred_at) desc, x.created_at desc, x.id) as place
        from public.program_commissions x
        left join public.program_sales s on s.id = x.sale_id
        left join public.program_reward_awards w on w.id = x.award_id
        left join public.clicks k on k.id = coalesce(s.click_record_id, w.click_record_id)
        left join public.affiliate_links l on l.id = k.affiliate_link_id
        left join lateral kma_internal.program_link_label(p.funnel_id, l) b on l.id is not null
        where x.program_id = p.id and x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        order by place limit 5) q), '[]'::jsonb));
end $$;

-- The signed-in creator's earnings: one line per program they have earned in, their latest
-- 50 commissions (for sales and for rewards), their latest 20 payouts, and what can be paid
-- out. Per program: approved is what is still theirs to be paid, paying is in a payout that
-- is under way, paid is in payouts Stripe confirmed; sales are the sales that earn and events
-- the events that count. The money covers both. No buyer data, nothing about who did an event.
create or replace function public.partner_program_earnings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_affiliate uuid := public.current_partner_affiliate_id(true);
  v_platform text := kma_internal.program_payout_platform();
begin
  -- The payout account is offered to a creator who is in a program on the platform.
  if v_platform is not null and not exists (
    select 1 from public.program_balance_accounts b
    where b.platform_account_id = v_platform and (
      exists (select 1 from public.affiliate_program_members m
        where m.program_id = b.program_id and m.affiliate_id = v_affiliate)
      or exists (select 1 from public.program_creator_entries e
        where e.program_id = b.program_id and e.affiliate_id = v_affiliate))) then
    v_platform := null;
  end if;
  return jsonb_build_object(
    'programs', coalesce((
      select jsonb_agg(jsonb_build_object(
          'program_id', p.id, 'slug', p.slug, 'name', p.name,
          'currency', coalesce(
            (select a.currency from public.program_balance_accounts a where a.program_id = p.id),
            cm.currency, en.currency),
          'pending_minor', cm.pending_minor, 'approved_minor', en.approved_minor,
          'paying_minor', en.paying_minor, 'paid_minor', en.paid_minor,
          'sales', cm.sales, 'events', cm.events, 'next_release_at', cm.next_release_at)
        order by p.name, p.id)
      from (
        select x.program_id from public.program_commissions x
        where x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        union
        select e.program_id from public.program_creator_entries e where e.affiliate_id = v_affiliate) k
      join public.affiliate_programs p on p.id = k.program_id
      cross join lateral (
        select coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor,
          count(*) filter (where x.status in ('held', 'approved') and x.award_id is null) as sales,
          count(*) filter (where x.status in ('held', 'approved') and w.status = 'earned') as events,
          min(x.hold_until) filter (where x.status = 'held') as next_release_at,
          max(x.currency) filter (where x.status <> 'not_earned') as currency
        from public.program_commissions x
        left join public.program_reward_awards w on w.id = x.award_id
        where x.program_id = p.id and x.affiliate_id = v_affiliate) cm
      cross join lateral (
        select coalesce(sum(e.amount_minor), 0)::bigint as approved_minor,
          coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status in ('approved', 'processing')), 0)::bigint
            as paying_minor,
          coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status = 'paid'), 0)::bigint as paid_minor,
          max(e.currency) as currency
        from public.program_creator_entries e
        left join public.program_payouts o on o.id = e.payout_id
        where e.program_id = p.id and e.affiliate_id = v_affiliate) en), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', q.id, 'program_id', q.program_id, 'program_name', q.program_name, 'status', q.status,
          'amount_minor', q.amount_minor, 'earned_minor', q.earned_minor, 'currency', q.currency,
          'sale_amount_minor', q.sale_amount_minor, 'paid_at', q.paid_at,
          'hold_until', q.hold_until, 'approved_at', q.approved_at,
          'kind', q.kind, 'reward_label', q.reward_label)
        order by q.place)
      from (
        -- A reward has no payment: it is placed by when its event happened.
        select x.id, x.program_id, p.name as program_name, x.status, x.amount_minor, x.earned_minor, x.currency,
          s.amount_minor as sale_amount_minor, coalesce(s.paid_at, w.occurred_at) as paid_at, x.hold_until, x.approved_at,
          case when x.award_id is null then 'sale' else 'reward' end as kind, w.reward_label,
          row_number() over (order by coalesce(s.paid_at, w.occurred_at) desc, x.created_at desc, x.id) as place
        from public.program_commissions x
        left join public.program_sales s on s.id = x.sale_id
        left join public.program_reward_awards w on w.id = x.award_id
        join public.affiliate_programs p on p.id = x.program_id
        where x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        order by place limit 50) q), '[]'::jsonb),
    'payouts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', q.id, 'amount_minor', q.amount_minor, 'currency', q.currency, 'status', q.status,
          'created_at', q.created_at, 'paid_at', q.paid_at)
        order by q.created_at desc, q.id)
      from (
        select o.id, o.amount_minor, o.currency, o.status, o.created_at, o.paid_at
        from public.program_payouts o where o.affiliate_id = v_affiliate
        order by o.created_at desc, o.id limit 20) q), '[]'::jsonb),
    'payout', jsonb_build_object(
      'enabled', kma_internal.program_payouts_enabled(),
      'min_payout_minor', coalesce((select s.program_min_payout_minor from public.platform_settings s where s.singleton), 2500),
      'platform_account_id', v_platform,
      'payable', coalesce((
        select jsonb_agg(jsonb_build_object('currency', x.currency, 'amount_minor', x.total) order by x.currency)
        from (select s.currency, sum(s.amount_minor)::bigint as total
          from kma_internal.program_payout_sums(v_platform, v_affiliate) s group by s.currency) x), '[]'::jsonb)));
end $$;

-- What a merchant reads ----------------------------------------------------------------------

-- A member's numbers to date: clicks on every link they have for the program's product,
-- their sales by the same rule the creator's own pages and the Sales summary use (a sale
-- credited to them whose commission is held or approved: a refunded sale and one that
-- earned nothing are listed on the Sales page and not counted here), what those sales came
-- to (the payments as they were made), their events that count, and what their commissions
-- for sales and for rewards are worth now with the part still held. A sale recorded while
-- program money was off has no commission to judge it by and counts as it always did.
-- (The row gains a column, so the function is made again rather than replaced.)
drop function kma_internal.program_link_member_stats(public.affiliate_program_members);
create function kma_internal.program_link_member_stats(m public.affiliate_program_members,
  out clicks bigint, out last_click_at timestamptz, out sales bigint, out sales_amount_minor bigint,
  out commission_minor bigint, out pending_minor bigint, out events bigint)
language sql stable set search_path = '' as $$
  select c.clicks, c.last_click_at, s.sales, s.sales_amount_minor,
    s.commission_minor + e.commission_minor, s.pending_minor + e.pending_minor, e.events
  from (
    -- Naming the creator lets the clicks index find them.
    select count(*) as clicks, max(k.occurred_at) as last_click_at
    from public.affiliate_programs p
    join public.clicks k on k.affiliate_id = m.affiliate_id and k.product_id = p.product_id and not k.is_bot
    join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
    where p.id = m.program_id) c
  cross join (
    select count(*) filter (where x.id is null or x.status in ('held', 'approved')) as sales,
      coalesce(sum(s.amount_minor) filter (where x.id is null or x.status in ('held', 'approved')), 0)::bigint
        as sales_amount_minor,
      coalesce(sum(x.amount_minor) filter (where x.status in ('held', 'approved')), 0)::bigint as commission_minor,
      coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor
    from public.program_sales s
    left join public.program_commissions x on x.sale_id = s.id
    where s.program_id = m.program_id and s.affiliate_id = m.affiliate_id) s
  cross join (
    select count(*) as events,
      coalesce(sum(x.amount_minor), 0)::bigint as commission_minor,
      coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor
    from public.program_reward_awards w
    join public.program_commissions x on x.award_id = w.id and x.status in ('held', 'approved')
    where w.program_id = m.program_id and w.affiliate_id = m.affiliate_id and w.status = 'earned') e
$$;

-- Creator: what a merchant sees about one member. No email, no legal name.
create or replace function kma_internal.program_creator_json(m public.affiliate_program_members) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'member_id', m.id, 'status', m.status, 'name', a.public_name, 'handle', a.slug,
    'country_code', a.country_code, 'channels', to_jsonb(a.channels), 'website_url', a.website_url,
    'requested_at', m.requested_at, 'activated_at', m.activated_at, 'ended_at', m.ended_at,
    'decision_note', m.decision_note,
    'terms_version', m.terms_version, 'needs_new_terms', m.terms_version < p.live_terms_version,
    'clicks', c.clicks, 'sales', c.sales, 'events', c.events, 'last_click_at', c.last_click_at,
    'sales_amount_minor', c.sales_amount_minor, 'commission_minor', c.commission_minor, 'pending_minor', c.pending_minor)
  from public.affiliate_programs p
  join public.affiliates a on a.id = m.affiliate_id
  cross join lateral kma_internal.program_link_member_stats(m) c
  where p.id = m.program_id
$$;

-- The Creators page: the workspace's program, what it pays for, everyone who joined or
-- asked to, and what they sold, the events they brought and what they earned.
create or replace function public.workspace_program_creators(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id);
  p public.affiliate_programs := kma_internal.program_of(p_workspace_id);
begin
  return jsonb_build_object(
    'can_manage', v_role in ('owner', 'admin'),
    'program', case when p.id is not null then jsonb_build_object(
      'id', p.id, 'slug', p.slug, 'name', p.name, 'status', p.status,
      -- How creators are approved today: the published terms, or the form before the first approval.
      'approval_mode', coalesce((select t.terms->>'approval_mode' from public.affiliate_program_terms t
        where t.program_id = p.id and t.version = p.live_terms_version), p.approval_mode),
      'marketplace_listed', p.marketplace_listed) end,
    'currency', case when p.id is not null then kma_internal.program_link_currency(p) end,
    -- What creators earn from by the published terms; 'sales' when there are none.
    'earn_from', kma_internal.program_link_earn_from(p),
    'counts', (
      select jsonb_build_object(
        'pending', count(*) filter (where m.status = 'pending'),
        'active', count(*) filter (where m.status = 'active'),
        'ended', count(*) filter (where m.status in ('declined', 'removed', 'left')))
      from public.affiliate_program_members m where m.program_id = p.id),
    -- Every creator who is or was active, not only the 500 listed below.
    'totals', (
      select jsonb_build_object(
        'clicks', coalesce(sum(c.clicks), 0)::bigint, 'sales', coalesce(sum(c.sales), 0)::bigint,
        'events', coalesce(sum(c.events), 0)::bigint,
        'sales_amount_minor', coalesce(sum(c.sales_amount_minor), 0)::bigint,
        'commission_minor', coalesce(sum(c.commission_minor), 0)::bigint,
        'pending_minor', coalesce(sum(c.pending_minor), 0)::bigint)
      from public.affiliate_program_members m
      cross join lateral kma_internal.program_link_member_stats(m) c
      where m.program_id = p.id and m.status in ('active', 'removed', 'left')),
    'creators', coalesce((
      select jsonb_agg(kma_internal.program_creator_json(q.m) order by q.place)
      from (
        select m, row_number() over (order by
          case m.status when 'pending' then 1 when 'active' then 2 else 3 end,
          case when m.status = 'pending' then m.requested_at end,
          coalesce(m.ended_at, m.activated_at) desc, m.id) as place
        from public.affiliate_program_members m where m.program_id = p.id
        order by place limit 500) q), '[]'::jsonb));
end $$;

-- The Balance page: each line of the activity that is about a reward names the reward.
create or replace function kma_internal.program_balance_state(p_workspace uuid, p_role text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  p public.affiliate_programs := kma_internal.program_of(p_workspace);
  a public.program_balance_accounts;
  v_settings record;
  v_page jsonb;
  v_held record;
  v_approved bigint;
  v_fees bigint;
  v_deposited bigint;
  v_problem jsonb;
  v_activity jsonb;
  v_pending jsonb;
  v_resumes timestamptz;
begin
  select coalesce(s.program_money_enabled, false) as enabled, coalesce(s.program_fee_bps, 1000) as fee_bps,
      coalesce(s.program_min_deposit_minor, 5000) as min_deposit
    into v_settings
    from (select true) one left join public.platform_settings s on s.singleton;
  v_page := jsonb_build_object(
    'enabled', v_settings.enabled, 'can_manage', p_role in ('owner', 'admin'),
    'program', case when p.id is null then null else jsonb_build_object(
      'id', p.id, 'name', p.name, 'status', p.status, 'pause_reason', p.pause_reason, 'currency', p.currency) end,
    'account', null, 'min_deposit_minor', v_settings.min_deposit, 'fee_bps', v_settings.fee_bps,
    'activity', '[]'::jsonb, 'pending_topup', null);
  if p.id is null then
    return v_page;
  end if;
  select * into a from public.program_balance_accounts where program_id = p.id;
  if a.id is null then
    return v_page;
  end if;

  select coalesce(sum(c.amount_minor + c.fee_minor), 0)::bigint as reserved, coalesce(sum(c.amount_minor), 0)::bigint as pending
    into v_held from public.program_commissions c where c.program_id = p.id and c.status = 'held';
  select coalesce(sum(e.amount_minor), 0)::bigint into v_approved from public.program_creator_entries e
    where e.program_id = p.id and e.kind in ('commission_approved', 'clawback');
  select coalesce(sum(c.fee_minor), 0)::bigint into v_fees from public.program_commissions c
    where c.program_id = p.id and c.status in ('held', 'approved');
  select coalesce(sum(e.amount_minor), 0)::bigint into v_deposited from public.program_balance_entries e
    where e.account_id = a.id and e.kind in ('deposit', 'deposit_reversed');

  -- The next try is only promised while automatic top-up is on and has tries left.
  if a.topup_failures > 0 then
    v_problem := jsonb_build_object(
      'code', coalesce(a.topup_failure_code, 'payment_failed'),
      'failed_at', (select max(t.settled_at) from public.program_topups t
        where t.account_id = a.id and t.kind = 'auto' and t.status = 'failed'),
      'retry_at', case when a.auto_topup and a.topup_failures < 4 then a.topup_retry_at end);
  end if;

  -- Set while the day's limit on automatic charges holds the next one back.
  v_resumes := kma_internal.program_topup_resumes_at(a.id, clock_timestamp());

  -- Newest first. Entries written in one transaction share created_at; seq keeps them in
  -- the order they were posted. An entry about a reward's commission carries the reward's
  -- label and no sale amount.
  select coalesce(jsonb_agg(x.entry order by x.created_at desc, x.seq desc), '[]'::jsonb) into v_activity
  from (
    select e.created_at, e.seq, jsonb_build_object(
      'id', e.id, 'kind', e.kind, 'amount_minor', e.amount_minor, 'available_after_minor', e.available_after_minor,
      'created_at', e.created_at, 'creator_name', f.public_name, 'sale_amount_minor', s.amount_minor,
      'reward_label', w.reward_label, 'topup_kind', t.kind, 'note', e.note) as entry
    from public.program_balance_entries e
    left join public.program_commissions c on c.id = e.commission_id
    left join public.affiliates f on f.id = c.affiliate_id
    left join public.program_sales s on s.id = c.sale_id
    left join public.program_reward_awards w on w.id = c.award_id
    left join public.program_topups t on t.id = e.topup_id
    where e.account_id = a.id
    order by e.created_at desc, e.seq desc limit 100) x;

  select jsonb_build_object('id', t.id, 'amount_minor', t.amount_minor, 'status', t.status, 'created_at', t.created_at)
    into v_pending
    from public.program_topups t
    where t.account_id = a.id and t.kind = 'deposit' and t.status in ('pending', 'processing')
    order by t.created_at desc, t.id limit 1;

  return v_page || jsonb_build_object(
    'account', jsonb_build_object(
      'currency', a.currency, 'available_minor', a.available_minor, 'reserved_minor', v_held.reserved,
      'creators_pending_minor', v_held.pending, 'creators_approved_minor', v_approved, 'fees_minor', v_fees,
      'deposited_minor', v_deposited,
      'card', case when a.payment_method_id is null then null else jsonb_build_object(
        'brand', a.card_brand, 'last4', a.card_last4, 'exp_month', a.card_exp_month, 'exp_year', a.card_exp_year) end,
      'auto_topup', a.auto_topup, 'min_balance_minor', a.min_balance_minor, 'topup_amount_minor', a.topup_amount_minor,
      'topup_problem', v_problem,
      'topup_limit', case when a.auto_topup and v_resumes is not null then jsonb_build_object(
        'per_day', kma_internal.program_topup_day_limit(), 'resumes_at', v_resumes) end),
    'activity', v_activity, 'pending_topup', v_pending);
end $$;

-- Access ---------------------------------------------------------------------------------------
-- The internal functions made here are closed to every API role, like the ones they join.
-- The public ones keep the grants they had; they are named again so this file says it all.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'kma_internal'
      and (p.proname like 'program\_link%' or p.proname in ('program_creator_json', 'program_balance_state'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

revoke all on function
    public.partner_program_earnings(), public.partner_program_performance(jsonb), public.workspace_program_creators(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
    public.partner_program_earnings(), public.partner_program_performance(jsonb), public.workspace_program_creators(uuid)
  to authenticated;

commit;
