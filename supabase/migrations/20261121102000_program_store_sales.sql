-- Affiliate self-serve, Phase 8: in-app subscriptions reported by RevenueCat or Adapty.
--
-- A merchant connects RevenueCat or Adapty to one of their analytics projects (one connection
-- per project and tool). The console shows a webhook address and an Authorization header
-- value once; the merchant pastes both into the tool's webhook settings. Only the SHA-256 of
-- the header value is kept. The program-store-webhook Edge Function hashes the header of each
-- call, turns the tool's body into one plain shape and hands it to record_program_store_event.
--
-- Every call is stored once per connection and event ID (program_store_events, no buyer data:
-- no app user ID, no alias, no price in another currency than the one stored). A purchase or a
-- renewal of the production store becomes a program sale when its creator can be found:
--   1. the subscription's first paid payment is already a sale with a creator: a renewal is
--      that creator's ("subscription"), the way a Stripe renewal inherits its first sale;
--   2. otherwise the person of the connection's project whose user ID, distinct ID or one of
--      whose anonymous IDs is the store's app user ID or one of its aliases, and their latest
--      creator touch at or before the purchase inside the published counting window, found
--      the way the Phase 7 rewards judge finds it (the creator click of one of their sessions,
--      or of their counted or flagged app install), on the program's product ("app_user").
-- A purchase without a person or a creator is stored as an unmatched receipt, never a sale.
-- Sandbox purchases, events that are not purchases, renewals, refunds or cancellations, free
-- periods and Stripe purchases (they come through the Stripe connection) are stored as ignored.
--
-- The sale is the store's gross price with its tax and the store's cut (store_fee_minor), so
-- the commission is worked out on the proceeds: amount - tax - store fee. A sale in another
-- currency than the program's earns nothing (currency_mismatch), except that a USD program
-- takes the tool's USD figures. Subscription sequence counts the paid payments the tool
-- reported for the store subscription (original transaction ID), so a trial conversion is the
-- first payment and a renewal is never matched as a first payment. A refund of the store
-- transaction claws back as a Stripe refund does. Everything after that is the Phase 4 chain:
-- the deferred commission triggers, the prepaid balance, the hold and the program pause.
--
-- Callers tell failures apart by SQLSTATE and DETAIL: an unknown or removed connection 28000;
-- a malformed event 22023 invalid_event; console invalid_provider and already_connected
-- 22023, project_not_found and connection_not_found P0002; a role that may not manage the
-- connection 42501 (P0002 for a workspace the caller is not in).
begin;

-- Store connections ------------------------------------------------------------------------------

create table public.program_store_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.analytics_workspaces(id) on delete cascade,
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  provider text not null check (provider in ('revenuecat', 'adapty')),
  -- SHA-256 (hex) of the whole Authorization header value the tool sends, "Bearer <random>".
  -- The value itself is shown once and never stored.
  header_sha256 text not null check (header_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_event_at timestamptz,
  -- Every call stored, the sales they made and the ones ignored or unmatched, since connected.
  events_count bigint not null default 0 check (events_count >= 0),
  sales_count bigint not null default 0 check (sales_count >= 0),
  ignored_count bigint not null default 0 check (ignored_count >= 0),
  constraint program_store_connection_revoked check ((status = 'revoked') = (revoked_at is not null))
);
create unique index program_store_connections_header on public.program_store_connections(header_sha256);
create unique index program_store_connections_active on public.program_store_connections(project_id, provider)
  where status = 'active';
create index program_store_connections_workspace on public.program_store_connections(workspace_id, created_at);

-- One row per call of the tool, as normalized by the webhook. No buyer data.
create table public.program_store_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.program_store_connections(id) on delete cascade,
  event_id text not null check (length(event_id) between 1 and 200),
  type text not null check (type in ('initial_purchase', 'renewal', 'refund', 'cancellation', 'other')),
  environment text not null check (environment in ('production', 'sandbox')),
  store text check (store in ('app_store', 'play_store', 'stripe', 'amazon', 'other')),
  product_id text check (length(product_id) between 1 and 200),
  transaction_id text check (length(transaction_id) between 1 and 200),
  original_transaction_id text check (length(original_transaction_id) between 1 and 200),
  -- When the store says the purchase was made.
  occurred_at timestamptz,
  -- What the buyer paid in the purchase currency, as reported.
  currency text check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint check (amount_minor >= 0),
  -- sale: a program sale was recorded; sale_exists: the transaction already is one; refund:
  -- a sale was refunded; cancellation: noted, nothing to do; ignored_*: not a sale by rule;
  -- unmatched_*: a purchase whose program, person or creator was not found.
  outcome text not null default 'received' check (outcome in ('received', 'sale', 'sale_exists', 'refund',
    'cancellation', 'ignored_sandbox', 'ignored_type', 'ignored_free', 'ignored_store', 'ignored_no_sale',
    'unmatched_program', 'unmatched_person', 'unmatched_creator')),
  sale_id uuid references public.program_sales(id),
  received_at timestamptz not null default now(),
  constraint program_store_event_once unique (connection_id, event_id)
);
create index program_store_events_chain on public.program_store_events(original_transaction_id)
  where original_transaction_id is not null;
create index program_store_events_recent on public.program_store_events(connection_id, received_at desc);
create index program_store_events_received on public.program_store_events(received_at);

alter table public.program_store_connections enable row level security;
alter table public.program_store_events enable row level security;
revoke all on public.program_store_connections, public.program_store_events
  from public, anon, authenticated, service_role;

-- Store sales ------------------------------------------------------------------------------------
-- A store sale has no Stripe connection, account or payment; it always has a creator and a
-- store subscription (its original transaction, the transaction itself for a one-time purchase).
alter table public.program_sales
  alter column connection_id drop not null,
  alter column account_id drop not null,
  alter column payment_intent_id drop not null,
  -- The store's cut of a store sale (Apple, Google), in the sale's currency. The commission is
  -- worked out on amount - tax - store fee.
  add column store_fee_minor bigint check (store_fee_minor >= 0),
  add constraint program_sale_stripe_shape check (source <> 'stripe' or (
    connection_id is not null and account_id is not null and payment_intent_id is not null
    and store_fee_minor is null)),
  add constraint program_sale_app_store_shape check (source = 'stripe' or (
    connection_id is null and account_id is null and payment_intent_id is null and charge_id is null
    and checkout_session_id is null and invoice_id is null and subscription_id is null and customer_id is null
    and fee_minor is null and store is not null and store_original_transaction_id is not null
    and affiliate_id is not null));
