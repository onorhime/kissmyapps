-- Affiliate self-serve, Phase 2: sale tracking.
-- The receipts written by connect-payments-webhook are the queue. The program-sales-worker
-- Edge Function claims them, reads the payment back from the merchant's Stripe account and
-- calls the functions below. Every successful payment on a connected account whose
-- workspace has an approved program becomes exactly one row in program_sales, keyed by its
-- PaymentIntent, and is tied to a creator click when it can be. Refunds and disputes update
-- that row. Live only. No names, emails, card data or Stripe payloads are stored: the
-- buyer's email is an input of one call, used for a lookup and then dropped.
-- Nothing here creates a commission, a ledger entry or a payout.
begin;

-- The queue --------------------------------------------------------------------------------
-- A receipt is waiting until processed_at is set. process_outcome is a short stable code
-- ('recorded', 'no_program', 'failed', ...); process_error is the code of the last retry.
alter table public.merchant_payment_events
  add column processed_at timestamptz,
  add column process_outcome text check (process_outcome ~ '^[a-z][a-z0-9_]{1,59}$'),
  add column process_attempts integer not null default 0 check (process_attempts >= 0),
  add column process_error text check (process_error ~ '^[a-z][a-z0-9_]{1,59}$'),
  add column next_attempt_at timestamptz not null default now(),
  add column lease_until timestamptz,
  add column lease_token uuid,
  add constraint merchant_payment_event_processing_shape check (
    (processed_at is null) = (process_outcome is null)
    and (lease_until is null) = (lease_token is null)
    and (processed_at is null or lease_until is null));
create index merchant_payment_events_queue
  on public.merchant_payment_events(platform_account_id, next_attempt_at, event_created)
  where processed_at is null;
-- A refund that arrives before its payment was processed waits for that payment's receipt.
create index merchant_payment_events_unprocessed_intent
  on public.merchant_payment_events(account_id, payment_intent_id)
  where processed_at is null and payment_intent_id is not null;

