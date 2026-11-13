-- Affiliate self-serve, Phase 4: the merchant's prepaid balance.
--
-- A merchant pays into their program's balance by card on Stripe's own page, on the
-- KissMyApps platform account. This migration is everything the database does about that:
-- what the Balance page reads (workspace_program_balance), the automatic top-up settings
-- (workspace_program_balance_settings), and the service functions the three edge functions
-- call (program-balance, program-balance-webhook, program-balance-worker).
--
-- The rules the functions keep, whatever order Stripe's events arrive in and however
-- often they are repeated:
--   * a top-up adds to the balance once, and only when the caller hands over a succeeded
--     live PaymentIntent whose amount, currency and customer are the top-up's own;
--   * a refund or a lost dispute of that card payment takes the money back out, once per
--     refunded amount; this is the only way a balance goes below zero;
--   * an account has at most one automatic top-up open at a time, so one shortfall is
--     charged once;
--   * a failed automatic top-up is retried after 1, 3 and 7 days and then not again until
--     the merchant pays in or changes the card.
--
-- Callers tell failures apart by the DETAIL of the error, one short code:
--   invalid_input, invalid_auto_topup, invalid_min_balance_minor, invalid_topup_amount_minor,
--   invalid_amount_minor, balance_not_started, card_required, no_program,
--   program_money_disabled, currency_mismatch, platform_mismatch, topup_mismatch,
--   card_mismatch: SQLSTATE 22023; topup_not_found, account_not_found: SQLSTATE P0002.
-- A caller who is not a member, or whose role is too low, gets the workspace errors.
--
-- Locks are always taken in this order: top-up row, balance account row, the workspace's
-- Stripe connection (shared), the program.
begin;

-- Storage ----------------------------------------------------------------------------------

-- How much of a succeeded top-up was taken back (card refund or lost dispute), and the
-- worker's hold on a top-up that is still open.
alter table public.program_topups
  add column reversed_minor bigint not null default 0,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column checks integer not null default 0 check (checks >= 0),
  add constraint program_topup_reversed_within_amount check (reversed_minor between 0 and amount_minor);

-- One shortfall, one charge: an account never has two automatic top-ups open.
create unique index program_topups_one_open_auto on public.program_topups(account_id)
  where kind = 'auto' and status in ('pending', 'processing');
create index program_topups_open on public.program_topups(lease_until) where status in ('pending', 'processing');

-- A card payment can be refunded in parts, so a top-up can have more than one reversal
-- entry. What stops a refund being taken twice is program_topups.reversed_minor, which
-- only ever grows to the refunded total under a lock on the top-up.
drop index public.program_balance_one_deposit_reversal;
create index program_balance_deposit_reversals on public.program_balance_entries(topup_id) where kind = 'deposit_reversed';

-- The true order of a balance's movements. created_at is the time a transaction began,
-- which is not the order in which two transactions reached the balance.
alter table public.program_balance_entries add column seq bigint generated always as identity;

-- One row per Stripe event the balance webhook accepted: what arrived, and how it ended.
-- No payload is kept, only its hash.
create table public.program_balance_events (
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9_]{3,251}$'),
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_.]{1,120}$'),
  object_id text not null check (object_id ~ '^[A-Za-z0-9_]{3,255}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  event_created timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 1 check (attempts > 0),
  processed_at timestamptz,
  outcome text check (outcome ~ '^[a-z][a-z0-9_]{1,59}$'),
  topup_id uuid references public.program_topups(id),
  constraint program_balance_event_outcome check ((processed_at is null) = (outcome is null))
);
create index program_balance_events_open on public.program_balance_events(received_at) where processed_at is null;
alter table public.program_balance_events enable row level security;
revoke all on public.program_balance_events from public, anon, authenticated, service_role;

-- Small helpers ----------------------------------------------------------------------------

create function kma_internal.program_balance_enabled() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.program_money_enabled from public.platform_settings s where s.singleton), false)
$$;

-- The input must be an object with nothing but the allowed keys, and every required one.
create function kma_internal.program_balance_keys(p_input jsonb, p_allowed text[], p_required text[] default '{}')
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object' then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  if exists (select 1 from jsonb_object_keys(p_input) k where k <> all(p_allowed))
    or exists (select 1 from unnest(p_required) r where not p_input ? r or jsonb_typeof(p_input->r) = 'null') then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
end $$;

-- A whole, non-negative number from the input, or null when it is absent or anything else.
create function kma_internal.program_balance_int(p_input jsonb, p_key text) returns bigint
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_input->p_key) = 'number' and (p_input->>p_key) ~ '^[0-9]{1,15}$' then
    return (p_input->>p_key)::bigint;
  end if;
  return null;
end $$;