alter table public.program_sales drop constraint program_sale_subscription_shape;
alter table public.program_sales add constraint program_sale_subscription_shape check (
  (coalesce(subscription_id, store_original_transaction_id) is null) = (subscription_sequence is null)
  and (first_sale_id is null or (subscription_sequence > 1 and first_sale_id <> id)));
create unique index program_sales_store_transaction on public.program_sales(program_id, source, store_transaction_id)
  where store_transaction_id is not null;
create index program_sales_store_subscription on public.program_sales(program_id, source, store_original_transaction_id)
  where store_original_transaction_id is not null;

-- What a sale's commission is worked out on ---------------------------------------------------------

-- The payment without tax and, for a store sale, without the store's cut: the proceeds.
create function kma_internal.program_sale_basis(p_sale public.program_sales) returns bigint
language sql immutable set search_path = '' as $$
  select greatest(p_sale.amount_minor - coalesce(p_sale.tax_minor, 0) - coalesce(p_sale.store_fee_minor, 0), 0)
$$;

-- The definition from 20261119101000_program_reward_terms.sql with two changes for store sales:
-- the basis is kma_internal.program_sale_basis (the proceeds), and under the months rule a
-- renewal whose first payment is no sale of the program earns nothing, since its months cannot
-- be counted. A Stripe renewal always has its first sale, so nothing changes for Stripe.
create or replace function kma_internal.program_commission_decide(p_sale public.program_sales, p_refunded_minor bigint)
returns public.program_commissions language plpgsql volatile set search_path = '' as $$
declare
  c public.program_commissions;
  v_member public.affiliate_program_members;
  v_terms jsonb;
  v_first_paid_at timestamptz;
  v_account public.program_balance_accounts;
  v_status text;