-- Sales ------------------------------------------------------------------------------------
create table public.program_sales (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.affiliate_programs(id),
  connection_id uuid not null references public.merchant_connections(id),
  account_id text not null check (account_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode boolean not null default true check (livemode),
  -- The one key of a sale. A Checkout Session or an invoice resolves to its PaymentIntent.
  payment_intent_id text not null check (payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,252}$'),
  charge_id text check (charge_id ~ '^[a-z]{2,4}_[A-Za-z0-9_]{1,250}$'),
  checkout_session_id text check (checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,252}$'),
  invoice_id text check (invoice_id ~ '^in_[A-Za-z0-9_]{1,252}$'),
  subscription_id text check (subscription_id ~ '^sub_[A-Za-z0-9_]{1,251}$'),
  customer_id text check (customer_id ~ '^cus_[A-Za-z0-9_]{1,251}$'),
  -- Stripe's invoice.billing_reason ('subscription_create', 'subscription_cycle', ...);
  -- null when the payment has no invoice. It tells a first payment from a renewal even
  -- when the first payment was made before the program existed.
  billing_reason text check (billing_reason ~ '^[a-z_]{1,60}$'),
  -- What Stripe reports for the PaymentIntent: the amount received and its currency.
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  tax_minor bigint check (tax_minor >= 0),
  -- Stripe's fee from the charge's balance transaction; null until Stripe has settled it.
  -- The fee is in the account's settlement currency, which can differ from the sale's.
  fee_minor bigint check (fee_minor >= 0),
  fee_currency text check (fee_currency ~ '^[A-Z]{3}$'),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  status text not null default 'paid' check (status in ('paid', 'partially_refunded', 'refunded', 'disputed')),
  paid_at timestamptz not null,
  -- The creator click: kma_click as tagged on the payment, inherited from the first sale of
  -- the subscription, or found through the buyer's identified profile.
  click_id text check (click_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  -- Set only when that click exists, is not a bot and belongs to the program's product.
  click_record_id uuid references public.clicks(id),
  affiliate_id uuid references public.affiliates(id),
  match_source text not null default 'none'
    check (match_source in ('metadata', 'client_reference_id', 'subscription', 'email', 'none')),
  -- 1 for the first payment recorded for a subscription, 2, 3... for the ones after it.
  subscription_sequence integer check (subscription_sequence > 0),
  first_sale_id uuid references public.program_sales(id),
  -- When Stripe was last read for this sale.
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint program_sale_one_per_payment unique (account_id, payment_intent_id),
  constraint program_sale_fee_has_currency check ((fee_minor is null) = (fee_currency is null)),
  constraint program_sale_match_shape check (
    (match_source = 'none') = (click_id is null)
    and (click_record_id is null) = (affiliate_id is null)
    and (click_record_id is null or click_id is not null)),
  constraint program_sale_subscription_shape check (
    (subscription_id is null) = (subscription_sequence is null)
    and (first_sale_id is null or (subscription_sequence > 1 and first_sale_id <> id)))
);
create index program_sales_program on public.program_sales(program_id, paid_at desc);
create index program_sales_subscription on public.program_sales(account_id, subscription_id, paid_at)
  where subscription_id is not null;
create index program_sales_affiliate on public.program_sales(affiliate_id, paid_at desc)
  where affiliate_id is not null;

-- Refunds and disputes of a sale, one row per Stripe refund or dispute and state. Rows never
-- change: a dispute that is opened and later won has an 'open' row and a 'won' row.
create table public.program_sale_events (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.program_sales(id),
  kind text not null check (kind in ('refund', 'dispute')),
  stripe_object_id text not null check (stripe_object_id ~ '^[A-Za-z0-9_]{3,255}$'),
  state text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- When Stripe created the refund or dispute.
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint program_sale_event_once unique (sale_id, stripe_object_id, state),
  constraint program_sale_event_state check (
    (kind = 'refund' and state in ('succeeded', 'failed', 'canceled'))
    or (kind = 'dispute' and state in ('open', 'won', 'lost')))
);
create trigger program_sale_events_are_append_only before update or delete on public.program_sale_events
  for each row execute function public.reject_mutation();

alter table public.program_sales enable row level security;
alter table public.program_sale_events enable row level security;
revoke all on public.program_sales, public.program_sale_events from public, anon, authenticated, service_role;

-- Email matching looks a buyer up by the email trait of an identified profile.
create index analytics_people_email
  on public.analytics_people(project_id, lower(traits->>'email'))
  where (traits->>'email') is not null;

-- Helpers ----------------------------------------------------------------------------------

-- The approved program that owns payments of a connected account, through the workspace's
-- active live connection. No row when there is none.
create function kma_internal.program_sale_program(p_connection uuid, p_account text)
returns public.affiliate_programs language sql stable set search_path = '' as $$
  select p.* from public.merchant_connections c
    join public.merchant_businesses b on b.id = c.merchant_id
    join public.affiliate_programs p on p.workspace_id = b.workspace_id and p.status in ('live', 'paused')
    where c.id = p_connection and c.livemode and c.status = 'active' and c.account_id = p_account
$$;

-- The creator tag as a click id: the kma_ prefix of a client_reference_id is removed, and
-- anything that is not a click id is dropped.
create function kma_internal.program_sale_clean_tag(p_tag text, p_source text)
returns text language sql immutable set search_path = '' as $$
  select case when t ~ '^[A-Za-z0-9_-]{16,128}$' then t end
  from (select case when p_source = 'client_reference_id' and left(p_tag, 4) = 'kma_'
    then substr(p_tag, 5) else p_tag end as t) cleaned
  where p_source in ('metadata', 'client_reference_id')
$$;

-- The click a click id stands for: a real, non-bot, live click on the program's product.
create function kma_internal.program_sale_click(p_product uuid, p_click text,
  out click_record_id uuid, out affiliate_id uuid)
language sql stable set search_path = '' as $$
  select c.id, c.affiliate_id from public.clicks c
    join public.affiliate_links l on l.id = c.affiliate_link_id
    where c.public_click_id = p_click and c.product_id = p_product and not c.is_bot
      and coalesce(l.tracking_environment, 'live') = 'live'
$$;

-- Email matching: the most recent visit with a creator click, made within the attribution
-- window before the payment by an identified profile of the workspace with this email.
-- p_email is already lower case. It is compared and never written anywhere.
create function kma_internal.program_sale_email_click(p_workspace uuid, p_product uuid, p_email text,
  p_paid_at timestamptz, p_window_days integer,
  out click_id text, out click_record_id uuid, out affiliate_id uuid)
language sql stable set search_path = '' as $$
  select s.creator_click, c.id, c.affiliate_id
    from public.analytics_projects pr
    join public.analytics_people pe on pe.project_id = pr.id
      and (pe.traits->>'email') is not null and lower(pe.traits->>'email') = p_email
    join public.analytics_sessions s on s.person_id = pe.id and s.creator_click is not null
      and s.started_at <= p_paid_at and s.started_at >= p_paid_at - make_interval(days => p_window_days)
    join public.clicks c on c.public_click_id = s.creator_click and c.product_id = p_product and not c.is_bot
    join public.affiliate_links l on l.id = c.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
    where pr.workspace_id = p_workspace
    order by s.started_at desc, s.id
    limit 1
$$;

-- paid, partially_refunded or refunded by the refunded amount; disputed while a dispute is
-- open or was lost.
create function kma_internal.program_sale_refresh_status(p_sale uuid)
returns text language sql set search_path = '' as $$
  update public.program_sales s set status = case
      when exists (select 1 from public.program_sale_events d
        where d.sale_id = s.id and d.kind = 'dispute' and not exists (
          select 1 from public.program_sale_events w
          where w.sale_id = s.id and w.kind = 'dispute' and w.stripe_object_id = d.stripe_object_id and w.state = 'won'))
        then 'disputed'
      when s.refunded_minor >= s.amount_minor then 'refunded'
      when s.refunded_minor > 0 then 'partially_refunded'
      else 'paid' end
    where s.id = p_sale
    returning s.status
$$;

-- Numbers the sales of one subscription by payment time and gives each renewal the click
-- and creator of the first sale, unless the renewal carries a creator tag of its own.
create function kma_internal.program_sale_resequence(p_account text, p_subscription text)
returns void language plpgsql set search_path = '' as $$
declare
  v_first public.program_sales;
begin
  update public.program_sales s
    set subscription_sequence = r.n, first_sale_id = case when r.n = 1 then null else r.first_id end
    from (select id, row_number() over w as n, first_value(id) over w as first_id
      from public.program_sales where account_id = p_account and subscription_id = p_subscription
      window w as (order by paid_at, created_at, id)) r
    where s.id = r.id and (s.subscription_sequence is distinct from r.n
      or s.first_sale_id is distinct from case when r.n = 1 then null else r.first_id end);

  select * into v_first from public.program_sales
    where account_id = p_account and subscription_id = p_subscription and subscription_sequence = 1;
  if v_first.click_record_id is not null then
    update public.program_sales s
      set click_id = v_first.click_id, click_record_id = v_first.click_record_id,
        affiliate_id = v_first.affiliate_id, match_source = 'subscription'
      where s.account_id = p_account and s.subscription_id = p_subscription and s.subscription_sequence > 1
        and (s.click_record_id is null or s.match_source = 'subscription')
        and (s.click_record_id is distinct from v_first.click_record_id or s.match_source <> 'subscription');
  else
    update public.program_sales s
      set click_id = null, click_record_id = null, affiliate_id = null, match_source = 'none'
      where s.account_id = p_account and s.subscription_id = p_subscription and s.subscription_sequence > 1
        and s.match_source = 'subscription';
  end if;
end $$;

-- The receipt a worker call is about. The caller must hold its lease: the token handed out
-- by the claim. Raises 22023 for a malformed call and 55000 when the lease is not held.
create function kma_internal.program_sale_leased_receipt(p_input jsonb)
returns public.merchant_payment_events language plpgsql set search_path = '' as $$
declare
  v public.merchant_payment_events;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or coalesce(p_input->>'platform_account_id', '') !~ '^acct_[A-Za-z0-9]+$'
    or coalesce(p_input->>'event_id', '') !~ '^evt_[A-Za-z0-9_]+$'
    or coalesce(p_input->>'lease_token', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    raise exception 'Invalid receipt reference' using errcode = '22023';
  end if;
  select * into v from public.merchant_payment_events e
    where e.platform_account_id = p_input->>'platform_account_id' and e.livemode and e.event_id = p_input->>'event_id'
    for update;
  if not found or v.processed_at is not null or v.lease_token is distinct from (p_input->>'lease_token')::uuid then
    raise exception 'Receipt lease changed or expired' using errcode = '55000';
  end if;
  return v;
end $$;

-- True when the key is absent, JSON null, or a whole number of at most 15 digits.
create function kma_internal.program_sale_amount_ok(p_input jsonb, p_key text, p_required boolean)
returns boolean language sql immutable set search_path = '' as $$
  select case coalesce(jsonb_typeof(p_input->p_key), 'null')
    when 'null' then not p_required
    when 'number' then (p_input->>p_key) ~ '^[0-9]{1,15}$'
    else false end
$$;

-- Worker functions (service role) --------------------------------------------------------

-- Hands the worker a batch of receipts to work on, each with a lease. Before that, receipts
-- that cannot become a sale are finished here without a Stripe call: the account is no
-- longer connected, its workspace has no approved program, or the event is older than the
-- program. Input: {platform_account_id, limit 1..25, lease_seconds 30..600}.
create function public.claim_program_sale_receipts(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_platform text := p_input->>'platform_account_id';
  v_limit integer;
  v_lease integer;
  v_now timestamptz := clock_timestamp();
  v_skipped integer;
  v_failed integer;
  v_receipts jsonb;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or coalesce(v_platform, '') !~ '^acct_[A-Za-z0-9]+$'
    or (p_input ? 'limit' and (jsonb_typeof(p_input->'limit') <> 'number' or (p_input->>'limit') !~ '^[0-9]{1,2}$'))
    or (p_input ? 'lease_seconds' and (jsonb_typeof(p_input->'lease_seconds') <> 'number' or (p_input->>'lease_seconds') !~ '^[0-9]{1,3}$'))
  then
    raise exception 'Invalid claim' using errcode = '22023';
  end if;
  v_limit := coalesce((p_input->>'limit')::integer, 10);
  v_lease := coalesce((p_input->>'lease_seconds')::integer, 120);
  if v_limit not between 1 and 25 or v_lease not between 30 and 600 then
    raise exception 'Invalid claim' using errcode = '22023';
  end if;

  -- A worker that took the last attempt and never reported back.
  update public.merchant_payment_events e
    set processed_at = v_now, process_outcome = 'failed',
      process_error = coalesce(e.process_error, 'lease_expired'), lease_until = null, lease_token = null
    where e.platform_account_id = v_platform and e.processed_at is null
      and e.process_attempts >= 8 and e.lease_until < v_now;
  get diagnostics v_failed = row_count;

  with due as (
    select e.platform_account_id, e.livemode, e.event_id,
      case
        when c.id is null then 'connection_inactive'
        when p.id is null then 'no_program'
        when e.event_created < p.first_published_at then 'before_program'
      end as outcome
    from public.merchant_payment_events e
    left join public.merchant_connections c on c.id = e.connection_id and c.livemode and c.status = 'active'
      and c.account_id = e.account_id
    left join public.merchant_businesses b on b.id = c.merchant_id
    left join public.affiliate_programs p on p.workspace_id = b.workspace_id and p.status in ('live', 'paused')
    where e.platform_account_id = v_platform and e.processed_at is null and e.next_attempt_at <= v_now
      and (e.lease_until is null or e.lease_until < v_now)
    order by e.next_attempt_at, e.event_created
    limit 500
    for update of e skip locked
  )
  update public.merchant_payment_events e
    set processed_at = v_now, process_outcome = due.outcome, lease_until = null, lease_token = null
    from due
    where due.outcome is not null and e.platform_account_id = due.platform_account_id
      and e.livemode = due.livemode and e.event_id = due.event_id;
  get diagnostics v_skipped = row_count;

  with picked as (
    select e.platform_account_id, e.livemode, e.event_id
    from public.merchant_payment_events e
    join public.merchant_connections c on c.id = e.connection_id and c.livemode and c.status = 'active'
      and c.account_id = e.account_id
    join public.merchant_businesses b on b.id = c.merchant_id
    join public.affiliate_programs p on p.workspace_id = b.workspace_id and p.status in ('live', 'paused')
      and e.event_created >= p.first_published_at
    where e.platform_account_id = v_platform and e.processed_at is null and e.next_attempt_at <= v_now
      and (e.lease_until is null or e.lease_until < v_now) and e.process_attempts < 8
    order by e.next_attempt_at, e.event_created, e.event_id
    limit v_limit
    for update of e skip locked
  ), leased as (
    update public.merchant_payment_events e
      set lease_until = v_now + make_interval(secs => v_lease), lease_token = gen_random_uuid(),
        process_attempts = e.process_attempts + 1
      from picked
      where e.platform_account_id = picked.platform_account_id and e.livemode = picked.livemode
        and e.event_id = picked.event_id
      returning e.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'event_id', l.event_id, 'event_type', l.event_type, 'account_id', l.account_id,
      'object_id', l.object_id, 'payment_intent_id', l.payment_intent_id,
      'amount_minor', l.amount_minor, 'currency', l.currency,
      'event_created', extract(epoch from l.event_created)::bigint,
      'attempts', l.process_attempts, 'lease_token', l.lease_token)
      order by l.event_created, l.event_id), '[]'::jsonb)
    into v_receipts from leased l;

  return jsonb_build_object('receipts', v_receipts, 'skipped', v_skipped, 'failed', v_failed);
end $$;

-- Records the sale a payment receipt stands for, or adds to the sale that another receipt
-- of the same payment already made. Everything in the input was read from Stripe by the
-- worker. Calling it again, or for the Checkout Session, the invoice and the PaymentIntent
-- of one payment in any order, ends in the same single row.
-- Input: the receipt reference (platform_account_id, event_id, lease_token) and
-- payment_intent_id, charge_id, checkout_session_id, invoice_id, subscription_id,
-- customer_id, billing_reason, amount_minor, currency, tax_minor, fee_minor, fee_currency,
-- refunded_minor, paid_at (epoch seconds), kma_click, tag_source, buyer_email.
create function public.record_program_sale(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_receipt public.merchant_payment_events;
  v_program public.affiliate_programs;
  v_sale public.program_sales;
  v_intent text := p_input->>'payment_intent_id';
  v_charge text := p_input->>'charge_id';
  v_session text := p_input->>'checkout_session_id';
  v_invoice text := p_input->>'invoice_id';
  v_subscription text := p_input->>'subscription_id';
  v_customer text := p_input->>'customer_id';
  v_reason text := p_input->>'billing_reason';
  v_currency text := upper(p_input->>'currency');
  v_fee_currency text := upper(p_input->>'fee_currency');
  v_email text := lower(btrim(p_input->>'buyer_email'));
  v_amount bigint;
  v_tax bigint;
  v_fee bigint;
  v_refunded bigint;
  v_paid_at timestamptz;
  v_tag text;
  v_tag_source text;
  v_window integer;
  v_created boolean;
  v_email_allowed boolean;
  v_id uuid;
  v_click record;
begin
  v_receipt := kma_internal.program_sale_leased_receipt(p_input);
  -- One sale at a time per merchant account: recording a sale can renumber and re-match
  -- the other sales of its subscription.
  perform pg_advisory_xact_lock(hashtextextended('kma-program-sale:' || v_receipt.account_id, 0));
  if v_receipt.event_type not in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
      'payment_intent.succeeded', 'invoice.paid')
    or p_input->'livemode' is distinct from 'true'::jsonb
    or coalesce(v_intent, '') !~ '^pi_[A-Za-z0-9_]{1,252}$'
    or (v_receipt.payment_intent_id is not null and v_receipt.payment_intent_id <> v_intent)
    or coalesce(v_charge, '') !~ '^[a-z]{2,4}_[A-Za-z0-9_]{1,250}$'
    or (v_session is not null and v_session !~ '^cs_[A-Za-z0-9_]{1,252}$')
    or (v_invoice is not null and v_invoice !~ '^in_[A-Za-z0-9_]{1,252}$')
    or (v_subscription is not null and v_subscription !~ '^sub_[A-Za-z0-9_]{1,251}$')
    or (v_customer is not null and v_customer !~ '^cus_[A-Za-z0-9_]{1,251}$')
    or (v_reason is not null and v_reason !~ '^[a-z_]{1,60}$')
    or coalesce(v_currency, '') !~ '^[A-Z]{3}$'
    or not kma_internal.program_sale_amount_ok(p_input, 'amount_minor', true)
    or not kma_internal.program_sale_amount_ok(p_input, 'tax_minor', false)
    or not kma_internal.program_sale_amount_ok(p_input, 'fee_minor', false)
    or not kma_internal.program_sale_amount_ok(p_input, 'refunded_minor', false)
    or not kma_internal.program_sale_amount_ok(p_input, 'paid_at', true)
    or ((p_input->>'fee_minor') is null) <> (v_fee_currency is null)
    or (v_fee_currency is not null and v_fee_currency !~ '^[A-Z]{3}$')
    or (p_input ? 'kma_click' and jsonb_typeof(p_input->'kma_click') not in ('string', 'null'))
    or ((p_input->>'kma_click') is not null and coalesce(p_input->>'tag_source', '') not in ('metadata', 'client_reference_id'))
    or (p_input ? 'buyer_email' and jsonb_typeof(p_input->'buyer_email') not in ('string', 'null'))
  then
    raise exception 'Invalid program sale' using errcode = '22023';
  end if;
  v_amount := (p_input->>'amount_minor')::bigint;
  v_tax := (p_input->>'tax_minor')::bigint;
  v_fee := (p_input->>'fee_minor')::bigint;
  v_refunded := (p_input->>'refunded_minor')::bigint;
  v_paid_at := to_timestamp((p_input->>'paid_at')::bigint);
  if v_amount <= 0 or (p_input->>'paid_at')::bigint <= 0 or v_paid_at > clock_timestamp() + interval '10 minutes' then
    raise exception 'Invalid program sale' using errcode = '22023';
  end if;
  -- Anything that is not an email address is ignored, not refused.
  if v_email is null or length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    v_email := null;
  end if;
  -- The tag the worker read from Stripe, else the one the signed event carried.
  v_tag := kma_internal.program_sale_clean_tag(p_input->>'kma_click', p_input->>'tag_source');
  v_tag_source := p_input->>'tag_source';
  if v_tag is null then
    v_tag := kma_internal.program_sale_clean_tag(v_receipt.kma_click, v_receipt.tag_source);
    v_tag_source := v_receipt.tag_source;
  end if;

  select * into v_program from kma_internal.program_sale_program(v_receipt.connection_id, v_receipt.account_id);
  if v_program.id is null then
    return jsonb_build_object('recorded', false, 'reason', 'no_program');
  end if;
  -- The window creators agreed to: the published terms, not an unpublished edit.
  v_window := coalesce((select (t.terms->>'attribution_window_days')::integer
    from public.affiliate_program_terms t
    where t.program_id = v_program.id and t.version = v_program.live_terms_version
      and (t.terms->>'attribution_window_days') ~ '^[0-9]{1,3}$'), v_program.attribution_window_days);

  insert into public.program_sales(program_id, connection_id, account_id, payment_intent_id, charge_id,
      amount_minor, currency, paid_at)
    values (v_program.id, v_receipt.connection_id, v_receipt.account_id, v_intent, v_charge,
      v_amount, v_currency, v_paid_at)
    on conflict (account_id, payment_intent_id) do nothing
    returning id into v_id;
  v_created := v_id is not null;
  select * into v_sale from public.program_sales s
    where s.account_id = v_receipt.account_id and s.payment_intent_id = v_intent
    for update;
  -- Stripe never changes what a succeeded payment received.
  if v_sale.amount_minor <> v_amount or v_sale.currency <> v_currency then
    return jsonb_build_object('recorded', false, 'reason', 'sale_conflict');
  end if;

  update public.program_sales s set
      charge_id = coalesce(v_charge, s.charge_id),
      checkout_session_id = coalesce(s.checkout_session_id, v_session),
      invoice_id = coalesce(s.invoice_id, v_invoice),
      subscription_id = coalesce(s.subscription_id, v_subscription),
      subscription_sequence = case when coalesce(s.subscription_id, v_subscription) is null then null
        else coalesce(s.subscription_sequence, 1) end,
      customer_id = coalesce(s.customer_id, v_customer),
      billing_reason = coalesce(s.billing_reason, v_reason),
      tax_minor = coalesce(v_tax, s.tax_minor),
      fee_minor = coalesce(v_fee, s.fee_minor),
      fee_currency = case when v_fee is null then s.fee_currency else v_fee_currency end,
      refunded_minor = coalesce(v_refunded, s.refunded_minor),
      verified_at = clock_timestamp()
    where s.id = v_sale.id
    returning * into v_sale;

  -- Matching, in order: the creator tag, the first sale of the subscription, the buyer's
  -- identified profile. A renewal is never matched by email: its buyer subscribed before.
  v_email_allowed := v_sale.billing_reason is null or v_sale.billing_reason in ('subscription_create', 'manual');
  if v_sale.match_source = 'email' and not v_email_allowed then
    update public.program_sales s
      set click_id = null, click_record_id = null, affiliate_id = null, match_source = 'none'
      where s.id = v_sale.id returning * into v_sale;
  end if;
  if v_tag is not null
    and not (v_sale.match_source in ('metadata', 'client_reference_id') and v_sale.click_record_id is not null) then
    select * into v_click from kma_internal.program_sale_click(v_program.product_id, v_tag);
    if v_click.click_record_id is not null then
      update public.program_sales s
        set click_id = v_tag, click_record_id = v_click.click_record_id, affiliate_id = v_click.affiliate_id,
          match_source = v_tag_source
        where s.id = v_sale.id returning * into v_sale;
    elsif v_sale.match_source = 'none' then
      -- A tag that names no click of this product is kept, unmatched, so it can be explained.
      update public.program_sales s set click_id = v_tag, match_source = v_tag_source
        where s.id = v_sale.id returning * into v_sale;
    end if;
  end if;
  if v_sale.subscription_id is not null then
    perform kma_internal.program_sale_resequence(v_sale.account_id, v_sale.subscription_id);
    select * into v_sale from public.program_sales s where s.id = v_sale.id;
  end if;
  if v_sale.click_record_id is null and v_email is not null and v_email_allowed
    and coalesce(v_sale.subscription_sequence, 1) = 1 then
    select * into v_click from kma_internal.program_sale_email_click(
      v_program.workspace_id, v_program.product_id, v_email, v_sale.paid_at, v_window);
    if v_click.click_record_id is not null then
      update public.program_sales s
        set click_id = v_click.click_id, click_record_id = v_click.click_record_id,
          affiliate_id = v_click.affiliate_id, match_source = 'email'
        where s.id = v_sale.id returning * into v_sale;
      if v_sale.subscription_id is not null then
        perform kma_internal.program_sale_resequence(v_sale.account_id, v_sale.subscription_id);
      end if;
    end if;
  end if;

  return jsonb_build_object('recorded', true, 'created', v_created, 'sale_id', v_sale.id,
    'status', kma_internal.program_sale_refresh_status(v_sale.id),
    'match_source', v_sale.match_source, 'matched', v_sale.click_record_id is not null,
    'fee_known', v_sale.fee_minor is not null);
end $$;

-- Records what a refund or dispute receipt says about a sale: the charge's refunded total
-- as Stripe reports it now, and one row per refund or dispute and state. Calling it again
-- changes nothing. When the sale does not exist the answer says whether its payment is
-- still waiting to be processed ('sale_pending') or was never a sale ('no_sale').
-- Input: the receipt reference and payment_intent_id, refunded_minor (optional), events:
-- [{kind, stripe_object_id, state, amount_minor, currency, occurred_at (epoch seconds)}].
create function public.record_program_sale_event(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_receipt public.merchant_payment_events;
  v_sale public.program_sales;
  v_intent text := p_input->>'payment_intent_id';
  v_events jsonb := coalesce(p_input->'events', '[]'::jsonb);
  v_kind text;
  v_event jsonb;
  v_new integer := 0;
  v_count integer;
begin
  v_receipt := kma_internal.program_sale_leased_receipt(p_input);
  v_kind := case
    when v_receipt.event_type in ('charge.refunded', 'refund.created', 'refund.updated') then 'refund'
    when v_receipt.event_type in ('charge.dispute.created', 'charge.dispute.closed') then 'dispute' end;
  if v_kind is null
    or coalesce(v_intent, '') !~ '^pi_[A-Za-z0-9_]{1,252}$'
    or (v_receipt.payment_intent_id is not null and v_receipt.payment_intent_id <> v_intent)
    or not kma_internal.program_sale_amount_ok(p_input, 'refunded_minor', false)
    or (v_kind = 'dispute' and (p_input->>'refunded_minor') is not null)
    or jsonb_typeof(v_events) <> 'array' or jsonb_array_length(v_events) > 20
    or exists (select 1 from jsonb_array_elements(v_events) e where
      jsonb_typeof(e) <> 'object'
      or e->>'kind' is distinct from v_kind
      or coalesce(e->>'stripe_object_id', '') !~ '^[A-Za-z0-9_]{3,255}$'
      or (v_kind = 'refund' and coalesce(e->>'state', '') not in ('succeeded', 'failed', 'canceled'))
      or (v_kind = 'dispute' and coalesce(e->>'state', '') not in ('open', 'won', 'lost'))
      or not kma_internal.program_sale_amount_ok(e, 'amount_minor', true)
      or coalesce(e->>'currency', '') !~ '^[A-Za-z]{3}$'
      or not kma_internal.program_sale_amount_ok(e, 'occurred_at', true)
      or (e->>'occurred_at')::bigint <= 0)
  then
    raise exception 'Invalid program sale event' using errcode = '22023';
  end if;

  select * into v_sale from public.program_sales s
    where s.account_id = v_receipt.account_id and s.payment_intent_id = v_intent
    for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', case when exists (
        select 1 from public.merchant_payment_events e
        where e.account_id = v_receipt.account_id and e.payment_intent_id = v_intent and e.processed_at is null
          and e.platform_account_id = v_receipt.platform_account_id
          and e.event_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
            'payment_intent.succeeded', 'invoice.paid'))
      then 'sale_pending' else 'no_sale' end);
  end if;

  for v_event in select * from jsonb_array_elements(v_events) loop
    insert into public.program_sale_events(sale_id, kind, stripe_object_id, state, amount_minor, currency, occurred_at)
      values (v_sale.id, v_kind, v_event->>'stripe_object_id', v_event->>'state',
        (v_event->>'amount_minor')::bigint, upper(v_event->>'currency'),
        to_timestamp((v_event->>'occurred_at')::bigint))
      on conflict (sale_id, stripe_object_id, state) do nothing;
    get diagnostics v_count = row_count;
    v_new := v_new + v_count;
  end loop;
  if (p_input->>'refunded_minor') is not null then
    update public.program_sales s
      set refunded_minor = (p_input->>'refunded_minor')::bigint, verified_at = clock_timestamp()
      where s.id = v_sale.id returning * into v_sale;
  end if;

  return jsonb_build_object('recorded', true, 'sale_id', v_sale.id,
    'status', kma_internal.program_sale_refresh_status(v_sale.id),
    'refunded_minor', v_sale.refunded_minor, 'new_events', v_new);