-- What Stripe reports about a saved card, as the edge functions pass it on.
create function kma_internal.program_balance_card_ok(p_card jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if p_card is null or jsonb_typeof(p_card) <> 'object'
    or coalesce(p_card->>'payment_method_id', '') !~ '^pm_[A-Za-z0-9]{1,250}$'
    or coalesce(p_card->>'brand', '') !~ '^[a-z_]{1,30}$'
    or coalesce(p_card->>'last4', '') !~ '^[0-9]{4}$' then
    return false;
  end if;
  return coalesce(kma_internal.program_balance_int(p_card, 'exp_month') between 1 and 12, false)
    and coalesce(kma_internal.program_balance_int(p_card, 'exp_year') between 2024 and 2100, false);
end $$;

-- The smallest deposit this account may make now: the platform's first-deposit minimum
-- until a deposit has landed, 1000 after.
create function kma_internal.program_balance_min_deposit(p_account uuid) returns bigint
language sql stable set search_path = '' as $$
  select case when exists (select 1 from public.program_balance_entries e where e.account_id = p_account and e.kind = 'deposit')
    then 1000::bigint
    else coalesce((select s.program_min_deposit_minor from public.platform_settings s where s.singleton), 5000) end
$$;

-- Money arrived: a program that was paused only because its balance ran out goes live
-- again, as long as its Stripe account is still connected. Returns whether it went live.
create function kma_internal.program_balance_resume(p_account uuid) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  a public.program_balance_accounts;
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
  v_connected boolean;
begin
  select * into a from public.program_balance_accounts where id = p_account;
  if a.id is null or a.available_minor <= 0 or not exists (select 1 from public.affiliate_programs p
      where p.id = a.program_id and p.status = 'paused' and p.pause_reason = 'balance_empty') then
    return false;
  end if;
  perform kma_internal.program_lock_stripe(a.workspace_id);
  perform kma_internal.program_lock(a.workspace_id);
  select * into v_before from public.affiliate_programs where id = a.program_id for no key update;
  if v_before.status <> 'paused' or v_before.pause_reason <> 'balance_empty' then
    return false;
  end if;
  v_connected := kma_internal.workspace_stripe_connection(a.workspace_id) is not null;
  -- Without Stripe the program cannot see sales: it stays paused, for that reason now.
  update public.affiliate_programs set
    status = case when v_connected then 'live' else 'paused' end,
    pause_reason = case when v_connected then null else 'stripe_disconnected' end,
    revision = revision + 1, updated_at = clock_timestamp()
  where id = v_before.id returning * into v_saved;
  perform kma_internal.program_audit(
    case when v_connected then 'affiliate_program_balance_resumed' else 'affiliate_program_stripe_paused' end,
    'system', v_before, v_saved);
  return v_connected;
end $$;

-- Money was taken back: a live program whose balance is now empty or below zero pauses.
-- Nothing is paused for its balance while program money is switched off.
create function kma_internal.program_balance_pause(p_account uuid) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  a public.program_balance_accounts;
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
begin
  select * into a from public.program_balance_accounts where id = p_account;
  if a.id is null or a.available_minor > 0 or not kma_internal.program_balance_enabled()
    or not exists (select 1 from public.affiliate_programs p where p.id = a.program_id and p.status = 'live') then
    return false;
  end if;
  perform kma_internal.program_lock(a.workspace_id);
  select * into v_before from public.affiliate_programs where id = a.program_id for no key update;
  if v_before.status <> 'live' then
    return false;
  end if;
  update public.affiliate_programs set
    status = 'paused', pause_reason = 'balance_empty', revision = revision + 1, updated_at = clock_timestamp()
  where id = v_before.id returning * into v_saved;
  perform kma_internal.program_audit('affiliate_program_balance_paused', 'system', v_before, v_saved);
  return true;
end $$;

-- Whether an automatic top-up of the account is under way. The card it is charging must
-- stay usable at Stripe, so a card replaced meanwhile is not handed back for removal.
create function kma_internal.program_balance_charging(p_account uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.program_topups o
    where o.account_id = p_account and o.kind = 'auto' and o.status in ('pending', 'processing'))
$$;

-- What a service function says about a top-up.
create function kma_internal.program_topup_json(t public.program_topups) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'topup_id', t.id, 'account_id', t.account_id, 'kind', t.kind, 'status', t.status,
    'amount_minor', t.amount_minor, 'reversed_minor', t.reversed_minor, 'currency', t.currency,
    'checkout_session_id', t.checkout_session_id, 'payment_intent_id', t.payment_intent_id,
    'failure_code', t.failure_code, 'checks', t.checks,
    'created_at', extract(epoch from t.created_at)::bigint,
    'program_id', a.program_id, 'workspace_id', a.workspace_id,
    'stripe_customer_id', a.stripe_customer_id, 'platform_account_id', a.platform_account_id,
    'payment_method_id', a.payment_method_id)
  from public.program_balance_accounts a where a.id = t.account_id
$$;

-- The Balance page ----------------------------------------------------------------------------

create function kma_internal.program_balance_state(p_workspace uuid, p_role text) returns jsonb
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

  -- Newest first. Entries written in one transaction share created_at; seq keeps them in
  -- the order they were posted.
  select coalesce(jsonb_agg(x.entry order by x.created_at desc, x.seq desc), '[]'::jsonb) into v_activity
  from (
    select e.created_at, e.seq, jsonb_build_object(
      'id', e.id, 'kind', e.kind, 'amount_minor', e.amount_minor, 'available_after_minor', e.available_after_minor,
      'created_at', e.created_at, 'creator_name', f.public_name, 'sale_amount_minor', s.amount_minor,
      'topup_kind', t.kind, 'note', e.note) as entry
    from public.program_balance_entries e
    left join public.program_commissions c on c.id = e.commission_id
    left join public.affiliates f on f.id = c.affiliate_id
    left join public.program_sales s on s.id = c.sale_id
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
      'topup_problem', v_problem),
    'activity', v_activity, 'pending_topup', v_pending);
end $$;