begin
  c.sale_id := p_sale.id;
  c.program_id := p_sale.program_id;
  c.affiliate_id := p_sale.affiliate_id;
  c.currency := p_sale.currency;
  c.status := 'not_earned';
  c.earned_minor := 0;
  c.amount_minor := 0;
  c.fee_earned_minor := 0;
  c.fee_minor := 0;

  if p_refunded_minor >= p_sale.amount_minor then
    c.reason := 'refunded';
    return c;
  end if;
  if p_sale.affiliate_id is null then
    c.reason := 'no_creator';
    return c;
  end if;

  -- The creator was an active member of the program when the buyer paid.
  select m.* into v_member from public.affiliate_program_members m
  where m.program_id = p_sale.program_id and m.affiliate_id = p_sale.affiliate_id
    and m.activated_at <= p_sale.paid_at
    and ((m.ended_at is null and m.status = 'active') or m.ended_at > p_sale.paid_at);
  if v_member.id is null then
    c.reason := 'not_a_member';
    return c;
  end if;
  c.member_id := v_member.id;

  -- The terms they had accepted by then; before any acceptance, the first they accepted.
  c.terms_version := coalesce(
    (select a.terms_version from public.affiliate_program_acceptances a
      where a.member_id = v_member.id and a.accepted_at <= p_sale.paid_at
      order by a.accepted_at desc, a.terms_version desc limit 1),
    (select a.terms_version from public.affiliate_program_acceptances a
      where a.member_id = v_member.id
      order by a.accepted_at, a.terms_version limit 1),
    v_member.terms_version);
  select t.terms into v_terms from public.affiliate_program_terms t
  where t.program_id = p_sale.program_id and t.version = c.terms_version;
  if v_terms is null then
    raise exception 'Terms version % of program % not found', c.terms_version, p_sale.program_id using errcode = 'P0002';
  end if;
  -- Those terms pay for events only: a sale earns nothing.
  if kma_internal.program_terms_earn_from(v_terms) = 'events' then
    c.reason := 'sales_not_rewarded';
    return c;
  end if;

  case v_terms->>'commission_duration'
    when 'first_payment' then
      if coalesce(p_sale.subscription_sequence, 1) <> 1 then
        c.reason := 'outside_duration';
      end if;
    when 'months' then
      -- Counted from the first sale of the subscription. A sale outside a subscription, and
      -- the first sale itself, always earn. A store renewal whose first payment is no sale
      -- of the program cannot be counted, and earns nothing.
      if p_sale.first_sale_id is not null then
        select f.paid_at into v_first_paid_at from public.program_sales f where f.id = p_sale.first_sale_id;
        if p_sale.paid_at >= v_first_paid_at + make_interval(months => (v_terms->>'commission_months')::integer) then
          c.reason := 'outside_duration';
        end if;
      elsif coalesce(p_sale.subscription_sequence, 1) > 1 then
        c.reason := 'outside_duration';
      end if;
    when 'lifetime' then
      null;
    else
      raise exception 'Unknown commission duration in terms version %', c.terms_version using errcode = 'P0001';
  end case;
  if c.reason is not null then
    return c;
  end if;

  if p_sale.currency is distinct from v_terms->>'currency' then
    c.reason := 'currency_mismatch';
    return c;
  end if;
  select a.* into v_account from public.program_balance_accounts a where a.program_id = p_sale.program_id;
  if v_account.id is null then
    c.reason := 'balance_empty';
    return c;
  end if;
  if v_account.currency <> p_sale.currency then
    c.reason := 'currency_mismatch';
    return c;
  end if;

  select p.status into v_status from public.affiliate_programs p where p.id = p_sale.program_id;
  if v_status is distinct from 'live' then
    c.reason := 'program_paused';
    return c;
  end if;

  -- The payment without tax (and the store's cut); the commission on it; what is left of
  -- both after any refund.
  c.basis_minor := kma_internal.program_sale_basis(p_sale);
  c.commission_type := v_terms->>'commission_type';
  c.commission_rate_bps := (v_terms->>'commission_rate_bps')::integer;
  c.commission_fixed_minor := (v_terms->>'commission_fixed_minor')::bigint;
  c.earned_minor := kma_internal.program_commission_of(
    c.commission_type, c.commission_rate_bps, c.commission_fixed_minor, c.basis_minor);
  if c.earned_minor is null then
    raise exception 'Unknown commission in terms version %', c.terms_version using errcode = 'P0001';
  end if;
  c.amount_minor := kma_internal.program_commission_part(c.earned_minor, p_sale.amount_minor, p_refunded_minor);
  if c.amount_minor <= 0 then
    c.reason := 'zero_amount';
    c.basis_minor := null;
    c.commission_type := null;
    c.commission_rate_bps := null;
    c.commission_fixed_minor := null;
    c.earned_minor := 0;
    c.amount_minor := 0;
    return c;
  end if;
  select s.program_fee_bps into c.fee_bps from public.platform_settings s where s.singleton;
  c.fee_earned_minor := div(c.earned_minor::numeric * c.fee_bps, 10000)::bigint;
  c.fee_minor := kma_internal.program_commission_part(c.fee_earned_minor, p_sale.amount_minor, p_refunded_minor);
  c.hold_until := p_sale.paid_at + make_interval(days => (v_terms->>'hold_days')::integer);
  c.status := 'held';
  return c;
end $$;

-- The definition from 20261116101000_program_commissions.sql, with the basis of a sale worked
-- out by kma_internal.program_sale_basis (the store's cut is left out like tax).
create or replace function kma_internal.program_commission_apply(p_sale_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_sale public.program_sales;
  c public.program_commissions;
  v_refunded bigint;
  v_account uuid;
  v_cap bigint;
  v_amount bigint;
  v_fee bigint;
  v_owed bigint;
  v_take bigint;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_sale from public.program_sales s where s.id = p_sale_id for no key update;
  if not found then
    return;
  end if;
  select * into c from public.program_commissions x where x.sale_id = p_sale_id for no key update;
  v_refunded := kma_internal.program_commission_refunded(v_sale);

  if c.id is null then
    -- A sale recorded before the switch was turned on is never judged.
    if v_sale.created_at < (select s.program_money_enabled_at from public.platform_settings s where s.singleton) then
      return;
    end if;
    perform kma_internal.program_commission_evaluate(v_sale, v_refunded, null);

  elsif c.status = 'not_earned' then
    -- Final, except a sale nobody was credited for that now has a creator.
    if c.reason = 'no_creator' and v_sale.affiliate_id is not null then
      perform kma_internal.program_commission_evaluate(v_sale, v_refunded, c.id);
    else
      return;
    end if;

  elsif c.status = 'held' and v_sale.affiliate_id is distinct from c.affiliate_id then
    -- The sale moved to another creator, or to nobody: everything set aside goes back and
    -- the sale is judged again from the top.
    select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
    if c.amount_minor > 0 then
      perform kma_internal.program_balance_post(v_account, 'commission_returned', c.amount_minor, null, c.id);
    end if;
    if c.fee_minor > 0 then
      perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor, null, c.id);
    end if;
    perform kma_internal.program_commission_evaluate(v_sale, v_refunded, c.id);

  elsif c.status in ('held', 'approved') then
    -- What the commission may still be: never more than it is, less when part of the
    -- payment was refunded (or tax turned out higher than first known).
    v_cap := least(c.earned_minor, kma_internal.program_commission_of(c.commission_type, c.commission_rate_bps,
      c.commission_fixed_minor, kma_internal.program_sale_basis(v_sale)));
    v_amount := least(c.amount_minor, kma_internal.program_commission_part(v_cap, v_sale.amount_minor, v_refunded));
    if v_amount is null then
      raise exception 'Commission % cannot be worked out again', c.id using errcode = 'P0001';
    end if;

    if c.status = 'held' then
      v_fee := case when v_amount = 0 then 0 else least(c.fee_minor, kma_internal.program_commission_part(
        div(v_cap::numeric * c.fee_bps, 10000)::bigint, v_sale.amount_minor, v_refunded)) end;
      if v_amount = c.amount_minor and v_fee = c.fee_minor then
        return;
      end if;
      select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
      if v_amount < c.amount_minor then
        perform kma_internal.program_balance_post(v_account, 'commission_returned', c.amount_minor - v_amount, null, c.id);
      end if;
      if v_fee < c.fee_minor then
        perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor - v_fee, null, c.id);
      end if;
      update public.program_commissions set
        amount_minor = v_amount, fee_minor = v_fee,
        status = case when v_amount = 0 then 'reversed' else 'held' end,
        reversed_at = case when v_amount = 0 then v_now end,
        updated_at = v_now
      where id = c.id;

    else
      -- Approved: the commission is the creator's, so what a refund takes back comes out of
      -- what the creator still has coming from this program, and never more than that. The
      -- fee stays.
      if v_amount = c.amount_minor then
        return;
      end if;
      perform kma_internal.program_creator_lock(c.program_id, c.affiliate_id);
      select coalesce(sum(e.amount_minor), 0) into v_owed from public.program_creator_entries e
      where e.affiliate_id = c.affiliate_id and e.program_id = c.program_id;
      v_take := least(c.amount_minor - v_amount, greatest(v_owed, 0));
      if v_take <= 0 then
        return;
      end if;
      select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
      insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
      values (c.affiliate_id, c.program_id, c.currency, 'clawback', -v_take, c.id);
      perform kma_internal.program_balance_post(v_account, 'commission_returned', v_take, null, c.id);
      update public.program_commissions set amount_minor = amount_minor - v_take, updated_at = v_now where id = c.id;
    end if;

  else
    -- Reversed: nothing more can happen to it.
    return;
  end if;

  perform kma_internal.program_commission_check(p_sale_id);
end $$;

-- Helpers -----------------------------------------------------------------------------------------

-- Where the merchant points the tool: the program-store-webhook function of the same project
-- the database's own schedules call (program-sales-worker and the others).
create function kma_internal.program_store_webhook_url(p_provider text) returns text
language sql immutable set search_path = '' as $$
  select 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-store-webhook/' || p_provider
$$;

-- A new header value: "Bearer " and 32 random bytes in base64url (43 characters).
create function kma_internal.program_store_header_value() returns text
language sql volatile set search_path = '' as $$
  select 'Bearer ' || rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=')
$$;

-- What the console shows of one connection, with its calls of the last 30 days.
create function kma_internal.program_store_connection_json(c public.program_store_connections) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'provider', c.provider, 'project_id', c.project_id,
    'project_name', (select pr.name from public.analytics_projects pr where pr.id = c.project_id),
    'status', c.status, 'created_at', c.created_at, 'last_event_at', c.last_event_at,
    'events_30d', n.events, 'sales_30d', n.sales, 'ignored_30d', n.ignored,
    'webhook_url', kma_internal.program_store_webhook_url(c.provider))
  from (select count(*) as events, count(*) filter (where e.outcome = 'sale') as sales,
      count(*) filter (where e.outcome like 'ignored\_%' or e.outcome like 'unmatched\_%') as ignored
    from public.program_store_events e
    where e.connection_id = c.id and e.received_at >= now() - interval '30 days') n