end $$;

-- Ends a worker's hold on a receipt. action 'done' finishes it with an outcome; 'retry'
-- schedules another attempt with backoff and gives up after 8 attempts with outcome
-- 'failed'; 'release' hands it back without counting the attempt (the worker stopped for a
-- reason that is not about this receipt). Codes are short and stable, never a message.
-- Input: the receipt reference, action, code, and for a retry an optional delay_seconds
-- (5..21600) in place of the backoff.
create function public.finish_program_sale_receipt(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_receipt public.merchant_payment_events;
  v_action text := p_input->>'action';
  v_code text := p_input->>'code';
  v_now timestamptz := clock_timestamp();
  v_next timestamptz;
begin
  v_receipt := kma_internal.program_sale_leased_receipt(p_input);
  if coalesce(v_action, '') not in ('done', 'retry', 'release')
    or coalesce(v_code, '') !~ '^[a-z][a-z0-9_]{1,59}$'
    or (v_action = 'done' and v_code = 'failed')
    or (p_input ? 'delay_seconds' and (v_action <> 'retry' or jsonb_typeof(p_input->'delay_seconds') <> 'number'
      or (p_input->>'delay_seconds') !~ '^[0-9]{1,5}$' or (p_input->>'delay_seconds')::integer not between 5 and 21600))
  then
    raise exception 'Invalid receipt outcome' using errcode = '22023';
  end if;

  if v_action = 'done' then
    update public.merchant_payment_events e
      set processed_at = v_now, process_outcome = v_code, process_error = null, lease_until = null, lease_token = null
      where e.platform_account_id = v_receipt.platform_account_id and e.livemode and e.event_id = v_receipt.event_id;
    return jsonb_build_object('state', 'done', 'outcome', v_code);
  end if;
  if v_action = 'retry' and v_receipt.process_attempts >= 8 then
    update public.merchant_payment_events e
      set processed_at = v_now, process_outcome = 'failed', process_error = v_code, lease_until = null, lease_token = null
      where e.platform_account_id = v_receipt.platform_account_id and e.livemode and e.event_id = v_receipt.event_id;
    return jsonb_build_object('state', 'failed', 'outcome', 'failed');
  end if;
  -- 2, 4, 8 ... minutes, at most 6 hours; a release comes back in 5 minutes.
  v_next := v_now + case when v_action = 'release' then interval '5 minutes'
    else make_interval(secs => coalesce((p_input->>'delay_seconds')::integer,
      least(21600, 60 * power(2, v_receipt.process_attempts))::integer)) end;
  update public.merchant_payment_events e
    set next_attempt_at = v_next, process_error = v_code, lease_until = null, lease_token = null,
      process_attempts = case when v_action = 'release' then greatest(e.process_attempts - 1, 0) else e.process_attempts end
    where e.platform_account_id = v_receipt.platform_account_id and e.livemode and e.event_id = v_receipt.event_id;
  return jsonb_build_object('state', case when v_action = 'release' then 'released' else 'retry' end,
    'next_attempt_at', v_next);
end $$;

-- Console (signed-in workspace member) ---------------------------------------------------

-- What the Program page shows under "Sale tracking". Payments are counted the way
-- workspace_stripe_payment_summary counts them; sales are the verified rows.
create function public.workspace_program_tracking(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_connected boolean;
  v_seen integer;
  v_tagged integer;
  v_sales integer;
  v_matched integer;
  v_last_sale timestamptz;
  v_last_matched timestamptz;
  v_last_source text;
  v_sdk timestamptz;
begin
  perform kma_internal.analytics_require_workspace(p_workspace_id);

  select exists (select 1 from public.merchant_businesses b
      join public.merchant_connections c on c.merchant_id = b.id and c.livemode and c.status = 'active'
      where b.workspace_id = p_workspace_id) into v_connected;
  select count(distinct coalesce(e.payment_intent_id, e.object_id))::int,
      (count(distinct coalesce(e.payment_intent_id, e.object_id)) filter (where e.kma_click is not null))::int
    into v_seen, v_tagged
    from public.merchant_businesses b
    join public.merchant_connections c on c.merchant_id = b.id and c.livemode and c.status = 'active'
    join public.merchant_payment_events e on e.connection_id = c.id and e.account_id = c.account_id
    where b.workspace_id = p_workspace_id
      and e.event_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
        'payment_intent.succeeded', 'invoice.paid');
  select count(*)::int, (count(*) filter (where s.click_record_id is not null))::int,
      max(s.paid_at), max(s.paid_at) filter (where s.click_record_id is not null)
    into v_sales, v_matched, v_last_sale, v_last_matched
    from public.affiliate_programs p
    join public.program_sales s on s.program_id = p.id
    where p.workspace_id = p_workspace_id and p.status <> 'archived';
  select s.match_source into v_last_source
    from public.affiliate_programs p
    join public.program_sales s on s.program_id = p.id
    where p.workspace_id = p_workspace_id and p.status <> 'archived' and s.click_record_id is not null
    order by s.paid_at desc, s.created_at desc, s.id
    limit 1;
  select max(s.started_at) into v_sdk
    from public.analytics_projects pr
    join public.analytics_sessions s on s.project_id = pr.id and s.creator_click is not null
    where pr.workspace_id = p_workspace_id;

  return jsonb_build_object(
    'connected', v_connected, 'payments_seen', v_seen, 'tagged_payments', v_tagged,
    'sales', v_sales, 'matched_sales', v_matched,
    'last_sale_at', v_last_sale, 'last_matched_at', v_last_matched, 'last_match_source', v_last_source,
    'sdk_click_seen_at', v_sdk);
end $$;

-- Schedule ---------------------------------------------------------------------------------
-- The webhook nudges the worker for each new receipt. This sweep, run once a minute by
-- pg_cron, covers whatever a nudge missed and every retry. Disabled until enabled is set.
-- The migration installs no cron job and no secret (docs/affiliate-self-serve-phase2-sales.md).
create table kma_internal.program_sales_schedule (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  last_tick_at timestamptz,
  last_dispatch_at timestamptz,
  last_request_id bigint
);
insert into kma_internal.program_sales_schedule default values;
revoke all on kma_internal.program_sales_schedule from public, anon, authenticated, service_role;

create function kma_internal.tick_program_sales_schedule() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_schedule kma_internal.program_sales_schedule;
  v_credential text;
  v_request bigint;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('kma-program-sales-scheduler', 0)) then
    return jsonb_build_object('status', 'locked');
  end if;
  update kma_internal.program_sales_schedule set last_tick_at = clock_timestamp() where singleton
    returning * into v_schedule;
  if not v_schedule.enabled then
    return jsonb_build_object('status', 'paused');
  end if;
  -- Nothing waiting: no call. Leased receipts are with a worker already.
  if not exists (select 1 from public.merchant_payment_events e
    where e.processed_at is null and e.next_attempt_at <= clock_timestamp()
      and (e.lease_until is null or e.lease_until < clock_timestamp())) then
    return jsonb_build_object('status', 'idle');
  end if;
  select decrypted_secret into v_credential from vault.decrypted_secrets where name = 'kma_program_sales_scheduler';
  if v_credential is null or length(v_credential) < 32 then
    return jsonb_build_object('status', 'credential_missing');
  end if;
  v_request := net.http_post(
    url := 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-sales-worker',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kma-scheduler-secret', v_credential),
    timeout_milliseconds := 80000);
  update kma_internal.program_sales_schedule
    set last_dispatch_at = clock_timestamp(), last_request_id = v_request where singleton;
  return jsonb_build_object('status', 'dispatched');
