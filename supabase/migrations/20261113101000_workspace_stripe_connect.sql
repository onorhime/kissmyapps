-- A merchant console workspace connects its own live Stripe account, with no admin
-- invitation. An owner or admin starts a one-use OAuth attempt, approves on Stripe, and
-- the workspace's merchant business gets its live connection.
--
-- Nothing here enables checkout, routing or transfers. OAuth codes, tokens and raw states
-- never reach the database: only the SHA-256 of the state and the account facts that the
-- Edge Function read from Stripe. Every function is service-role only; the
-- workspace-stripe-connect Edge Function passes the user it verified in p_input.
--
-- Callers tell failures apart by the DETAIL of the error, which is always one short code:
-- invalid_input, not_a_member, owner_or_admin_required, verified_email_required,
-- state_invalid, stripe_not_live, stripe_account_not_ready, stripe_account_in_use,
-- connection_in_use.
begin;

create table public.workspace_stripe_oauth_states (
  state_sha256 text primary key check (state_sha256 ~ '^[a-f0-9]{64}$'),
  workspace_id uuid not null references public.analytics_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform_account_id text not null check (platform_account_id ~ '^acct_[A-Za-z0-9]+$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  activated_at timestamptz,
  check (activated_at is null or consumed_at is not null)
);
create index workspace_stripe_oauth_states_workspace on public.workspace_stripe_oauth_states(workspace_id);
create index workspace_stripe_oauth_states_user on public.workspace_stripe_oauth_states(user_id);
alter table public.workspace_stripe_oauth_states enable row level security;
revoke all on public.workspace_stripe_oauth_states from public, anon, authenticated, service_role;

-- Internal helpers ------------------------------------------------------------------

create function kma_internal.workspace_stripe_uuid(p_value text) returns uuid
language sql immutable set search_path = '' as $$
  select case
    when p_value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then p_value::uuid
  end
$$;

create function kma_internal.workspace_stripe_role(p_workspace uuid, p_user uuid, p_manage boolean default false)
returns text language plpgsql stable set search_path = '' as $$
declare v_role text;
begin
  if p_workspace is null or p_user is null then
    raise exception 'A workspace and a signed-in user are required' using errcode = '22023', detail = 'invalid_input';
  end if;
  select role into v_role from public.analytics_workspace_members
  where workspace_id = p_workspace and user_id = p_user;
  if v_role is null then
    raise exception 'This account is not a member of the workspace' using errcode = '42501', detail = 'not_a_member';
  end if;
  if p_manage and v_role not in ('owner', 'admin') then
    raise exception 'Only a workspace owner or admin can change the Stripe connection'
      using errcode = '42501', detail = 'owner_or_admin_required';
  end if;
  return v_role;
end $$;

-- The acting user's confirmed address, which becomes the merchant business contact.
create function kma_internal.workspace_stripe_email(p_user uuid) returns text
language plpgsql stable set search_path = '' as $$
declare v_email text;
begin
  select lower(btrim(email)) into v_email from auth.users
  where id = p_user and email_confirmed_at is not null;
  if v_email is null or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
    raise exception 'A confirmed email address is required' using errcode = '42501', detail = 'verified_email_required';
  end if;
  return v_email;
end $$;

-- What the console may see. Pending and revoked connections read as "not connected".
create function kma_internal.workspace_stripe_connection(p_workspace uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'status', c.status, 'account_id', c.account_id,
    'business_name', coalesce(nullif(btrim(c.business_name), ''), b.business_name),
    'country', c.country, 'charges_enabled', c.charges_enabled, 'payouts_enabled', c.payouts_enabled,
    'details_submitted', c.details_submitted, 'connected_at', c.confirmed_at)
  from public.merchant_businesses b
  join public.merchant_connections c on c.merchant_id = b.id
  where b.workspace_id = p_workspace and c.livemode and c.status = 'active' and c.account_id is not null
$$;

-- Begin, activate and disconnect for one workspace run one at a time.
create function kma_internal.workspace_stripe_lock(p_workspace uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('workspace-stripe:' || p_workspace::text, 0))
$$;

-- Status ------------------------------------------------------------------------------

create function public.workspace_stripe_status(p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_workspace uuid := kma_internal.workspace_stripe_uuid(p_input->>'workspace_id');
  v_role text;
begin
  v_role := kma_internal.workspace_stripe_role(v_workspace, kma_internal.workspace_stripe_uuid(p_input->>'user_id'));
  return jsonb_build_object(
    'role', v_role,
    'can_manage', v_role in ('owner', 'admin'),
    'connection', kma_internal.workspace_stripe_connection(v_workspace));
end $$;

-- Start: a one-use state bound to the workspace, the user and the platform -----------

create function public.begin_workspace_stripe_connect(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace uuid := kma_internal.workspace_stripe_uuid(p_input->>'workspace_id');
  v_user uuid := kma_internal.workspace_stripe_uuid(p_input->>'user_id');
  v_state text := p_input->>'state_sha256';
  v_platform text := p_input->>'platform_account_id';
  v_expiry timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.workspace_stripe_role(v_workspace, v_user, true);
  perform kma_internal.workspace_stripe_email(v_user);
  begin
    v_expiry := (p_input->>'expires_at')::timestamptz;
  exception when others then
    v_expiry := null;
  end;
  if coalesce(v_state, '') !~ '^[a-f0-9]{64}$' or coalesce(v_platform, '') !~ '^acct_[A-Za-z0-9]+$'
    or v_expiry is null or v_expiry <= v_now
    or exists (select 1 from public.workspace_stripe_oauth_states where state_sha256 = v_state) then
    raise exception 'Invalid Stripe connection attempt' using errcode = '22023', detail = 'invalid_input';
  end if;
  -- Never longer than ten minutes by the database clock, whatever the caller's clock says.
  v_expiry := least(v_expiry, v_now + interval '10 minutes');
  perform kma_internal.workspace_stripe_lock(v_workspace);
  delete from public.workspace_stripe_oauth_states
  where workspace_id = v_workspace and expires_at < v_now - interval '1 day';
  -- Starting again ends every earlier attempt for this workspace that has not connected.
  update public.workspace_stripe_oauth_states set invalidated_at = v_now
  where workspace_id = v_workspace and invalidated_at is null and activated_at is null;
  insert into public.workspace_stripe_oauth_states(state_sha256, workspace_id, user_id, platform_account_id, expires_at, created_at)
  values (v_state, v_workspace, v_user, v_platform, v_expiry, v_now);
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
  values (v_user, 'system', 'workspace_stripe_connect_started', 'analytics_workspaces', v_workspace,
    jsonb_build_object('platform_account_id', v_platform, 'expires_at', v_expiry));
  return jsonb_build_object('workspace_id', v_workspace, 'expires_at', v_expiry);
end $$;

-- Return from Stripe: the state is used up before the code is exchanged ----------------

create function public.consume_workspace_stripe_oauth(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.workspace_stripe_oauth_states;
  v_user uuid := kma_internal.workspace_stripe_uuid(p_input->>'user_id');
  v_now timestamptz := clock_timestamp();
begin
  select * into s from public.workspace_stripe_oauth_states
  where state_sha256 = p_input->>'state_sha256' for update;
  if s.state_sha256 is null or v_user is null or s.user_id is distinct from v_user or s.expires_at <= v_now
    or s.consumed_at is not null or s.invalidated_at is not null then
    raise exception 'This Stripe connection attempt is no longer valid' using errcode = '42501', detail = 'state_invalid';
  end if;
  perform kma_internal.workspace_stripe_role(s.workspace_id, s.user_id, true);
  update public.workspace_stripe_oauth_states set consumed_at = v_now where state_sha256 = s.state_sha256;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
  values (s.user_id, 'system', 'workspace_stripe_connect_returned', 'analytics_workspaces', s.workspace_id,
    jsonb_build_object('platform_account_id', s.platform_account_id));
  return jsonb_build_object('workspace_id', s.workspace_id, 'platform_account_id', s.platform_account_id);
end $$;

-- Activate: the facts read from Stripe become the workspace's live connection ---------

create function public.activate_workspace_stripe_connection(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.workspace_stripe_oauth_states;
  b public.merchant_businesses;
  c public.merchant_connections;
  v_previous jsonb;
  v_state text := p_input->>'state_sha256';
  v_user uuid := kma_internal.workspace_stripe_uuid(p_input->>'user_id');
  v_platform text := p_input->>'platform_account_id';
  v_account text := p_input->>'account_id';
  v_name text := nullif(btrim(coalesce(p_input->>'business_name', '')), '');
  v_workspace uuid;
  v_workspace_name text;
  v_email text;
  v_now timestamptz := clock_timestamp();
begin
  -- Live only. Anything that is not exactly true is refused before any other check.
  if p_input->'livemode' is distinct from 'true'::jsonb then
    raise exception 'Only a live Stripe account can be connected' using errcode = '22023', detail = 'stripe_not_live';
  end if;
  -- Take the workspace lock before the state row, the same order as starting again.
  select workspace_id into v_workspace from public.workspace_stripe_oauth_states where state_sha256 = v_state;
  if v_workspace is not null then
    perform kma_internal.workspace_stripe_lock(v_workspace);
  end if;
  select * into s from public.workspace_stripe_oauth_states where state_sha256 = v_state for update;
  if s.state_sha256 is null or v_user is null or s.user_id is distinct from v_user or s.consumed_at is null
    or s.invalidated_at is not null or s.activated_at is not null or s.consumed_at <= v_now - interval '5 minutes' then
    raise exception 'This Stripe connection attempt is no longer valid' using errcode = '42501', detail = 'state_invalid';
  end if;
  perform kma_internal.workspace_stripe_role(s.workspace_id, s.user_id, true);
  v_email := kma_internal.workspace_stripe_email(s.user_id);
  if v_platform is distinct from s.platform_account_id
    or coalesce(v_account, '') !~ '^acct_[A-Za-z0-9]+$' or v_account = v_platform
    or coalesce(p_input->>'country', '') !~ '^[A-Z]{2}$'
    or jsonb_typeof(p_input->'charges_enabled') is distinct from 'boolean'
    or jsonb_typeof(p_input->'payouts_enabled') is distinct from 'boolean'
    or jsonb_typeof(p_input->'details_submitted') is distinct from 'boolean' then
    raise exception 'The Stripe account facts do not match this connection attempt' using errcode = '22023', detail = 'invalid_input';
  end if;
  if not (p_input->>'charges_enabled')::boolean or not (p_input->>'details_submitted')::boolean then
    raise exception 'Finish setting up the Stripe account before connecting it'
      using errcode = '55000', detail = 'stripe_account_not_ready';
  end if;
  -- Stripe accounts without a business name are read as their own account ID. That is not
  -- a name: the workspace's name stands in for it.
  if v_name = v_account then
    v_name := null;
  end if;
  -- One Stripe account belongs to one merchant business; two workspaces cannot race for it.
  perform pg_advisory_xact_lock(hashtextextended('workspace-stripe-account:' || v_account, 0));

  select * into b from public.merchant_businesses where workspace_id = s.workspace_id for update;
  if b.id is null then
    select name into v_workspace_name from public.analytics_workspaces where id = s.workspace_id;
    insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
    values (left(coalesce(v_name, btrim(v_workspace_name)), 160), v_email, s.user_id, s.workspace_id) returning * into b;
    insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
    values (s.user_id, 'system', 'workspace_merchant_business_created', 'merchant_businesses', b.id,
      jsonb_build_object('workspace_id', s.workspace_id, 'business_name', b.business_name));
  end if;
  if exists (
    select 1 from public.merchant_connections x
    where x.livemode and x.status = 'active' and x.account_id = v_account and x.merchant_id <> b.id
  ) then
    raise exception 'This Stripe account is already connected to another workspace'
      using errcode = '23505', detail = 'stripe_account_in_use';
  end if;

  select * into c from public.merchant_connections where merchant_id = b.id and livemode for update;
  if c.id is null then
    insert into public.merchant_connections(merchant_id, platform_account_id, livemode)
    values (b.id, v_platform, true) returning * into c;
  else
    v_previous := jsonb_build_object('status', c.status, 'account_id', c.account_id, 'platform_account_id', c.platform_account_id);
    -- Products stay with the account they were assigned to until an admin moves them.
    if c.account_id is not null and (c.account_id <> v_account or c.platform_account_id <> v_platform)
      and exists (select 1 from public.product_merchant_connections where connection_id = c.id) then
      raise exception 'Products are assigned to the Stripe account that is already connected'
        using errcode = '55000', detail = 'connection_in_use';
    end if;
  end if;
  begin
    update public.merchant_connections set
      platform_account_id = v_platform, account_id = v_account, status = 'active',
      business_name = left(v_name, 200), country = p_input->>'country',
      charges_enabled = (p_input->>'charges_enabled')::boolean,
      payouts_enabled = (p_input->>'payouts_enabled')::boolean,
      details_submitted = (p_input->>'details_submitted')::boolean,
      confirmed_by = s.user_id, confirmed_at = v_now, verified_at = v_now, revoked_at = null
    where id = c.id returning * into c;
  exception when unique_violation then
    raise exception 'This Stripe account is already connected to another workspace'
      using errcode = '23505', detail = 'stripe_account_in_use';
  end;
  -- An admin invitation still waiting on this connection can no longer replace the account.
  update public.merchant_invitations set revoked_at = v_now
  where connection_id = c.id and confirmed_at is null and revoked_at is null;
  update public.workspace_stripe_oauth_states set activated_at = v_now where state_sha256 = s.state_sha256;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, before_data, after_data)
  values (s.user_id, 'system', 'workspace_stripe_connected', 'merchant_connections', c.id, v_previous,
    jsonb_build_object('workspace_id', s.workspace_id, 'merchant_id', b.id, 'status', c.status, 'account_id', c.account_id,
      'platform_account_id', c.platform_account_id, 'livemode', c.livemode));
  return jsonb_build_object(
    'workspace_id', s.workspace_id, 'merchant_id', b.id, 'connection_id', c.id, 'can_manage', true,
    'connection', kma_internal.workspace_stripe_connection(s.workspace_id));
end $$;

-- Disconnect ----------------------------------------------------------------------------

create function public.disconnect_workspace_stripe(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.merchant_connections;
  v_workspace uuid := kma_internal.workspace_stripe_uuid(p_input->>'workspace_id');
  v_user uuid := kma_internal.workspace_stripe_uuid(p_input->>'user_id');
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.workspace_stripe_role(v_workspace, v_user, true);
  perform kma_internal.workspace_stripe_lock(v_workspace);
  select c2.* into c from public.merchant_businesses b
  join public.merchant_connections c2 on c2.merchant_id = b.id
  where b.workspace_id = v_workspace and c2.livemode for update of c2;
  -- Nothing connected: asking again changes nothing and is not an error.
  if c.id is null or c.status <> 'active' then
    return jsonb_build_object('account_id', null, 'platform_account_id', null, 'disconnected', false);
  end if;
  if exists (select 1 from public.product_merchant_connections where connection_id = c.id) then
    raise exception 'Products are assigned to this Stripe connection'
      using errcode = '55000', detail = 'connection_in_use';
  end if;
  update public.merchant_connections set status = 'revoked', revoked_at = v_now where id = c.id returning * into c;
  update public.merchant_invitations set revoked_at = coalesce(revoked_at, v_now) where connection_id = c.id;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, before_data, after_data)
  values (v_user, 'system', 'workspace_stripe_disconnected', 'merchant_connections', c.id,
    jsonb_build_object('status', 'active', 'account_id', c.account_id),
    jsonb_build_object('workspace_id', v_workspace, 'merchant_id', c.merchant_id, 'status', c.status, 'account_id', c.account_id,
      'platform_account_id', c.platform_account_id, 'livemode', c.livemode));
  return jsonb_build_object('account_id', c.account_id, 'platform_account_id', c.platform_account_id, 'disconnected', true);
end $$;

-- Only the Edge Function's service role may call any of this ---------------------------

revoke all on function
  kma_internal.workspace_stripe_uuid(text),
  kma_internal.workspace_stripe_role(uuid, uuid, boolean),
  kma_internal.workspace_stripe_email(uuid),
  kma_internal.workspace_stripe_connection(uuid),
  kma_internal.workspace_stripe_lock(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  public.workspace_stripe_status(jsonb),
  public.begin_workspace_stripe_connect(jsonb),
  public.consume_workspace_stripe_oauth(jsonb),
  public.activate_workspace_stripe_connection(jsonb),
  public.disconnect_workspace_stripe(jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  public.workspace_stripe_status(jsonb),
  public.begin_workspace_stripe_connect(jsonb),
  public.consume_workspace_stripe_oauth(jsonb),
  public.activate_workspace_stripe_connection(jsonb),
  public.disconnect_workspace_stripe(jsonb)
to service_role;
commit;