$$;

-- The paid production purchases the tool reported for one store subscription of a project,
-- numbered by when each transaction was made: 1 is the first paid payment.
create function kma_internal.program_store_chain(p_project uuid, p_provider text, p_original text)
returns table (transaction_id text, n bigint) language sql stable set search_path = '' as $$
  select t.transaction_id, row_number() over (order by t.first_at, t.transaction_id)
  from (
    select e.transaction_id, min(e.occurred_at) as first_at
    from public.program_store_events e
    join public.program_store_connections c on c.id = e.connection_id
    where e.original_transaction_id = p_original and c.project_id = p_project and c.provider = p_provider
      and e.environment = 'production' and e.type in ('initial_purchase', 'renewal')
      and e.amount_minor > 0 and e.store is distinct from 'stripe' and e.transaction_id is not null
    group by e.transaction_id) t
$$;

-- Numbers the program's sales of one store subscription and gives each later payment the
-- creator of the first, when the first is a sale.
create function kma_internal.program_store_resequence(p_program uuid, p_project uuid, p_provider text, p_original text)
returns void language plpgsql volatile set search_path = '' as $$
declare
  v_first public.program_sales;
begin
  select s.* into v_first from public.program_sales s
  join kma_internal.program_store_chain(p_project, p_provider, p_original) ch
    on ch.transaction_id = s.store_transaction_id and ch.n = 1
  where s.program_id = p_program and s.source = p_provider;

  update public.program_sales s
    set subscription_sequence = ch.n, first_sale_id = case when ch.n > 1 then v_first.id end
    from kma_internal.program_store_chain(p_project, p_provider, p_original) ch
    where s.program_id = p_program and s.source = p_provider and s.store_original_transaction_id = p_original
      and s.store_transaction_id = ch.transaction_id
      and (s.subscription_sequence is distinct from ch.n
        or s.first_sale_id is distinct from case when ch.n > 1 then v_first.id end);

  if v_first.click_record_id is not null then
    update public.program_sales s
      set click_id = v_first.click_id, click_record_id = v_first.click_record_id,
        affiliate_id = v_first.affiliate_id, match_source = 'subscription'
      where s.program_id = p_program and s.source = p_provider and s.store_original_transaction_id = p_original
        and s.subscription_sequence > 1
        and (s.click_record_id is distinct from v_first.click_record_id or s.match_source <> 'subscription');
  end if;
end $$;

-- The person of the project the store's app user ID and aliases name: by distinct ID first
-- (an identified person's distinct ID is their user ID; the app user ID itself before an
-- alias), then by one of the person's anonymous IDs.
create function kma_internal.program_store_person(p_project uuid, p_ids text[]) returns uuid
language sql stable set search_path = '' as $$
  select pe.id from public.analytics_people pe
  where pe.project_id = p_project and cardinality(p_ids) > 0
    and (pe.distinct_id = any(p_ids) or pe.anonymous_ids && p_ids)
  order by (pe.distinct_id = p_ids[1]) desc, (pe.distinct_id = any(p_ids)) desc, pe.last_seen desc, pe.id
  limit 1
$$;

-- The person's last creator link of the program's product opened at or before the purchase,
-- inside the counting window: on a visit, or through the smart link their app install was
-- matched to (step 2 of kma_internal.program_reward_judge).
create function kma_internal.program_store_click(p_product uuid, p_person uuid, p_at timestamptz, p_window_days integer,
  out click_id text, out click_record_id uuid, out affiliate_id uuid)
language sql stable set search_path = '' as $$
  select s.creator_click, c.id, c.affiliate_id
  from (
    select x.creator_click from public.analytics_sessions x
    where x.person_id = p_person and x.creator_click is not null
    union
    select i.creator_click from public.attribution_installs i
    where i.person_id = p_person and i.creator_click is not null and i.verdict in ('counted', 'flagged')) s
  cross join lateral kma_internal.program_sale_click(p_product, s.creator_click) k
  join public.clicks c on c.id = k.click_record_id
  where c.occurred_at <= p_at and c.occurred_at >= p_at - make_interval(days => p_window_days)
  order by c.occurred_at desc, c.id desc
  limit 1
$$;

-- True when the key is absent, JSON null, or a string of 1 to 200 printable characters.
create function kma_internal.program_store_text_ok(p jsonb, p_key text) returns boolean
language sql immutable set search_path = '' as $$
  select case coalesce(jsonb_typeof(p->p_key), 'null')
    when 'null' then true
    when 'string' then (p->>p_key) ~ '^[[:print:]]{1,200}$'
    else false end
$$;

-- The webhook (service role) --------------------------------------------------------------------