-- The Balance page in one call, for any member of the workspace.
create function public.workspace_program_balance(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_role text := kma_internal.analytics_require_workspace(p_workspace_id);
begin
  return kma_internal.program_balance_state(p_workspace_id, v_role);
end $$;

-- Automatic top-up: on or off, the balance it keeps and the amount it adds. Any of
-- auto_topup, min_balance_minor, topup_amount_minor; what is absent stays as it is.
create function public.workspace_program_balance_settings(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  p public.affiliate_programs;
  a public.program_balance_accounts;
  n public.program_balance_accounts;
begin
  perform kma_internal.program_balance_keys(p_input, array['auto_topup', 'min_balance_minor', 'topup_amount_minor']);
  if p_input = '{}'::jsonb then
    perform kma_internal.program_fail('invalid_input', 'Nothing to change');
  end if;
  p := kma_internal.program_of(p_workspace_id);
  select * into a from public.program_balance_accounts where program_id = p.id for no key update;
  if a.id is null then
    perform kma_internal.program_fail('balance_not_started', 'Make a first deposit before changing these settings');
  end if;
  n := a;
  if p_input ? 'auto_topup' then
    if jsonb_typeof(p_input->'auto_topup') is distinct from 'boolean' then
      perform kma_internal.program_fail('invalid_auto_topup', 'Automatic top-up is on or off');
    end if;
    n.auto_topup := (p_input->>'auto_topup')::boolean;
  end if;
  if p_input ? 'min_balance_minor' then
    n.min_balance_minor := kma_internal.program_balance_int(p_input, 'min_balance_minor');
    if n.min_balance_minor is null or n.min_balance_minor > 100000000 then
      perform kma_internal.program_fail('invalid_min_balance_minor', 'Choose a minimum balance up to 1,000,000.00');
    end if;
  end if;
  if p_input ? 'topup_amount_minor' then
    n.topup_amount_minor := kma_internal.program_balance_int(p_input, 'topup_amount_minor');
    if n.topup_amount_minor is null or n.topup_amount_minor not between 1000 and 100000000 then
      perform kma_internal.program_fail('invalid_topup_amount_minor', 'Choose a top-up amount from 10.00 to 1,000,000.00');
    end if;
  end if;
  -- Asking for automatic top-up needs a card to charge.
  if p_input ? 'auto_topup' and n.auto_topup and a.payment_method_id is null then
    perform kma_internal.program_fail('card_required', 'Add a card before switching automatic top-up on');
  end if;
  if (n.auto_topup, n.min_balance_minor, n.topup_amount_minor)
      is distinct from (a.auto_topup, a.min_balance_minor, a.topup_amount_minor) then
    update public.program_balance_accounts set
      auto_topup = n.auto_topup, min_balance_minor = n.min_balance_minor, topup_amount_minor = n.topup_amount_minor,
      updated_at = clock_timestamp()
    where id = a.id;
    insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, before_data, after_data)
    values (auth.uid(), 'system', 'program_balance_settings_changed', 'program_balance_accounts', a.id,
      jsonb_build_object('auto_topup', a.auto_topup, 'min_balance_minor', a.min_balance_minor,
        'topup_amount_minor', a.topup_amount_minor),
      jsonb_build_object('auto_topup', n.auto_topup, 'min_balance_minor', n.min_balance_minor,
        'topup_amount_minor', n.topup_amount_minor));
  end if;
  return kma_internal.program_balance_state(p_workspace_id, v_role);
end $$;

-- Service functions: the merchant's actions (edge function program-balance) -----------------

-- Opens the balance account of a workspace's program, or returns the one it has. The
-- account is in the program's currency. With create false nothing is made: an account that
-- does not exist yet is balance_not_started.
-- Input: workspace_id, user_id, platform_account_id, create (default true).
create function public.open_program_balance(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace uuid;
  v_user uuid;
  v_platform text;
  v_create boolean := true;
  p public.affiliate_programs;
  a public.program_balance_accounts;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_balance_keys(p_input,
    array['workspace_id', 'user_id', 'platform_account_id', 'create'], array['workspace_id', 'user_id', 'platform_account_id']);
  v_workspace := kma_internal.workspace_stripe_uuid(p_input->>'workspace_id');
  v_user := kma_internal.workspace_stripe_uuid(p_input->>'user_id');
  v_platform := p_input->>'platform_account_id';
  perform kma_internal.workspace_stripe_role(v_workspace, v_user, true);
  if v_platform !~ '^acct_[A-Za-z0-9]+$'
    or (p_input ? 'create' and jsonb_typeof(p_input->'create') <> 'boolean') then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  v_create := coalesce((p_input->>'create')::boolean, true);
  if not kma_internal.program_balance_enabled() then
    perform kma_internal.program_fail('program_money_disabled', 'Balances are not switched on yet');
  end if;
  p := kma_internal.program_of(v_workspace);
  if p.id is null then
    perform kma_internal.program_fail('no_program', 'Create the program first');
  end if;

  if v_create then
    insert into public.program_balance_accounts(program_id, workspace_id, currency, platform_account_id, created_by, created_at, updated_at)
    values (p.id, v_workspace, p.currency, v_platform, v_user, v_now, v_now)
    on conflict (program_id) do nothing;
    if found then
      insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
      select v_user, 'system', 'program_balance_opened', 'program_balance_accounts', b.id,
        jsonb_build_object('program_id', p.id, 'currency', b.currency, 'platform_account_id', v_platform)
      from public.program_balance_accounts b where b.program_id = p.id;
    end if;
  end if;
  select * into a from public.program_balance_accounts where program_id = p.id for no key update;
  if a.id is null then
    perform kma_internal.program_fail('balance_not_started', 'Make a first deposit first');
  end if;
  if a.platform_account_id is distinct from v_platform then
    perform kma_internal.program_fail('platform_mismatch', 'This balance belongs to another Stripe platform account');
  end if;
  -- An account nothing has happened on yet follows the program's currency.
  if a.currency <> p.currency
    and not exists (select 1 from public.program_balance_entries e where e.account_id = a.id)
    and not exists (select 1 from public.program_topups t where t.account_id = a.id
      and t.status in ('pending', 'processing', 'succeeded', 'reversed')) then
    update public.program_balance_accounts set currency = p.currency, updated_at = v_now where id = a.id returning * into a;
  end if;
  return jsonb_build_object(
    'account_id', a.id, 'program_id', p.id, 'workspace_id', v_workspace, 'currency', a.currency,
    'program_currency', p.currency, 'program_name', p.name,
    'business_name', left(coalesce(
      nullif(btrim(kma_internal.workspace_stripe_connection(v_workspace)->>'business_name'), ''),
      (select nullif(btrim(w.name), '') from public.analytics_workspaces w where w.id = v_workspace),
      'KissMyApps merchant'), 200),
    'stripe_customer_id', a.stripe_customer_id, 'has_card', a.payment_method_id is not null,
    'min_deposit_minor', kma_internal.program_balance_min_deposit(a.id), 'max_deposit_minor', 100000000);
end $$;

-- Stores the Stripe customer made for an account. The first one stored stays; the answer
-- is always the customer the account has.
-- Input: account_id, stripe_customer_id, platform_account_id.
create function public.attach_program_balance_customer(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_account uuid;
  v_customer text;
  a public.program_balance_accounts;
begin
  perform kma_internal.program_balance_keys(p_input,
    array['account_id', 'stripe_customer_id', 'platform_account_id'], array['account_id', 'stripe_customer_id', 'platform_account_id']);
  v_account := kma_internal.workspace_stripe_uuid(p_input->>'account_id');
  v_customer := p_input->>'stripe_customer_id';
  if v_account is null or v_customer !~ '^cus_[A-Za-z0-9]{1,250}$' then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  select * into a from public.program_balance_accounts where id = v_account for no key update;
  if a.id is null then
    perform kma_internal.program_fail('account_not_found', 'Balance account not found', 'P0002');
  end if;
  if a.platform_account_id is distinct from p_input->>'platform_account_id' then
    perform kma_internal.program_fail('platform_mismatch', 'This balance belongs to another Stripe platform account');
  end if;
  if a.stripe_customer_id is null then
    update public.program_balance_accounts set stripe_customer_id = v_customer, updated_at = clock_timestamp()
    where id = a.id returning * into a;
  end if;
  return jsonb_build_object('account_id', a.id, 'stripe_customer_id', a.stripe_customer_id);
end $$;

-- Starts a deposit: one pending top-up for the amount, in the account's currency. An
-- earlier deposit of this account that was never paid is closed, and its Checkout Session
-- is handed back so the caller can end it at Stripe.
-- Input: workspace_id, user_id, platform_account_id, amount_minor.
create function public.begin_program_deposit(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace uuid;
  v_user uuid;
  v_amount bigint;
  p public.affiliate_programs;
  a public.program_balance_accounts;
  t public.program_topups;
  v_superseded jsonb;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_balance_keys(p_input,
    array['workspace_id', 'user_id', 'platform_account_id', 'amount_minor'],
    array['workspace_id', 'user_id', 'platform_account_id', 'amount_minor']);
  v_workspace := kma_internal.workspace_stripe_uuid(p_input->>'workspace_id');
  v_user := kma_internal.workspace_stripe_uuid(p_input->>'user_id');
  perform kma_internal.workspace_stripe_role(v_workspace, v_user, true);
  if not kma_internal.program_balance_enabled() then
    perform kma_internal.program_fail('program_money_disabled', 'Balances are not switched on yet');
  end if;
  p := kma_internal.program_of(v_workspace);
  if p.id is null then
    perform kma_internal.program_fail('no_program', 'Create the program first');
  end if;
  select * into a from public.program_balance_accounts where program_id = p.id for no key update;
  if a.id is null or a.stripe_customer_id is null then
    perform kma_internal.program_fail('balance_not_started', 'The balance has not been opened yet');
  end if;
  if a.platform_account_id is distinct from p_input->>'platform_account_id' then
    perform kma_internal.program_fail('platform_mismatch', 'This balance belongs to another Stripe platform account');
  end if;
  if a.currency <> p.currency then
    perform kma_internal.program_fail('currency_mismatch', 'The balance is in another currency than the program');
  end if;
  v_amount := kma_internal.program_balance_int(p_input, 'amount_minor');
  if v_amount is null or v_amount < kma_internal.program_balance_min_deposit(a.id) or v_amount > 100000000 then
    perform kma_internal.program_fail('invalid_amount_minor', 'Choose an amount within the allowed range');
  end if;

  with closed as (
    update public.program_topups o set
      status = 'canceled', failure_code = 'superseded', settled_at = v_now, updated_at = v_now,
      lease_token = null, lease_until = null
    where o.account_id = a.id and o.kind = 'deposit' and o.status in ('pending', 'processing')
    returning o.id, o.checkout_session_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('topup_id', c.id, 'checkout_session_id', c.checkout_session_id)), '[]'::jsonb)
    into v_superseded from closed c;

  -- The worker first looks at an unpaid deposit ten minutes from now.
  insert into public.program_topups(account_id, kind, amount_minor, currency, requested_by, created_at, updated_at, lease_until)
  values (a.id, 'deposit', v_amount, a.currency, v_user, v_now, v_now, v_now + interval '10 minutes')
  returning * into t;
  return kma_internal.program_topup_json(t) || jsonb_build_object(
    'program_name', p.name, 'superseded', v_superseded);
end $$;

-- Service functions: settlement (webhook and worker) ------------------------------------------

-- Finds the top-up a Stripe object belongs to: by its PaymentIntent, else its Checkout
-- Session, else the top-up id KissMyApps put in the object's metadata. When more than one
-- is given they must all name the same top-up.
-- Input: any of payment_intent_id, checkout_session_id, topup_id.
create function public.find_program_topup(p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_intent text;
  v_session text;
  v_topup uuid;
  t public.program_topups;
begin
  perform kma_internal.program_balance_keys(p_input, array['payment_intent_id', 'checkout_session_id', 'topup_id']);
  v_intent := p_input->>'payment_intent_id';
  v_session := p_input->>'checkout_session_id';
  v_topup := kma_internal.workspace_stripe_uuid(p_input->>'topup_id');
  if (v_intent is null and v_session is null and v_topup is null)
    or (v_intent is not null and v_intent !~ '^pi_[A-Za-z0-9_]{1,252}$')
    or (v_session is not null and v_session !~ '^cs_[A-Za-z0-9_]{1,252}$')
    or (p_input->>'topup_id' is not null and v_topup is null) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  if v_intent is not null then
    select * into t from public.program_topups where payment_intent_id = v_intent;
  end if;
  if t.id is null and v_session is not null then
    select * into t from public.program_topups where checkout_session_id = v_session;
  end if;
  if t.id is null and v_topup is not null then
    select * into t from public.program_topups where id = v_topup;
  end if;
  if t.id is null then
    return jsonb_build_object('found', false);
  end if;
  if (v_topup is not null and t.id <> v_topup)
    or (v_intent is not null and t.payment_intent_id is not null and t.payment_intent_id <> v_intent)
    or (v_session is not null and t.checkout_session_id is not null and t.checkout_session_id <> v_session) then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;
  return jsonb_build_object('found', true) || kma_internal.program_topup_json(t);
end $$;

-- Writes the Stripe ids of a top-up once Stripe has it. An id that is already there must
-- be the same one. A pending top-up becomes processing.
-- Input: topup_id, and any of checkout_session_id, payment_intent_id.
create function public.attach_program_topup(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_topup uuid;
  v_intent text;
  v_session text;
  t public.program_topups;
begin
  perform kma_internal.program_balance_keys(p_input,
    array['topup_id', 'checkout_session_id', 'payment_intent_id'], array['topup_id']);
  v_topup := kma_internal.workspace_stripe_uuid(p_input->>'topup_id');
  v_intent := p_input->>'payment_intent_id';
  v_session := p_input->>'checkout_session_id';
  if v_topup is null or (v_intent is null and v_session is null)
    or (v_intent is not null and v_intent !~ '^pi_[A-Za-z0-9_]{1,252}$')
    or (v_session is not null and v_session !~ '^cs_[A-Za-z0-9_]{1,252}$') then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  select * into t from public.program_topups where id = v_topup for no key update;
  if t.id is null then
    perform kma_internal.program_fail('topup_not_found', 'Top-up not found', 'P0002');
  end if;
  if (v_intent is not null and t.payment_intent_id is not null and t.payment_intent_id <> v_intent)
    or (v_session is not null and t.checkout_session_id is not null and t.checkout_session_id <> v_session) then
    perform kma_internal.program_fail('topup_mismatch', 'This top-up belongs to another Stripe payment');
  end if;
  begin
    update public.program_topups set
      payment_intent_id = coalesce(payment_intent_id, v_intent),
      checkout_session_id = coalesce(checkout_session_id, v_session),
      status = case when status = 'pending' then 'processing' else status end,
      updated_at = clock_timestamp()
    where id = t.id returning * into t;
  exception when unique_violation then
    perform kma_internal.program_fail('topup_mismatch', 'This Stripe payment belongs to another top-up');
  end;
  return kma_internal.program_topup_json(t);
end $$;

-- Ends a top-up.
--   succeeded: the caller read a succeeded live PaymentIntent back from Stripe and passes
--     what it saw. It must be this top-up's amount, currency and customer, or nothing
--     happens (topup_mismatch). The balance gets one deposit entry, however often this is
--     called; the card is saved; the failure state is cleared; a program paused for an
--     empty balance goes live again. A top-up that was closed as failed or canceled is
--     still credited: the money did arrive.
--   failed: nothing was added. A failed automatic top-up counts towards the retry
--     schedule: 1 day, 3 days, 7 days, then no more tries.
--   canceled: nothing was added and nothing is counted.
-- Input: topup_id, outcome, payment_intent_id, and for succeeded livemode, amount_minor,
-- currency, customer_id and optionally card {payment_method_id, brand, last4, exp_month,
-- exp_year}; for failed and canceled failure_code.
create function public.settle_program_topup(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_topup uuid;
  v_outcome text;
  v_intent text;
  v_code text;
  v_card jsonb;
  t public.program_topups;
  a public.program_balance_accounts;
  v_now timestamptz := clock_timestamp();
  v_changed boolean := false;
  v_resumed boolean := false;
  v_replaced text;
begin
  perform kma_internal.program_balance_keys(p_input,
    array['topup_id', 'outcome', 'payment_intent_id', 'livemode', 'amount_minor', 'currency', 'customer_id', 'card', 'failure_code'],
    array['topup_id', 'outcome']);
  v_topup := kma_internal.workspace_stripe_uuid(p_input->>'topup_id');
  v_outcome := p_input->>'outcome';
  v_intent := p_input->>'payment_intent_id';
  v_code := p_input->>'failure_code';
  v_card := nullif(p_input->'card', 'null'::jsonb);
  if v_topup is null or v_outcome not in ('succeeded', 'failed', 'canceled')
    or (v_intent is not null and v_intent !~ '^pi_[A-Za-z0-9_]{1,252}$')
    or (v_code is not null and v_code !~ '^[a-z][a-z0-9_]{1,59}$')
    or (v_outcome = 'succeeded' and v_intent is null)
    or (v_outcome = 'failed' and v_code is null)
    or (v_card is not null and not kma_internal.program_balance_card_ok(v_card)) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  select * into t from public.program_topups where id = v_topup for no key update;
  if t.id is null then
    perform kma_internal.program_fail('topup_not_found', 'Top-up not found', 'P0002');
  end if;
  select * into a from public.program_balance_accounts where id = t.account_id for no key update;
  if v_intent is not null and t.payment_intent_id is not null and t.payment_intent_id <> v_intent then
    perform kma_internal.program_fail('topup_mismatch', 'This top-up belongs to another Stripe payment');
  end if;

  if v_outcome = 'succeeded' then
    if jsonb_typeof(p_input->'livemode') is distinct from 'boolean' or not (p_input->>'livemode')::boolean
      or kma_internal.program_balance_int(p_input, 'amount_minor') is distinct from t.amount_minor
      or upper(coalesce(p_input->>'currency', '')) <> t.currency
      or a.stripe_customer_id is null or p_input->>'customer_id' is distinct from a.stripe_customer_id then
      perform kma_internal.program_fail('topup_mismatch', 'The payment is not the one this top-up asked for');
    end if;
    if t.status not in ('succeeded', 'reversed') then
      begin
        update public.program_topups set
          payment_intent_id = v_intent, status = 'succeeded', failure_code = null, settled_at = v_now, updated_at = v_now,
          lease_token = null, lease_until = null
        where id = t.id returning * into t;
      exception when unique_violation then
        perform kma_internal.program_fail('topup_mismatch', 'This Stripe payment belongs to another top-up');
      end;
      perform kma_internal.program_balance_post(a.id, 'deposit', t.amount_minor, t.id, null, null);
      -- A deposit's card becomes the saved card. An automatic top-up charged the saved
      -- card: if the merchant has chosen another one since, that choice stays.
      if t.kind = 'auto' and v_card->>'payment_method_id' is distinct from a.payment_method_id then
        v_card := null;
      end if;
      if v_card is not null and a.payment_method_id <> v_card->>'payment_method_id'
        and not kma_internal.program_balance_charging(a.id) then
        v_replaced := a.payment_method_id;
      end if;
      update public.program_balance_accounts set
        topup_failures = 0, topup_retry_at = null, topup_failure_code = null,
        payment_method_id = coalesce(v_card->>'payment_method_id', payment_method_id),
        card_brand = coalesce(v_card->>'brand', card_brand),
        card_last4 = coalesce(v_card->>'last4', card_last4),
        card_exp_month = coalesce((v_card->>'exp_month')::integer, card_exp_month),
        card_exp_year = coalesce((v_card->>'exp_year')::integer, card_exp_year),
        updated_at = v_now
      where id = a.id;
      v_resumed := kma_internal.program_balance_resume(a.id);
      v_changed := true;
    end if;
  elsif t.status in ('pending', 'processing') then
    begin
      update public.program_topups set
        payment_intent_id = coalesce(payment_intent_id, v_intent),
        status = v_outcome, failure_code = v_code, settled_at = v_now, updated_at = v_now,
        lease_token = null, lease_until = null
      where id = t.id returning * into t;
    exception when unique_violation then
      perform kma_internal.program_fail('topup_mismatch', 'This Stripe payment belongs to another top-up');
    end;
    if v_outcome = 'failed' and t.kind = 'auto' then
      update public.program_balance_accounts set
        topup_failures = topup_failures + 1, topup_failure_code = v_code,
        topup_retry_at = case topup_failures
          when 0 then v_now + interval '1 day' when 1 then v_now + interval '3 days'
          when 2 then v_now + interval '7 days' end,
        updated_at = v_now
      where id = a.id;
    end if;
    v_changed := true;
  end if;

  select * into a from public.program_balance_accounts where id = a.id;
  return kma_internal.program_topup_json(t) || jsonb_build_object(
    'changed', v_changed, 'available_minor', a.available_minor, 'program_resumed', v_resumed,
    'topup_failures', a.topup_failures, 'replaced_payment_method_id', v_replaced);
end $$;

-- Takes a top-up's money back out of the balance after its card payment was refunded or
-- lost a dispute. refunded_minor is the total Stripe says has been refunded so far; the
-- balance moves by what is new in it. A lost dispute takes back whatever is left. The
-- balance may go below zero here, and a live program whose balance is then empty pauses.
-- Input: payment_intent_id, reason (refunded | dispute_lost), refunded_minor for refunded.
create function public.reverse_program_topup(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_intent text;
  v_reason text;
  v_target bigint;
  v_delta bigint;
  t public.program_topups;
  a public.program_balance_accounts;
  v_paused boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_balance_keys(p_input,
    array['payment_intent_id', 'reason', 'refunded_minor'], array['payment_intent_id', 'reason']);
  v_intent := p_input->>'payment_intent_id';
  v_reason := p_input->>'reason';
  if v_intent !~ '^pi_[A-Za-z0-9_]{1,252}$' or v_reason not in ('refunded', 'dispute_lost')
    or (v_reason = 'refunded' and kma_internal.program_balance_int(p_input, 'refunded_minor') is null) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  select * into t from public.program_topups where payment_intent_id = v_intent for no key update;
  if t.id is null then
    return jsonb_build_object('found', false);
  end if;
  select * into a from public.program_balance_accounts where id = t.account_id for no key update;
  -- Only money that was added can be taken back.
  if t.status in ('succeeded', 'reversed') then
    v_target := case when v_reason = 'dispute_lost' then t.amount_minor
      else least(kma_internal.program_balance_int(p_input, 'refunded_minor'), t.amount_minor) end;
    v_delta := v_target - t.reversed_minor;
  end if;
  if coalesce(v_delta, 0) > 0 then
    perform kma_internal.program_balance_post(a.id, 'deposit_reversed', -v_delta, t.id, null,
      case when v_reason = 'dispute_lost' then 'Card payment dispute lost' else 'Card payment refunded' end);
    update public.program_topups set
      reversed_minor = v_target, status = case when v_target = amount_minor then 'reversed' else status end,
      updated_at = v_now
    where id = t.id returning * into t;
    v_paused := kma_internal.program_balance_pause(a.id);
  end if;
  select * into a from public.program_balance_accounts where id = a.id;
  return jsonb_build_object('found', true) || kma_internal.program_topup_json(t) || jsonb_build_object(
    'changed', coalesce(v_delta, 0) > 0, 'available_minor', a.available_minor, 'program_paused', v_paused);
end $$;

-- Saves the card a merchant chose on Stripe's page as the one automatic top-ups charge.
-- The card must belong to the account's own Stripe customer. A new card is the merchant
-- acting on a failed top-up, so the failure state is cleared and the next run tries again.
-- Input: account_id, customer_id, card {payment_method_id, brand, last4, exp_month, exp_year}.
create function public.save_program_balance_card(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_account uuid;
  v_card jsonb;
  a public.program_balance_accounts;
  v_changed boolean;
  v_replaced text;
begin
  perform kma_internal.program_balance_keys(p_input,
    array['account_id', 'customer_id', 'card'], array['account_id', 'customer_id', 'card']);
  v_account := kma_internal.workspace_stripe_uuid(p_input->>'account_id');
  v_card := p_input->'card';
  if v_account is null or not kma_internal.program_balance_card_ok(v_card) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  select * into a from public.program_balance_accounts where id = v_account for no key update;
  if a.id is null then
    perform kma_internal.program_fail('account_not_found', 'Balance account not found', 'P0002');
  end if;
  if a.stripe_customer_id is null or a.stripe_customer_id is distinct from p_input->>'customer_id' then
    perform kma_internal.program_fail('card_mismatch', 'This card belongs to another Stripe customer');
  end if;
  v_changed := a.payment_method_id is distinct from v_card->>'payment_method_id';
  v_replaced := case when v_changed and not kma_internal.program_balance_charging(a.id) then a.payment_method_id end;
  update public.program_balance_accounts set
    payment_method_id = v_card->>'payment_method_id', card_brand = v_card->>'brand', card_last4 = v_card->>'last4',
    card_exp_month = (v_card->>'exp_month')::integer, card_exp_year = (v_card->>'exp_year')::integer,
    topup_failures = 0, topup_retry_at = null, topup_failure_code = null, updated_at = clock_timestamp()
  where id = a.id;
  if v_changed then
    insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, before_data, after_data)
    values (null, 'system', 'program_balance_card_saved', 'program_balance_accounts', a.id,
      jsonb_build_object('card_brand', a.card_brand, 'card_last4', a.card_last4,
        'card_exp_month', a.card_exp_month, 'card_exp_year', a.card_exp_year),
      jsonb_build_object('card_brand', v_card->'brand', 'card_last4', v_card->'last4',
        'card_exp_month', v_card->'exp_month', 'card_exp_year', v_card->'exp_year'));
  end if;
  return jsonb_build_object('account_id', a.id, 'changed', v_changed, 'replaced_payment_method_id', v_replaced);
end $$;

-- Service functions: webhook receipts ---------------------------------------------------------

-- Notes that a signed Stripe event arrived. The same event again is a duplicate, and says
-- whether the first one was finished; the same id with a different body is refused.
-- Input: event_id, event_type, object_id, payload_sha256, event_created (epoch seconds).
create function public.record_program_balance_event(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  e public.program_balance_events;
  v_created bigint;
begin
  perform kma_internal.program_balance_keys(p_input,
    array['event_id', 'event_type', 'object_id', 'payload_sha256', 'event_created'],
    array['event_id', 'event_type', 'object_id', 'payload_sha256', 'event_created']);
  v_created := kma_internal.program_balance_int(p_input, 'event_created');
  if v_created is null or v_created = 0 or v_created > 4102444800
    or coalesce(p_input->>'event_id', '') !~ '^evt_[A-Za-z0-9_]{3,251}$'
    or coalesce(p_input->>'event_type', '') !~ '^[a-z][a-z0-9_.]{1,120}$'
    or coalesce(p_input->>'object_id', '') !~ '^[A-Za-z0-9_]{3,255}$'
    or coalesce(p_input->>'payload_sha256', '') !~ '^[a-f0-9]{64}$' then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  insert into public.program_balance_events(event_id, event_type, object_id, payload_sha256, event_created)
  values (p_input->>'event_id', p_input->>'event_type', p_input->>'object_id', p_input->>'payload_sha256',
    to_timestamp(v_created))
  on conflict (event_id) do nothing;
  if found then
    return jsonb_build_object('duplicate', false, 'processed', false, 'outcome', null);
  end if;
  select * into e from public.program_balance_events where event_id = p_input->>'event_id' for no key update;
  if e.payload_sha256 <> p_input->>'payload_sha256' then
    raise exception 'This event id was already received with another body' using errcode = '23505';
  end if;
  update public.program_balance_events set attempts = attempts + 1 where event_id = e.event_id;
  return jsonb_build_object('duplicate', true, 'processed', e.processed_at is not null, 'outcome', e.outcome);
end $$;

-- Notes how an event ended. The first ending stays.
-- Input: event_id, outcome, optionally topup_id.
create function public.finish_program_balance_event(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e public.program_balance_events;
begin
  perform kma_internal.program_balance_keys(p_input, array['event_id', 'outcome', 'topup_id'], array['event_id', 'outcome']);
  if (p_input->>'outcome') !~ '^[a-z][a-z0-9_]{1,59}$'
    or (p_input->>'topup_id' is not null and kma_internal.workspace_stripe_uuid(p_input->>'topup_id') is null) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  update public.program_balance_events set
    processed_at = clock_timestamp(), outcome = p_input->>'outcome',
    topup_id = (select t.id from public.program_topups t where t.id = kma_internal.workspace_stripe_uuid(p_input->>'topup_id'))
  where event_id = p_input->>'event_id' and processed_at is null;
  select * into e from public.program_balance_events where event_id = p_input->>'event_id';
  return jsonb_build_object('found', e.event_id is not null, 'outcome', e.outcome);
end $$;

-- Service functions: the worker ---------------------------------------------------------------

create function kma_internal.program_balance_claim_input(p_input jsonb, out platform text, out lot integer, out lease integer)
language plpgsql immutable set search_path = '' as $$
declare
  v_lot bigint;
  v_lease bigint;
begin
  perform kma_internal.program_balance_keys(p_input,
    array['platform_account_id', 'limit', 'lease_seconds'], array['platform_account_id']);
  v_lot := case when p_input ? 'limit' then kma_internal.program_balance_int(p_input, 'limit') else 5 end;
  v_lease := case when p_input ? 'lease_seconds' then kma_internal.program_balance_int(p_input, 'lease_seconds') else 300 end;
  if (p_input->>'platform_account_id') !~ '^acct_[A-Za-z0-9]+$'
    or v_lot is null or v_lot not between 1 and 25 or v_lease is null or v_lease not between 60 and 900 then
    perform kma_internal.program_fail('invalid_input', 'Invalid claim');
  end if;
  platform := p_input->>'platform_account_id';
  lot := v_lot;
  lease := v_lease;
end $$;

-- Hands the worker the accounts whose balance is below the minimum the merchant chose, each
-- with a new automatic top-up to charge and a lease on it. An account is due when program
-- money is on, automatic top-up is on, a card is saved, the program is live (or paused only
-- for its balance), no top-up of the account is still open, and the retry schedule allows.
-- The new top-up is itself what stops a second worker: the account is locked while it is
-- made, and an account cannot have two open automatic top-ups.
-- Input: platform_account_id, limit 1..25, lease_seconds 60..900.
create function public.claim_program_auto_topups(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c record;
  a public.program_balance_accounts;
  t public.program_topups;
  v_now timestamptz := clock_timestamp();
  v_topups jsonb := '[]'::jsonb;
begin
  select * into c from kma_internal.program_balance_claim_input(p_input);
  if not kma_internal.program_balance_enabled() then
    return jsonb_build_object('topups', v_topups);
  end if;
  for a in
    select b.* from public.program_balance_accounts b
    join public.affiliate_programs p on p.id = b.program_id
    where b.platform_account_id = c.platform and b.auto_topup
      and b.payment_method_id is not null and b.stripe_customer_id is not null
      and b.available_minor < b.min_balance_minor
      and b.topup_failures < 4 and (b.topup_retry_at is null or b.topup_retry_at <= v_now)
      and b.currency = p.currency
      and (p.status = 'live' or (p.status = 'paused' and p.pause_reason = 'balance_empty'))
      and not exists (select 1 from public.program_topups o where o.account_id = b.id and o.status in ('pending', 'processing'))
    order by b.available_minor - b.min_balance_minor, b.id
    limit c.lot
    for no key update of b skip locked
  loop
    -- Looked at again now that the account is locked: whoever held it may have just
    -- made a top-up, or changed what made the account due.
    select * into a from public.program_balance_accounts where id = a.id;
    if not a.auto_topup or a.payment_method_id is null or a.available_minor >= a.min_balance_minor
      or a.topup_failures >= 4 or a.topup_retry_at > v_now
      or exists (select 1 from public.program_topups o where o.account_id = a.id and o.status in ('pending', 'processing')) then
      continue;
    end if;
    begin
      insert into public.program_topups(account_id, kind, amount_minor, currency, created_at, updated_at, lease_token, lease_until)
      values (a.id, 'auto', a.topup_amount_minor, a.currency, v_now, v_now, gen_random_uuid(),
        v_now + make_interval(secs => c.lease))
      returning * into t;
    exception when unique_violation then
      continue;
    end;
    v_topups := v_topups || jsonb_build_array(kma_internal.program_topup_json(t) || jsonb_build_object('lease_token', t.lease_token));
  end loop;
  return jsonb_build_object('topups', v_topups);
end $$;

-- Hands the worker open top-ups nobody is working on, to be checked against Stripe: a
-- deposit whose event never arrived, an automatic top-up whose worker stopped half way.
-- Input: platform_account_id, limit 1..25, lease_seconds 60..900.
create function public.claim_program_topup_checks(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c record;
  t public.program_topups;
  v_now timestamptz := clock_timestamp();
  v_topups jsonb := '[]'::jsonb;
begin
  select * into c from kma_internal.program_balance_claim_input(p_input);
  for t in
    select o.* from public.program_topups o
    join public.program_balance_accounts a on a.id = o.account_id
    where a.platform_account_id = c.platform and o.status in ('pending', 'processing')
      and (o.lease_until is null or o.lease_until < v_now)
    order by o.lease_until nulls first, o.created_at, o.id
    limit c.lot
    for no key update of o skip locked
  loop
    update public.program_topups set
      lease_token = gen_random_uuid(), lease_until = v_now + make_interval(secs => c.lease), checks = checks + 1
    where id = t.id returning * into t;
    v_topups := v_topups || jsonb_build_array(kma_internal.program_topup_json(t) || jsonb_build_object('lease_token', t.lease_token));
  end loop;
  return jsonb_build_object('topups', v_topups);
end $$;

-- Ends a worker's hold on a top-up that is still open, to be looked at again later.
-- Input: topup_id, lease_token, delay_seconds 30..86400.
create function public.release_program_topup(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_delay bigint;
  v_released boolean;
begin
  perform kma_internal.program_balance_keys(p_input,
    array['topup_id', 'lease_token', 'delay_seconds'], array['topup_id', 'lease_token', 'delay_seconds']);
  v_delay := kma_internal.program_balance_int(p_input, 'delay_seconds');
  if kma_internal.workspace_stripe_uuid(p_input->>'topup_id') is null
    or kma_internal.workspace_stripe_uuid(p_input->>'lease_token') is null
    or v_delay is null or v_delay not between 30 and 86400 then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  update public.program_topups set
    lease_token = null, lease_until = clock_timestamp() + make_interval(secs => v_delay::integer)
  where id = (p_input->>'topup_id')::uuid and lease_token = (p_input->>'lease_token')::uuid
    and status in ('pending', 'processing');
  v_released := found;
  return jsonb_build_object('released', v_released);
end $$;

-- Schedule ---------------------------------------------------------------------------------
-- Run once a minute by pg_cron. It calls the worker when there is something for it: an
-- account below its minimum, an open top-up to check, a commission whose hold has passed,
-- and in any case every five minutes so sales whose commission could not be worked out are
-- tried again. Disabled until enabled is set. The migration installs no cron job and no
-- credential (docs/affiliate-self-serve-phase4-balance.md).
create table kma_internal.program_balance_schedule (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  last_tick_at timestamptz,
  last_dispatch_at timestamptz,
  last_request_id bigint
);
insert into kma_internal.program_balance_schedule default values;
revoke all on kma_internal.program_balance_schedule from public, anon, authenticated, service_role;

create function kma_internal.tick_program_balance_schedule() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_schedule kma_internal.program_balance_schedule;
  v_credential text;
  v_request bigint;
  v_now timestamptz := clock_timestamp();
begin
  if not pg_try_advisory_xact_lock(hashtextextended('kma-program-balance-scheduler', 0)) then
    return jsonb_build_object('status', 'locked');
  end if;
  update kma_internal.program_balance_schedule set last_tick_at = v_now where singleton
    returning * into v_schedule;
  if not v_schedule.enabled then
    return jsonb_build_object('status', 'paused');
  end if;
  if not kma_internal.program_balance_enabled() then
    return jsonb_build_object('status', 'money_disabled');
  end if;
  if v_schedule.last_dispatch_at > v_now - interval '5 minutes'
    and not exists (select 1 from public.program_topups t
      where t.status in ('pending', 'processing') and (t.lease_until is null or t.lease_until < v_now))
    and not exists (select 1 from public.program_commissions c where c.status = 'held' and c.hold_until <= v_now)
    and not exists (select 1 from public.program_balance_accounts b
      join public.affiliate_programs p on p.id = b.program_id
      where b.auto_topup and b.payment_method_id is not null and b.stripe_customer_id is not null
        and b.currency = p.currency and b.available_minor < b.min_balance_minor
        and b.topup_failures < 4 and (b.topup_retry_at is null or b.topup_retry_at <= v_now)
        and (p.status = 'live' or (p.status = 'paused' and p.pause_reason = 'balance_empty'))
        and not exists (select 1 from public.program_topups o where o.account_id = b.id and o.status in ('pending', 'processing'))) then
    return jsonb_build_object('status', 'idle');
  end if;
  select decrypted_secret into v_credential from vault.decrypted_secrets where name = 'kma_program_balance_scheduler';
  if v_credential is null or length(v_credential) < 32 then
    return jsonb_build_object('status', 'credential_missing');
  end if;
  v_request := net.http_post(
    url := 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-balance-worker',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kma-scheduler-secret', v_credential),
    timeout_milliseconds := 80000);
  update kma_internal.program_balance_schedule
    set last_dispatch_at = clock_timestamp(), last_request_id = v_request where singleton;
  return jsonb_build_object('status', 'dispatched');
end $$;

-- Operator view: counts and codes only.
create function public.program_balance_health() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', kma_internal.program_balance_enabled(),
    'schedule', (select to_jsonb(s) - 'last_request_id' - 'singleton' from kma_internal.program_balance_schedule s),
    'accounts', (select jsonb_build_object(
        'total', count(*), 'with_card', count(*) filter (where a.payment_method_id is not null),
        'below_minimum', count(*) filter (where a.auto_topup and a.available_minor < a.min_balance_minor),
        'negative', count(*) filter (where a.available_minor < 0),
        'retrying', count(*) filter (where a.topup_failures between 1 and 3),
        'stopped', count(*) filter (where a.topup_failures >= 4))
      from public.program_balance_accounts a),
    'topups', (select coalesce(jsonb_object_agg(r.label, r.n), '{}'::jsonb)
      from (select t.kind || '_' || t.status as label, count(*) as n from public.program_topups t group by 1) r),
    'open_topups', (select jsonb_build_object(
        'due_for_check', count(*) filter (where t.lease_until is null or t.lease_until < now()),
        'oldest_created_at', min(t.created_at))
      from public.program_topups t where t.status in ('pending', 'processing')),
    'failures', (select coalesce(jsonb_object_agg(r.code, r.n), '{}'::jsonb)
      from (select coalesce(t.failure_code, 'unknown') as code, count(*) as n from public.program_topups t
        where t.status in ('failed', 'canceled') and t.settled_at > now() - interval '30 days' group by 1) r),
    'events', (select jsonb_build_object(
        'unfinished', count(*) filter (where e.processed_at is null),
        'oldest_unfinished_at', min(e.received_at) filter (where e.processed_at is null),
        'outcomes_last_day', (select coalesce(jsonb_object_agg(r.outcome, r.n), '{}'::jsonb)
          from (select o.outcome, count(*) as n from public.program_balance_events o
            where o.processed_at > now() - interval '1 day' group by o.outcome) r))
      from public.program_balance_events e),
    'ledger_mismatches', (select count(*) from public.program_balance_accounts a
      where a.available_minor <> coalesce((select sum(e.amount_minor) from public.program_balance_entries e
        where e.account_id = a.id), 0)))
$$;

-- Access -----------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'kma_internal'
      and (p.proname like 'program\_balance\_%' or p.proname like 'program\_topup\_%' or p.proname = 'tick_program_balance_schedule')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

revoke all on function
    public.workspace_program_balance(uuid), public.workspace_program_balance_settings(uuid, jsonb),
    public.open_program_balance(jsonb), public.attach_program_balance_customer(jsonb),
    public.begin_program_deposit(jsonb), public.find_program_topup(jsonb), public.attach_program_topup(jsonb),
    public.settle_program_topup(jsonb), public.reverse_program_topup(jsonb), public.save_program_balance_card(jsonb),
    public.record_program_balance_event(jsonb), public.finish_program_balance_event(jsonb),
    public.claim_program_auto_topups(jsonb), public.claim_program_topup_checks(jsonb),
    public.release_program_topup(jsonb), public.program_balance_health()
  from public, anon, authenticated, service_role;
grant execute on function
    public.workspace_program_balance(uuid), public.workspace_program_balance_settings(uuid, jsonb)
  to authenticated;
grant execute on function
    public.open_program_balance(jsonb), public.attach_program_balance_customer(jsonb),
    public.begin_program_deposit(jsonb), public.find_program_topup(jsonb), public.attach_program_topup(jsonb),
    public.settle_program_topup(jsonb), public.reverse_program_topup(jsonb), public.save_program_balance_card(jsonb),
    public.record_program_balance_event(jsonb), public.finish_program_balance_event(jsonb),
    public.claim_program_auto_topups(jsonb), public.claim_program_topup_checks(jsonb),
    public.release_program_topup(jsonb), public.program_balance_health()
  to service_role;

commit;