end $$;

-- Operator view of the queue and the sales it produced. Counts and codes only.
create function public.program_sales_health() returns jsonb
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
        'fee_unknown', count(*) filter (where s.fee_minor is null), 'last_sale_at', max(s.paid_at))
      from public.program_sales s))
$$;

-- Access -----------------------------------------------------------------------------------
revoke all on function
    kma_internal.program_sale_program(uuid, text), kma_internal.program_sale_clean_tag(text, text),
    kma_internal.program_sale_click(uuid, text),
    kma_internal.program_sale_email_click(uuid, uuid, text, timestamptz, integer),
    kma_internal.program_sale_refresh_status(uuid), kma_internal.program_sale_resequence(text, text),
    kma_internal.program_sale_leased_receipt(jsonb), kma_internal.program_sale_amount_ok(jsonb, text, boolean),
    kma_internal.tick_program_sales_schedule()
  from public, anon, authenticated, service_role;
revoke all on function
    public.claim_program_sale_receipts(jsonb), public.record_program_sale(jsonb),
    public.record_program_sale_event(jsonb), public.finish_program_sale_receipt(jsonb),
    public.program_sales_health(), public.workspace_program_tracking(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
    public.claim_program_sale_receipts(jsonb), public.record_program_sale(jsonb),
    public.record_program_sale_event(jsonb), public.finish_program_sale_receipt(jsonb),
    public.program_sales_health()
  to service_role;
grant execute on function public.workspace_program_tracking(uuid) to authenticated;

commit;