-- Records one call of RevenueCat or Adapty, normalized by program-store-webhook. Calling it
-- again with the same event ID changes nothing and answers what the first call did.
-- Input: {header_sha256, provider, event_id, type: initial_purchase|renewal|refund|cancellation|
-- other, environment: production|sandbox, app_user_id, aliases: [..], store, product_id,
-- transaction_id, original_transaction_id, purchased_at (epoch seconds), currency, amount_minor,
-- tax_minor, store_fee_minor, usd: {amount_minor, proceeds_minor} | null, refunded_minor}.
-- Output: {received, duplicate, outcome, sale_id, subscription_sequence}.
create function public.record_program_store_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.program_store_connections;
  r public.program_store_events;
  g public.affiliate_programs;
  s public.program_sales;
  v_first public.program_sales;
  v_click record;
  v_type text := p->>'type';
  v_env text := p->>'environment';
  v_store text := p->>'store';
  v_tx text := p->>'transaction_id';
  v_original text := coalesce(p->>'original_transaction_id', p->>'transaction_id');
  v_currency text := upper(p->>'currency');
  v_at timestamptz;
  v_amount bigint;
  v_tax bigint;
  v_fee bigint;
  v_usd_amount bigint;
  v_usd_proceeds bigint;
  v_terms jsonb;
  v_program_currency text;
  v_window integer;
  v_ids text[];
  v_person uuid;
  v_seq bigint;
  v_first_tx text;
  v_refund bigint;
  v_outcome text;
  v_sale uuid;
  v_new boolean;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object'
    or coalesce(p->>('header' || '_sha256'), '') !~ '^[a-f0-9]{64}$'
    or coalesce(p->>'provider', '') not in ('revenuecat', 'adapty')
    or jsonb_typeof(p->'event_id') is distinct from 'string' or (p->>'event_id') !~ '^[[:print:]]{1,200}$'
    or coalesce(v_type, '') not in ('initial_purchase', 'renewal', 'refund', 'cancellation', 'other')
    or coalesce(v_env, '') not in ('production', 'sandbox')
    or (v_store is not null and v_store not in ('app_store', 'play_store', 'stripe', 'amazon', 'other'))
    or not kma_internal.program_store_text_ok(p, 'app_user_id')
    or not kma_internal.program_store_text_ok(p, 'product_id')
    or not kma_internal.program_store_text_ok(p, 'transaction_id')
    or not kma_internal.program_store_text_ok(p, 'original_transaction_id')
    or (p ? 'aliases' and jsonb_typeof(p->'aliases') not in ('array', 'null'))
    or (jsonb_typeof(p->'aliases') = 'array' and jsonb_array_length(p->'aliases') > 50)
    or not kma_internal.program_sale_amount_ok(p, 'purchased_at', false)
    or (v_currency is not null and v_currency !~ '^[A-Z]{3}$')
    or not kma_internal.program_sale_amount_ok(p, 'amount_minor', false)
    or not kma_internal.program_sale_amount_ok(p, 'tax_minor', false)
    or not kma_internal.program_sale_amount_ok(p, 'store_fee_minor', false)
    or not kma_internal.program_sale_amount_ok(p, 'refunded_minor', false)
    or (p ? 'usd' and jsonb_typeof(p->'usd') not in ('object', 'null'))
    or (jsonb_typeof(p->'usd') = 'object' and (not kma_internal.program_sale_amount_ok(p->'usd', 'amount_minor', false)
      or not kma_internal.program_sale_amount_ok(p->'usd', 'proceeds_minor', false)))
  then
    raise exception 'Invalid store event' using errcode = '22023', detail = 'invalid_event';
  end if;
  v_amount := (p->>'amount_minor')::bigint;
  if (p->>'purchased_at') is not null then
    v_at := to_timestamp((p->>'purchased_at')::bigint);
  end if;
  if v_at is not null and ((p->>'purchased_at')::bigint <= 0 or v_at > clock_timestamp() + interval '10 minutes') then
    raise exception 'Invalid store event' using errcode = '22023', detail = 'invalid_event';
  end if;
  -- What a sale or a refund needs.
  if v_env = 'production' and v_type in ('initial_purchase', 'renewal', 'refund')
    and (v_tx is null or (v_type <> 'refund' and (v_at is null or v_store is null or (v_amount > 0 and v_currency is null))))
  then
    raise exception 'Invalid store event' using errcode = '22023', detail = 'invalid_event';
  end if;

  select * into c from public.program_store_connections x
  where x.header_sha256 = p->>('header' || '_sha256') and x.status = 'active' and x.provider = p->>'provider';
  if c.id is null then
    raise exception 'Unknown store connection' using errcode = '28000';
  end if;

  insert into public.program_store_events(connection_id, event_id, type, environment, store, product_id,
      transaction_id, original_transaction_id, occurred_at, currency, amount_minor)
    values (c.id, p->>'event_id', v_type, v_env, v_store, p->>'product_id', v_tx,
      case when v_tx is not null then v_original end, v_at, v_currency, v_amount)
    on conflict (connection_id, event_id) do nothing
    returning * into r;
  v_new := r.id is not null;
  if not v_new then
    select * into r from public.program_store_events e where e.connection_id = c.id and e.event_id = p->>'event_id';
    return jsonb_build_object('received', true, 'duplicate', true, 'outcome', r.outcome, 'sale_id', r.sale_id,
      'subscription_sequence', (select x.subscription_sequence from public.program_sales x where x.id = r.sale_id));
  end if;

  -- The workspace's approved program.
  select x.* into g from public.affiliate_programs x
  where x.workspace_id = c.workspace_id and x.status in ('live', 'paused');
  if g.id is not null then
    perform pg_advisory_xact_lock(hashtextextended('kma-program-store:' || g.id::text, 0));
  end if;

  if v_env = 'sandbox' then
    v_outcome := 'ignored_sandbox';
  elsif v_type = 'other' then
    v_outcome := 'ignored_type';
  elsif v_type = 'cancellation' then
    v_outcome := 'cancellation';

  elsif v_type = 'refund' then
    -- The refunded transaction's sale, in any program of the workspace.
    select x.* into s from public.program_sales x
    join public.affiliate_programs y on y.id = x.program_id and y.workspace_id = c.workspace_id
    where x.source = c.provider and x.store_transaction_id = v_tx
    order by x.paid_at desc limit 1
    for update of x;
    if s.id is null then
      v_outcome := 'ignored_no_sale';
    else
      -- The refund in the sale's currency; the USD figure for a sale taken in USD; else all of it.
      v_refund := case
        when v_currency = s.currency and (p->>'refunded_minor')::bigint > 0 then (p->>'refunded_minor')::bigint
        when s.currency = 'USD' and (p->'usd'->>'amount_minor')::bigint > 0 then (p->'usd'->>'amount_minor')::bigint
        else s.amount_minor end;
      v_refund := least(v_refund, s.amount_minor - s.refunded_minor);
      insert into public.program_sale_events(sale_id, kind, stripe_object_id, state, amount_minor, currency, occurred_at)
        values (s.id, 'refund', 'store_' || replace(r.id::text, '-', ''), 'succeeded', v_refund, s.currency, clock_timestamp());
      update public.program_sales x set refunded_minor = x.refunded_minor + v_refund, verified_at = clock_timestamp()
        where x.id = s.id;
      perform kma_internal.program_sale_refresh_status(s.id);
      v_outcome := 'refund';
      v_sale := s.id;
    end if;

  elsif coalesce(v_amount, 0) = 0 then
    v_outcome := 'ignored_free';
  elsif v_store = 'stripe' then
    v_outcome := 'ignored_store';
  elsif g.id is null or v_at < g.first_published_at then
    v_outcome := 'unmatched_program';
  else
    select x.* into s from public.program_sales x
    where x.program_id = g.id and x.source = c.provider and x.store_transaction_id = v_tx;
    if s.id is not null then
      v_outcome := 'sale_exists';
      v_sale := s.id;
    end if;
  end if;

  if v_outcome is null then
    -- A purchase or renewal: its place in the store subscription, then its creator.
    select ch.n into v_seq from kma_internal.program_store_chain(c.project_id, c.provider, v_original) ch
    where ch.transaction_id = v_tx;
    select ch.transaction_id into v_first_tx from kma_internal.program_store_chain(c.project_id, c.provider, v_original) ch
    where ch.n = 1;
    select x.* into v_first from public.program_sales x
    where x.program_id = g.id and x.source = c.provider and x.store_transaction_id = v_first_tx;
    if v_seq > 1 and v_first.click_record_id is not null then
      select v_first.click_id as click_id, v_first.click_record_id as click_record_id,
        v_first.affiliate_id as affiliate_id, 'subscription'::text as match_source into v_click;
    else
      v_ids := array(select distinct on (lower(i.v)) i.v from (
          select p->>'app_user_id' as v, 0 as place
          union all
          select a.value #>> '{}', a.place from jsonb_array_elements(coalesce(p->'aliases', '[]'::jsonb))
            with ordinality a(value, place) where jsonb_typeof(a.value) = 'string') i
        where i.v ~ '^[[:print:]]{1,200}$' order by lower(i.v), i.place);
      -- The app user ID first.
      v_ids := array(select u.v from unnest(v_ids) with ordinality u(v, n)
        order by (u.v = p->>'app_user_id') desc, u.n limit 20);
      v_person := kma_internal.program_store_person(c.project_id, v_ids);
      if v_person is null then
        v_outcome := 'unmatched_person';
      else
        -- The window creators agreed to: the published terms.
        v_window := coalesce((select (t.terms->>'attribution_window_days')::integer
          from public.affiliate_program_terms t
          where t.program_id = g.id and t.version = g.live_terms_version
            and (t.terms->>'attribution_window_days') ~ '^[0-9]{1,3}$'), g.attribution_window_days);
        select k.click_id, k.click_record_id, k.affiliate_id, 'app_user'::text as match_source into v_click
        from kma_internal.program_store_click(g.product_id, v_person, v_at, v_window) k;
        if v_click.click_record_id is null then
          v_outcome := 'unmatched_creator';
        end if;
      end if;
    end if;
  end if;

  if v_outcome is null then
    -- The sale: the gross price, tax and the store's cut in the purchase currency, or in USD
    -- for a USD program when the tool gave USD figures.
    select t.terms into v_terms from public.affiliate_program_terms t
    where t.program_id = g.id and t.version = g.live_terms_version;
    v_program_currency := coalesce(v_terms->>'currency', g.currency);
    v_tax := (p->>'tax_minor')::bigint;
    v_fee := (p->>'store_fee_minor')::bigint;
    v_usd_amount := (p->'usd'->>'amount_minor')::bigint;
    v_usd_proceeds := (p->'usd'->>'proceeds_minor')::bigint;
    -- (least() skips nulls, so an unknown tax or fee is kept unknown by hand.)
    if v_currency <> v_program_currency and v_program_currency = 'USD' and v_usd_amount > 0 then
      -- The tax in USD in the same share of the price; the store's cut is what is left
      -- between the price, the tax and the proceeds.
      v_tax := case when v_tax is not null
        then least(round(v_tax::numeric * v_usd_amount / v_amount)::bigint, v_usd_amount) end;
      v_fee := case when v_usd_proceeds is not null
        then greatest(v_usd_amount - least(v_usd_proceeds, v_usd_amount) - coalesce(v_tax, 0), 0) end;
      v_amount := v_usd_amount;
      v_currency := 'USD';
    else
      v_tax := case when v_tax is not null then least(v_tax, v_amount) end;
      v_fee := case when v_fee is not null then least(v_fee, v_amount - coalesce(v_tax, 0)) end;
    end if;

    insert into public.program_sales(program_id, amount_minor, currency, tax_minor, store_fee_minor, paid_at,
        click_id, click_record_id, affiliate_id, match_source, source, store, store_transaction_id,
        store_original_transaction_id, store_product_id, subscription_sequence, first_sale_id)
      values (g.id, v_amount, v_currency, v_tax, v_fee, v_at,
        v_click.click_id, v_click.click_record_id, v_click.affiliate_id, v_click.match_source, c.provider, v_store, v_tx,
        v_original, p->>'product_id', coalesce(v_seq, 1), case when v_seq > 1 then v_first.id end)
      returning id into v_sale;
    perform kma_internal.program_store_resequence(g.id, c.project_id, c.provider, v_original);
    v_outcome := 'sale';
  end if;

  update public.program_store_events e set outcome = v_outcome, sale_id = v_sale where e.id = r.id;
  update public.program_store_connections x set
      events_count = x.events_count + 1,
      sales_count = x.sales_count + (v_outcome = 'sale')::int,
      ignored_count = x.ignored_count + (v_outcome like 'ignored\_%' or v_outcome like 'unmatched\_%')::int,
      last_event_at = clock_timestamp()
    where x.id = c.id;

  return jsonb_build_object('received', true, 'duplicate', false, 'outcome', v_outcome, 'sale_id', v_sale,
    'subscription_sequence', (select x.subscription_sequence from public.program_sales x where x.id = v_sale));
end $$;

-- Console (signed-in workspace member) -----------------------------------------------------------

-- The Connections page: the workspace's RevenueCat and Adapty connections and the analytics
-- projects one can be made for. Any member reads; an owner or admin manages (can_manage).
create function public.workspace_store_connections(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id);
begin
  return jsonb_build_object(
    'can_manage', v_role in ('owner', 'admin'),
    'connections', coalesce((
      select jsonb_agg(kma_internal.program_store_connection_json(c) order by c.created_at, c.provider, c.id)
      from public.program_store_connections c
      where c.workspace_id = p_workspace_id and c.status = 'active'), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name) order by pr.created_at, pr.name, pr.id)
      from public.analytics_projects pr where pr.workspace_id = p_workspace_id), '[]'::jsonb));
end $$;

-- Connects RevenueCat or Adapty to one analytics project of the workspace. Returns the
-- connection with webhook_url and header_value, shown this once.
create function public.workspace_store_connection_create(p_workspace_id uuid, p_project_id uuid, p_provider text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  c public.program_store_connections;
  v_value text;
begin
  if p_provider is null or p_provider not in ('revenuecat', 'adapty') then
    perform kma_internal.program_fail('invalid_provider', 'Choose RevenueCat or Adapty');
  end if;
  if not exists (select 1 from public.analytics_projects pr where pr.id = p_project_id and pr.workspace_id = p_workspace_id) then
    perform kma_internal.program_fail('project_not_found', 'Project not found', 'P0002');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kma-store-connection:' || p_project_id::text || ':' || p_provider, 0));
  if exists (select 1 from public.program_store_connections x
    where x.project_id = p_project_id and x.provider = p_provider and x.status = 'active') then
    perform kma_internal.program_fail('already_connected', 'This app is already connected; rotate the header value instead');
  end if;
  v_value := kma_internal.program_store_header_value();
  insert into public.program_store_connections(workspace_id, project_id, provider, header_sha256, created_by)
    values (p_workspace_id, p_project_id, p_provider, encode(extensions.digest(v_value, 'sha256'), 'hex'), auth.uid())
    returning * into c;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
    values (auth.uid(), 'system', 'program_store_connection_created', 'program_store_connections', c.id,
      jsonb_build_object('workspace_id', c.workspace_id, 'project_id', c.project_id, 'provider', c.provider, 'role', v_role));
  return kma_internal.program_store_connection_json(c) || jsonb_build_object('header_value', v_value);
end $$;

-- The active connection a manager of its workspace may change, locked. P0002 when there is none
-- or the caller is not in its workspace; 42501 for a role below admin.
create function kma_internal.program_store_managed(p_connection_id uuid) returns public.program_store_connections
language plpgsql volatile set search_path = '' as $$
declare
  c public.program_store_connections;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  select * into c from public.program_store_connections x where x.id = p_connection_id and x.status = 'active'
    for update;
  if c.id is null then
    perform kma_internal.program_fail('connection_not_found', 'Connection not found', 'P0002');
  end if;
  perform kma_internal.analytics_require_workspace(c.workspace_id, 'admin');
  return c;
end $$;

-- A new header value for a connection; the old one stops working at once. Returns the
-- connection with webhook_url and header_value, shown this once.
create function public.workspace_store_connection_rotate(p_connection_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.program_store_connections := kma_internal.program_store_managed(p_connection_id);
  v_value text := kma_internal.program_store_header_value();
begin
  update public.program_store_connections x
    set header_sha256 = encode(extensions.digest(v_value, 'sha256'), 'hex'), rotated_at = clock_timestamp()
    where x.id = c.id returning * into c;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
    values (auth.uid(), 'system', 'program_store_connection_rotated', 'program_store_connections', c.id,
      jsonb_build_object('workspace_id', c.workspace_id, 'project_id', c.project_id, 'provider', c.provider));
  return kma_internal.program_store_connection_json(c) || jsonb_build_object('header_value', v_value);
end $$;

-- Disconnects: the tool's calls are refused from now on. Sales already recorded stay.
-- Returns the Connections answer.
create function public.workspace_store_connection_remove(p_connection_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.program_store_connections := kma_internal.program_store_managed(p_connection_id);
begin
  update public.program_store_connections x set status = 'revoked', revoked_at = clock_timestamp()
    where x.id = c.id returning * into c;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
    values (auth.uid(), 'system', 'program_store_connection_removed', 'program_store_connections', c.id,
      jsonb_build_object('workspace_id', c.workspace_id, 'project_id', c.project_id, 'provider', c.provider));
  return public.workspace_store_connections(c.workspace_id);
end $$;

-- The Sales page ----------------------------------------------------------------------------------

-- The definition from 20261118100000_program_links.sql. Each sale also says where it came
-- from (source: stripe, revenuecat, adapty), its store (app_store, play_store, ...; null for
-- a Stripe sale) and the promo code text when the buyer used one of the program's codes.
create or replace function public.workspace_program_sales(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id);
  p public.affiliate_programs := kma_internal.program_of(p_workspace_id);
  v_limit integer := 50;
  v_before timestamptz;
  v_member uuid;
  v_affiliate uuid;
  v_cut timestamptz;
  v_more boolean := false;
  v_sales jsonb := '[]'::jsonb;
  v_since timestamptz := ((now() at time zone 'UTC')::date - 29)::timestamp at time zone 'UTC';
begin
  perform kma_internal.program_member_input(p_input, array['limit', 'before', 'member_id']);
  if jsonb_typeof(p_input->'limit') = 'number' and p_input->>'limit' ~ '^[0-9]{1,3}$' then
    v_limit := (p_input->>'limit')::integer;
  elsif jsonb_typeof(p_input->'limit') <> 'null' then
    v_limit := 0;
  end if;
  if v_limit not between 1 and 100 then
    perform kma_internal.program_fail('invalid_input', 'limit must be a whole number from 1 to 100');
  end if;
  if jsonb_typeof(p_input->'before') not in ('string', 'null') then
    perform kma_internal.program_fail('invalid_input', 'before must be a time');
  end if;
  begin
    v_before := (p_input->>'before')::timestamptz;
  exception when others then
    perform kma_internal.program_fail('invalid_input', 'before must be a time');
  end;
  if jsonb_typeof(p_input->'member_id') not in ('string', 'null')
    or (p_input->>'member_id' is not null and kma_internal.workspace_stripe_uuid(p_input->>'member_id') is null) then
    perform kma_internal.program_fail('invalid_input', 'member_id must be a UUID');
  end if;
  v_member := kma_internal.workspace_stripe_uuid(p_input->>'member_id');
  -- A member of another program matches nothing.
  select m.affiliate_id into v_affiliate from public.affiliate_program_members m
  where m.id = v_member and m.program_id = p.id;

  if p.id is not null then
    -- A page ends on a whole moment: sales paid in the same instant as its last one come with
    -- it, so the next page can start strictly before that instant and miss nothing.
    select min(q.paid_at) into v_cut from (
      select s.paid_at from public.program_sales s
      where s.program_id = p.id and s.affiliate_id is not null
        and (v_before is null or s.paid_at < v_before) and (v_member is null or s.affiliate_id = v_affiliate)
      order by s.paid_at desc, s.id desc limit v_limit) q;
    v_more := exists (select 1 from public.program_sales s
      where s.program_id = p.id and s.affiliate_id is not null and s.paid_at < v_cut
        and (v_member is null or s.affiliate_id = v_affiliate));
    select coalesce(jsonb_agg(jsonb_build_object(
        'sale_id', s.id, 'paid_at', s.paid_at, 'amount_minor', s.amount_minor, 'currency', s.currency,
        'refunded_minor', s.refunded_minor,
        'member_id', (select m.id from public.affiliate_program_members m
          where m.program_id = s.program_id and m.affiliate_id = s.affiliate_id),
        'creator_name', a.public_name, 'link_name', coalesce(b.name, 'No link'), 'match_source', s.match_source,
        'status', case x.status when 'held' then 'pending' when 'approved' then 'approved'
          when 'reversed' then 'returned' when 'not_earned' then 'not_earned' else 'not_judged' end,
        'reason', x.reason, 'commission_minor', coalesce(x.amount_minor, 0), 'fee_minor', coalesce(x.fee_minor, 0),
        'hold_until', x.hold_until,
        'source', s.source, 'store', s.store,
        'promotion_code', case when s.promotion_code_id is not null then (
          select pc.code from public.program_promo_codes pc
          where pc.program_id = s.program_id and pc.account_id = s.account_id
            and pc.stripe_promotion_code_id = s.promotion_code_id
          order by pc.created_at desc limit 1) end)
      order by s.paid_at desc, s.id desc), '[]'::jsonb) into v_sales
    from public.program_sales s
    join public.affiliates a on a.id = s.affiliate_id
    left join public.program_commissions x on x.sale_id = s.id
    left join public.clicks k on k.id = s.click_record_id
    left join public.affiliate_links l on l.id = k.affiliate_link_id
    left join lateral kma_internal.program_link_label(p.funnel_id, l) b on l.id is not null
    where s.program_id = p.id and s.affiliate_id is not null and s.paid_at >= v_cut
      and (v_before is null or s.paid_at < v_before) and (v_member is null or s.affiliate_id = v_affiliate);
  end if;

  return jsonb_build_object(
    'program', case when p.id is not null then
      jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'status', p.status) end,
    'currency', case when p.id is not null then kma_internal.program_link_currency(p) end,
    'summary', (
      select jsonb_build_object('days', 30, 'sales', count(*),
        'sales_amount_minor', coalesce(sum(s.amount_minor), 0)::bigint,
        'commission_minor', coalesce(sum(x.amount_minor), 0)::bigint,
        'fee_minor', coalesce(sum(x.fee_minor), 0)::bigint)
      from public.program_sales s
      join public.program_commissions x on x.sale_id = s.id and x.status in ('held', 'approved')
      where s.program_id = p.id and s.affiliate_id is not null and s.paid_at >= v_since),
    'sales', v_sales,
    'next_before', case when v_more then v_cut end);
end $$;

-- Operator view ---------------------------------------------------------------------------------

-- The definition from 20261114110000_program_sales.sql, with the store side: active
-- connections, the outcomes of the last day, unmatched purchases of the last 30 days, and
-- sales by source. fee_unknown counts Stripe sales only (a store sale has no Stripe fee).
create or replace function public.program_sales_health() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schedule', (select to_jsonb(s) - 'last_request_id' - 'singleton' from kma_internal.program_sales_schedule s),
    'queue', (select jsonb_build_object(
        'due', count(*) filter (where e.next_attempt_at <= now() and (e.lease_until is null or e.lease_until < now())),
        'waiting', count(*) filter (where e.next_attempt_at > now() and e.lease_until is null),
        'leased', count(*) filter (where e.lease_until >= now()),
        'oldest_unprocessed_at', min(e.received_at))
      from public.merchant_payment_events e where e.processed_at is null),
    'retrying', (select coalesce(jsonb_object_agg(r.process_error, r.n), '{}'::jsonb)
      from (select e.process_error, count(*) as n from public.merchant_payment_events e
        where e.processed_at is null and e.process_error is not null group by e.process_error) r),
    'failed', (select coalesce(jsonb_object_agg(r.code, r.n), '{}'::jsonb)
      from (select coalesce(e.process_error, 'unknown') as code, count(*) as n from public.merchant_payment_events e
        where e.process_outcome = 'failed' group by 1) r),
    'outcomes_last_day', (select coalesce(jsonb_object_agg(r.process_outcome, r.n), '{}'::jsonb)
      from (select e.process_outcome, count(*) as n from public.merchant_payment_events e
        where e.processed_at > now() - interval '1 day' group by e.process_outcome) r),
    'sales', (select jsonb_build_object('total', count(*), 'matched', count(*) filter (where s.click_record_id is not null),
        'fee_unknown', count(*) filter (where s.fee_minor is null and s.source = 'stripe'), 'last_sale_at', max(s.paid_at),
        'by_source', jsonb_build_object(
          'stripe', count(*) filter (where s.source = 'stripe'),
          'revenuecat', count(*) filter (where s.source = 'revenuecat'),
          'adapty', count(*) filter (where s.source = 'adapty')))
      from public.program_sales s),
    'store', jsonb_build_object(
      'connections', (select count(*) from public.program_store_connections c where c.status = 'active'),
      'last_event_at', (select max(c.last_event_at) from public.program_store_connections c),
      'outcomes_last_day', (select coalesce(jsonb_object_agg(r.outcome, r.n), '{}'::jsonb)
        from (select e.outcome, count(*) as n from public.program_store_events e
          where e.received_at > now() - interval '1 day' group by e.outcome) r),
      'unmatched_30d', (select count(*) from public.program_store_events e
        where e.received_at > now() - interval '30 days' and e.outcome like 'unmatched\_%')))
$$;

-- Access ----------------------------------------------------------------------------------------
revoke all on function
    kma_internal.program_sale_basis(public.program_sales),
    kma_internal.program_store_webhook_url(text), kma_internal.program_store_header_value(),
    kma_internal.program_store_connection_json(public.program_store_connections),
    kma_internal.program_store_chain(uuid, text, text),
    kma_internal.program_store_resequence(uuid, uuid, text, text),
    kma_internal.program_store_person(uuid, text[]),
    kma_internal.program_store_click(uuid, uuid, timestamptz, integer),
    kma_internal.program_store_text_ok(jsonb, text),
    kma_internal.program_store_managed(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
    public.record_program_store_event(jsonb), public.workspace_store_connections(uuid),
    public.workspace_store_connection_create(uuid, uuid, text), public.workspace_store_connection_rotate(uuid),
    public.workspace_store_connection_remove(uuid), public.workspace_program_sales(uuid, jsonb),
    public.program_sales_health()
  from public, anon, authenticated, service_role;
grant execute on function public.record_program_store_event(jsonb), public.program_sales_health() to service_role;
grant execute on function
    public.workspace_store_connections(uuid), public.workspace_store_connection_create(uuid, uuid, text),
    public.workspace_store_connection_rotate(uuid), public.workspace_store_connection_remove(uuid),
    public.workspace_program_sales(uuid, jsonb)
  to authenticated;

commit;
