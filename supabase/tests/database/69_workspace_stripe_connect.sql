-- Provider-free test of a workspace connecting Stripe by itself: an owner or admin starts
-- a one-use attempt, returns from Stripe, and the workspace gets its merchant business and
-- live connection. Stripe is never called: the account facts are passed in as the Edge
-- Function would pass them. Only the service role may call any of it.
begin;
set local time zone 'UTC';
create temporary table connect_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Workspace Stripe connect assertion failed: %', label; end if;
  insert into connect_assertions values (label);
end $$;
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$
  select value::uuid from qa where key = k
$$;
create function pg_temp.as_user(id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', id, 'role', 'authenticated')::text, true)
$$;
-- The SHA-256 the Edge Function would store for a raw state.
create function pg_temp.h(label text) returns text language sql as $$
  select encode(sha256(convert_to(label, 'utf8')), 'hex')
$$;
-- Calls one of the functions the way the Edge Function does: as the service role.
create function pg_temp.rpc(fn text, input jsonb) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  set local role service_role;
  execute format('select public.%I($1)', fn) into result using input;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- 'ok', or the SQLSTATE and the one-word reason the Edge Function maps to an error code.
create function pg_temp.rpc_fails(fn text, input jsonb) returns text language plpgsql as $$
declare reason text;
begin
  perform pg_temp.rpc(fn, input);
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return sqlstate || ' ' || coalesce(reason, '');
end $$;
create function pg_temp.status(workspace text, member text) returns jsonb language sql as $$
  select pg_temp.rpc('workspace_stripe_status', jsonb_build_object('workspace_id', pg_temp.q(workspace), 'user_id', pg_temp.q(member)))
$$;
create function pg_temp.begin_input(workspace text, member text, state text) returns jsonb language sql as $$
  select jsonb_build_object('workspace_id', pg_temp.q(workspace), 'user_id', pg_temp.q(member), 'state_sha256', pg_temp.h(state),
    'expires_at', clock_timestamp() + interval '10 minutes', 'platform_account_id', 'acct_Platform')
$$;
create function pg_temp.consume_input(member text, state text) returns jsonb language sql as $$
  select jsonb_build_object('user_id', pg_temp.q(member), 'state_sha256', pg_temp.h(state))
$$;
create function pg_temp.facts(member text, state text, account text) returns jsonb language sql as $$
  select jsonb_build_object('user_id', pg_temp.q(member), 'state_sha256', pg_temp.h(state), 'platform_account_id', 'acct_Platform',
    'livemode', true, 'account_id', account, 'business_name', 'Acme Trading Ltd', 'country', 'GB',
    'charges_enabled', true, 'payouts_enabled', false, 'details_submitted', true)
$$;
-- Start and return from Stripe, leaving a consumed state ready to activate.
create function pg_temp.authorise(workspace text, member text, state text) returns jsonb language plpgsql as $$
begin
  perform pg_temp.rpc('begin_workspace_stripe_connect', pg_temp.begin_input(workspace, member, state));
  return pg_temp.rpc('consume_workspace_stripe_oauth', pg_temp.consume_input(member, state));
end $$;
create function pg_temp.state(label text) returns public.workspace_stripe_oauth_states language sql as $$
  select s from public.workspace_stripe_oauth_states s where state_sha256 = pg_temp.h(label)
$$;
create function pg_temp.connection(workspace text) returns public.merchant_connections language sql as $$
  select c from public.merchant_businesses b join public.merchant_connections c on c.merchant_id = b.id
  where b.workspace_id = pg_temp.q(workspace) and c.livemode
$$;
create function pg_temp.audits(action_name text) returns bigint language sql as $$
  select count(*) from public.audit_logs where action = action_name
$$;
grant all on qa, connect_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('c9000000-0000-4000-8000-000000000001', 'owner@acme.example', now(), '{"company":"Acme"}'),
  ('c9000000-0000-4000-8000-000000000002', 'Admin@Acme.example', now(), '{}'),
  ('c9000000-0000-4000-8000-000000000003', 'developer@acme.example', now(), '{}'),
  ('c9000000-0000-4000-8000-000000000004', 'analyst@acme.example', now(), '{}'),
  ('c9000000-0000-4000-8000-000000000005', 'owner@other.example', now(), '{"company":"Other"}'),
  ('c9000000-0000-4000-8000-000000000006', 'unconfirmed@new.example', null, '{"company":"New"}'),
  ('c9000000-0000-4000-8000-000000000007', 'owner@linked.example', now(), '{"company":"Linked"}');
insert into qa values
  ('owner', 'c9000000-0000-4000-8000-000000000001'), ('admin', 'c9000000-0000-4000-8000-000000000002'),
  ('developer', 'c9000000-0000-4000-8000-000000000003'), ('analyst', 'c9000000-0000-4000-8000-000000000004'),
  ('other_owner', 'c9000000-0000-4000-8000-000000000005'), ('unconfirmed', 'c9000000-0000-4000-8000-000000000006'),
  ('linked_owner', 'c9000000-0000-4000-8000-000000000007');

-- Workspaces: Acme with every role, and three others with only an owner -----------------------
select pg_temp.as_user(pg_temp.q('owner'));
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select public.analytics_invite_member(pg_temp.q('acme'), 'admin@acme.example', 'admin');
select public.analytics_invite_member(pg_temp.q('acme'), 'developer@acme.example', 'developer');
select public.analytics_invite_member(pg_temp.q('acme'), 'analyst@acme.example', 'analyst');
select pg_temp.as_user(pg_temp.q('admin'));
select public.analytics_bootstrap();
select pg_temp.as_user(pg_temp.q('developer'));
select public.analytics_bootstrap();
select pg_temp.as_user(pg_temp.q('analyst'));
select public.analytics_bootstrap();
select pg_temp.as_user(pg_temp.q('other_owner'));
insert into qa select 'other', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.as_user(pg_temp.q('unconfirmed'));
insert into qa select 'new', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.as_user(pg_temp.q('linked_owner'));
insert into qa select 'linked', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select count(*) = 4 from public.analytics_workspace_members where workspace_id = pg_temp.q('acme')),
  'the workspace has an owner, an admin, a developer and an analyst');

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select bool_and(not has_table_privilege(r, 'public.workspace_stripe_oauth_states', p))
  from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
  and (select relrowsecurity from pg_class where oid = 'public.workspace_stripe_oauth_states'::regclass),
  'no API role can read or write the states table, and row security is on');
select pg_temp.check((select bool_and(not has_table_privilege(r, t, 'select'))
  from unnest(array['anon', 'authenticated']) r, unnest(array['public.merchant_businesses', 'public.merchant_connections']) t),
  'browsers cannot read merchant businesses or connections');
select pg_temp.check((select bool_and(has_function_privilege('service_role', f, 'execute')
    and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.workspace_stripe_status(jsonb)', 'public.begin_workspace_stripe_connect(jsonb)',
    'public.consume_workspace_stripe_oauth(jsonb)', 'public.activate_workspace_stripe_connection(jsonb)',
    'public.disconnect_workspace_stripe(jsonb)']) f), 'only the service role may call the five functions');
select pg_temp.check((select count(*) = 5 and bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('workspace_stripe_status', 'begin_workspace_stripe_connect',
    'consume_workspace_stripe_oauth', 'activate_workspace_stripe_connection', 'disconnect_workspace_stripe')),
  'each is a security definer function with an empty search path');
select pg_temp.check((select count(*) = 5 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and p.proname like 'workspace\_stripe\_%'), 'the internal helpers are closed to every API role');
select pg_temp.as_user(pg_temp.q('owner'));
set local role authenticated;
select pg_temp.check(pg_temp.fails(format('select public.workspace_stripe_status(%L)',
  jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner')))) like '42501%',
  'a signed-in owner cannot call status from the browser');
select pg_temp.check(pg_temp.fails(format('select public.begin_workspace_stripe_connect(%L)', pg_temp.begin_input('acme', 'owner', 'browser')))
  like '42501%', 'or start a connection');
select pg_temp.check(pg_temp.fails(format('select public.disconnect_workspace_stripe(%L)',
  jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner')))) like '42501%', 'or disconnect');
select pg_temp.check(pg_temp.fails('select * from public.workspace_stripe_oauth_states') like '42501%', 'or read the states');
select pg_temp.check(pg_temp.fails('select * from public.merchant_connections') like '42501%', 'or read connections');
reset role;
set local role anon;
select pg_temp.check(pg_temp.fails(format('select public.workspace_stripe_status(%L)',
  jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner')))) like '42501%', 'a visitor cannot call status');
select pg_temp.check(pg_temp.fails(format('select public.consume_workspace_stripe_oauth(%L)', pg_temp.consume_input('owner', 'browser')))
  like '42501%', 'or return from Stripe');
select pg_temp.check(pg_temp.fails(format('select public.activate_workspace_stripe_connection(%L)', pg_temp.facts('owner', 'browser', 'acct_Acme')))
  like '42501%', 'or activate a connection');
select pg_temp.check(pg_temp.fails('select * from public.workspace_stripe_oauth_states') like '42501%', 'or read the states');
reset role;
set local role service_role;
select pg_temp.check(pg_temp.fails('select * from public.workspace_stripe_oauth_states') like '42501%',
  'even the service role reads states only through the functions');
reset role;
select set_config('request.jwt.claims', '', true);

-- Status: every member reads it, only owners and admins manage ---------------------------------
select pg_temp.check(pg_temp.status('acme', 'owner') = '{"role":"owner","can_manage":true,"connection":null}'::jsonb,
  'the owner sees no connection and may manage it');
select pg_temp.check(pg_temp.status('acme', 'admin') = '{"role":"admin","can_manage":true,"connection":null}'::jsonb, 'so may an admin');
select pg_temp.check(pg_temp.status('acme', 'developer') = '{"role":"developer","can_manage":false,"connection":null}'::jsonb,
  'a developer sees the status but cannot manage');
select pg_temp.check(pg_temp.status('acme', 'analyst') = '{"role":"analyst","can_manage":false,"connection":null}'::jsonb, 'nor can an analyst');
select pg_temp.check(pg_temp.rpc_fails('workspace_stripe_status', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('other_owner')))
  = '42501 not_a_member', 'someone outside the workspace is refused');
select pg_temp.check(pg_temp.rpc_fails('workspace_stripe_status', jsonb_build_object('workspace_id', gen_random_uuid(), 'user_id', pg_temp.q('owner')))
  = '42501 not_a_member', 'an unknown workspace reads the same as not being a member');
select pg_temp.check((select bool_and(pg_temp.rpc_fails('workspace_stripe_status', x) = '22023 invalid_input') from unnest(array[
    '{}'::jsonb, jsonb_build_object('workspace_id', pg_temp.q('acme')), jsonb_build_object('user_id', pg_temp.q('owner')),
    jsonb_build_object('workspace_id', 'not-a-uuid', 'user_id', pg_temp.q('owner')),
    jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', 'x'' or true --')]) x),
  'a missing or malformed workspace or user is refused');

-- Start ----------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.rpc_fails('begin_workspace_stripe_connect', pg_temp.begin_input('acme', 'developer', 'a')) = '42501 owner_or_admin_required',
  'a developer cannot start a connection');
select pg_temp.check(pg_temp.rpc_fails('begin_workspace_stripe_connect', pg_temp.begin_input('acme', 'analyst', 'a')) = '42501 owner_or_admin_required',
  'nor can an analyst');
select pg_temp.check(pg_temp.rpc_fails('begin_workspace_stripe_connect', pg_temp.begin_input('acme', 'other_owner', 'a')) = '42501 not_a_member',
  'nor can another workspace''s owner');
select pg_temp.check(pg_temp.rpc_fails('begin_workspace_stripe_connect', pg_temp.begin_input('new', 'unconfirmed', 'a')) = '42501 verified_email_required',
  'an owner without a confirmed email cannot start');
select pg_temp.check((select bool_and(pg_temp.rpc_fails('begin_workspace_stripe_connect', pg_temp.begin_input('acme', 'owner', 'a') || x) = '22023 invalid_input')
  from unnest(array['{"state_sha256":"abc"}'::jsonb, jsonb_build_object('state_sha256', upper(pg_temp.h('a'))), '{"state_sha256":null}',
    '{"platform_account_id":"platform"}', '{"platform_account_id":null}', '{"expires_at":"soon"}', '{"expires_at":null}',
    jsonb_build_object('expires_at', clock_timestamp() - interval '1 second')]) x),
  'a malformed state, platform or expiry is refused');
select pg_temp.check((select count(*) = 0 from public.workspace_stripe_oauth_states) and pg_temp.audits('workspace_stripe_connect_started') = 0,
  'refused starts store nothing');
insert into qa select 'begin_a', pg_temp.rpc('begin_workspace_stripe_connect',
  pg_temp.begin_input('acme', 'owner', 'a') || jsonb_build_object('expires_at', clock_timestamp() + interval '1 hour'))::text;
select pg_temp.check((select (v->>'workspace_id')::uuid = pg_temp.q('acme')
    and (v->>'expires_at')::timestamptz between clock_timestamp() + interval '9 minutes' and clock_timestamp() + interval '10 minutes'
  from (select value::jsonb v from qa where key = 'begin_a') t), 'the owner starts; an attempt never lasts more than ten minutes');
select pg_temp.check((select s.workspace_id = pg_temp.q('acme') and s.user_id = pg_temp.q('owner') and s.platform_account_id = 'acct_Platform'
    and s.consumed_at is null and s.invalidated_at is null and s.activated_at is null
    and s.expires_at <= clock_timestamp() + interval '10 minutes'
  from pg_temp.state('a') s), 'the state is bound to the workspace, the user and the platform');
select pg_temp.check((select count(*) = 1 and bool_and(actor_user_id = pg_temp.q('owner') and target_table = 'analytics_workspaces'
    and target_id = pg_temp.q('acme') and after_data->>'platform_account_id' = 'acct_Platform')
  from public.audit_logs where action = 'workspace_stripe_connect_started'), 'starting is written to the audit log');
select pg_temp.check(pg_temp.rpc_fails('begin_workspace_stripe_connect', pg_temp.begin_input('acme', 'owner', 'a')) = '22023 invalid_input',
  'a state cannot be registered twice');

-- Returning from Stripe ---------------------------------------------------------------------------
select pg_temp.check(pg_temp.rpc_fails('consume_workspace_stripe_oauth', pg_temp.consume_input('admin', 'a')) = '42501 state_invalid',
  'another user, even an admin of the workspace, cannot use the owner''s state');
select pg_temp.check(pg_temp.rpc_fails('consume_workspace_stripe_oauth', pg_temp.consume_input('other_owner', 'a')) = '42501 state_invalid',
  'nor can an outsider');
select pg_temp.check((pg_temp.state('a')).consumed_at is null, 'a refused return leaves the state unused');
select pg_temp.check(pg_temp.rpc_fails('consume_workspace_stripe_oauth', pg_temp.consume_input('owner', 'never-started')) = '42501 state_invalid',
  'an unknown state is refused');
select pg_temp.check((select bool_and(pg_temp.rpc_fails('consume_workspace_stripe_oauth', x) = '42501 state_invalid') from unnest(array[
    '{}'::jsonb, jsonb_build_object('state_sha256', pg_temp.h('a')), jsonb_build_object('state_sha256', pg_temp.h('a'), 'user_id', 'nobody')]) x),
  'so is a return without a user');
select pg_temp.rpc('begin_workspace_stripe_connect', pg_temp.begin_input('acme', 'owner', 'b'));
select pg_temp.check((pg_temp.state('a')).invalidated_at is not null and (pg_temp.state('b')).invalidated_at is null,
  'starting again ends the earlier attempt');
select pg_temp.check(pg_temp.rpc_fails('consume_workspace_stripe_oauth', pg_temp.consume_input('owner', 'a')) = '42501 state_invalid',
  'the earlier state no longer works');
update public.workspace_stripe_oauth_states set expires_at = clock_timestamp() - interval '1 second' where state_sha256 = pg_temp.h('b');
select pg_temp.check(pg_temp.rpc_fails('consume_workspace_stripe_oauth', pg_temp.consume_input('owner', 'b')) = '42501 state_invalid',
  'an expired state is refused');
select pg_temp.rpc('begin_workspace_stripe_connect', pg_temp.begin_input('acme', 'admin', 'c'));
select pg_temp.check(pg_temp.rpc('consume_workspace_stripe_oauth', pg_temp.consume_input('admin', 'c'))
  = jsonb_build_object('workspace_id', pg_temp.q('acme'), 'platform_account_id', 'acct_Platform'),
  'the admin who started returns and learns the workspace and platform');
select pg_temp.check(pg_temp.rpc_fails('consume_workspace_stripe_oauth', pg_temp.consume_input('admin', 'c')) = '42501 state_invalid',
  'a state works once');
select pg_temp.check((select count(*) = 1 and bool_and(actor_user_id = pg_temp.q('admin') and target_id = pg_temp.q('acme'))
  from public.audit_logs where action = 'workspace_stripe_connect_returned'), 'the return is written to the audit log');

-- Activation: live, ready accounts only ---------------------------------------------------------
select pg_temp.check((select bool_and(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('admin', 'c', 'acct_Acme') || x) = '22023 stripe_not_live')
  from unnest(array['{"livemode":false}'::jsonb, '{"livemode":null}', '{"livemode":"true"}', '{"livemode":1}']) x)
  and pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('admin', 'c', 'acct_Acme') - 'livemode') = '22023 stripe_not_live',
  'anything but live mode is refused');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('admin', 'c', 'acct_Acme') || '{"charges_enabled":false}') = '55000 stripe_account_not_ready'
  and pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('admin', 'c', 'acct_Acme') || '{"details_submitted":false}') = '55000 stripe_account_not_ready',
  'an account that cannot take charges or has not finished its details is refused');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('owner', 'c', 'acct_Acme')) = '42501 state_invalid',
  'only the user who started may activate');
select pg_temp.check((select bool_and(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('admin', 'c', 'acct_Acme') || x) = '22023 invalid_input')
  from unnest(array['{"platform_account_id":"acct_Elsewhere"}'::jsonb, '{"account_id":"acct_Platform"}', '{"account_id":"merchant"}',
    '{"account_id":null}', '{"country":"gb"}', '{"country":"GBR"}', '{"charges_enabled":"true"}', '{"payouts_enabled":null}',
    '{"details_submitted":1}']) x), 'facts that do not match the attempt, or are malformed, are refused');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('admin', 'never-started', 'acct_Acme')) = '42501 state_invalid',
  'an unknown state cannot activate');
select pg_temp.check(not exists (select 1 from public.merchant_businesses where workspace_id is not null)
  and not exists (select 1 from public.merchant_connections) and (pg_temp.state('c')).activated_at is null,
  'refused activations create nothing');

insert into qa select 'activated', pg_temp.rpc('activate_workspace_stripe_connection', pg_temp.facts('admin', 'c', 'acct_Acme'))::text;
select pg_temp.check((select v->>'workspace_id' = pg_temp.q('acme')::text and v->'can_manage' = 'true'::jsonb
    and (v->'connection') - 'connected_at'::text = '{"status":"active","account_id":"acct_Acme","business_name":"Acme Trading Ltd","country":"GB","charges_enabled":true,"payouts_enabled":false,"details_submitted":true}'::jsonb
    and (v#>>'{connection,connected_at}')::timestamptz between clock_timestamp() - interval '1 minute' and clock_timestamp()
  from (select value::jsonb v from qa where key = 'activated') t), 'a live, ready account activates and comes back as the connection');
select pg_temp.check((select count(*) = 1 and bool_and(b.business_name = 'Acme Trading Ltd' and b.email = 'admin@acme.example'
    and b.created_by = pg_temp.q('admin') and b.id = (select (value::jsonb->>'merchant_id')::uuid from qa where key = 'activated'))
  from public.merchant_businesses b where b.workspace_id = pg_temp.q('acme')),
  'the workspace gets its merchant business, named by Stripe, with the acting user''s email');
select pg_temp.check((select c.status = 'active' and c.livemode and c.account_id = 'acct_Acme' and c.platform_account_id = 'acct_Platform'
    and c.business_name = 'Acme Trading Ltd' and c.country = 'GB' and c.charges_enabled and not c.payouts_enabled and c.details_submitted
    and c.confirmed_by = pg_temp.q('admin') and c.confirmed_at is not null and c.verified_at = c.confirmed_at and c.revoked_at is null
    and c.id = (select (value::jsonb->>'connection_id')::uuid from qa where key = 'activated')
  from pg_temp.connection('acme') c), 'and its live connection, active, with the facts read from Stripe');
select pg_temp.check((select count(*) = 1 from public.merchant_connections), 'exactly one connection exists, and none in test mode');
select pg_temp.check((pg_temp.state('c')).activated_at is not null, 'the state is marked as used for this connection');
select pg_temp.check((select count(*) = 1 and bool_and(actor_user_id = pg_temp.q('admin') and target_table = 'merchant_businesses'
    and after_data->>'workspace_id' = pg_temp.q('acme')::text)
  from public.audit_logs where action = 'workspace_merchant_business_created')
  and (select count(*) = 1 and bool_and(actor_user_id = pg_temp.q('admin') and target_table = 'merchant_connections'
    and target_id = (pg_temp.connection('acme')).id and before_data is null and after_data->>'account_id' = 'acct_Acme'
    and after_data->>'workspace_id' = pg_temp.q('acme')::text and after_data->'livemode' = 'true'::jsonb)
  from public.audit_logs where action = 'workspace_stripe_connected'), 'the new business and the connection are written to the audit log');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('admin', 'c', 'acct_Acme')) = '42501 state_invalid',
  'an activation cannot be replayed');
select pg_temp.check((select bool_and(pg_temp.status('acme', m)->'connection' = (select value::jsonb->'connection' from qa where key = 'activated'))
  from unnest(array['owner', 'admin', 'developer', 'analyst']) m)
  and pg_temp.status('acme', 'analyst')->'can_manage' = 'false'::jsonb, 'every member now sees the connection');
select pg_temp.check(pg_temp.status('other', 'other_owner')->'connection' = 'null'::jsonb, 'another workspace sees nothing of it');

-- An attempt must be returned before it activates, and soon after ---------------------------------
select pg_temp.rpc('begin_workspace_stripe_connect', pg_temp.begin_input('other', 'other_owner', 'o1'));
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('other_owner', 'o1', 'acct_Other')) = '42501 state_invalid',
  'a state that never came back from Stripe cannot activate');
select pg_temp.rpc('consume_workspace_stripe_oauth', pg_temp.consume_input('other_owner', 'o1'));
update public.workspace_stripe_oauth_states set consumed_at = clock_timestamp() - interval '6 minutes' where state_sha256 = pg_temp.h('o1');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('other_owner', 'o1', 'acct_Other')) = '42501 state_invalid',
  'nor can one that came back too long ago');

-- One Stripe account, one workspace ----------------------------------------------------------------
select pg_temp.authorise('other', 'other_owner', 'o2');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('other_owner', 'o2', 'acct_Acme')) = '23505 stripe_account_in_use',
  'a Stripe account connected to one workspace cannot be connected to another');
select pg_temp.check(not exists (select 1 from public.merchant_businesses where workspace_id = pg_temp.q('other'))
  and (pg_temp.connection('acme')).status = 'active', 'the refusal creates nothing and leaves the first workspace connected');
select pg_temp.check(pg_temp.rpc('activate_workspace_stripe_connection', pg_temp.facts('other_owner', 'o2', 'acct_Other') || '{"business_name":"acct_Other"}')
  #>> '{connection,business_name}' = 'Other', 'the other workspace connects its own account; one without a name on Stripe goes by the workspace name');
select pg_temp.check((select b.business_name = 'Other' and b.email = 'owner@other.example' from public.merchant_businesses b
  where b.workspace_id = pg_temp.q('other')) and (pg_temp.connection('other')).business_name is null, 'and gets its own merchant business');

-- Reconnecting with a different account -------------------------------------------------------------
insert into qa select 'acme_connection', (pg_temp.connection('acme')).id::text;
select pg_temp.authorise('acme', 'owner', 'd');
select pg_temp.check((pg_temp.rpc('activate_workspace_stripe_connection', pg_temp.facts('owner', 'd', 'acct_AcmeTwo') || '{"business_name":"Acme Two"}')
  #>> '{connection,account_id}') = 'acct_AcmeTwo', 'with no products assigned, a workspace may switch to a different account');
select pg_temp.check((select c.id = pg_temp.q('acme_connection') and c.account_id = 'acct_AcmeTwo' and c.status = 'active'
    and c.business_name = 'Acme Two' and c.confirmed_by = pg_temp.q('owner') from pg_temp.connection('acme') c)
  and (select count(*) = 1 and bool_and(business_name = 'Acme Trading Ltd' and email = 'admin@acme.example')
    from public.merchant_businesses where workspace_id = pg_temp.q('acme')),
  'the same connection now holds the new account, and the merchant business is kept as it was');
select pg_temp.check((select count(*) = 1 and bool_and(actor_user_id = pg_temp.q('owner')
    and before_data = '{"status":"active","account_id":"acct_Acme","platform_account_id":"acct_Platform"}'::jsonb)
  from public.audit_logs where action = 'workspace_stripe_connected' and target_id = pg_temp.q('acme_connection')
    and after_data->>'account_id' = 'acct_AcmeTwo'), 'the switch records the account it replaced');
select pg_temp.check(pg_temp.audits('workspace_merchant_business_created') = 2, 'no second merchant business is created for the workspace');

insert into public.products(id, slug, name) values ('c9000000-0000-4000-8000-0000000000a1', 'workspace-connect-fixture', 'Connect fixture');
insert into public.product_merchant_connections(product_id, livemode, connection_id, assigned_by)
values ('c9000000-0000-4000-8000-0000000000a1', true, pg_temp.q('acme_connection'), pg_temp.q('owner'));
select pg_temp.authorise('acme', 'owner', 'e');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('owner', 'e', 'acct_AcmeThree')) = '55000 connection_in_use',
  'once a product is assigned, switching to a different account is refused');
select pg_temp.check((select c.account_id = 'acct_AcmeTwo' and c.status = 'active' from pg_temp.connection('acme') c),
  'and the connection is unchanged');
select pg_temp.check((pg_temp.rpc('activate_workspace_stripe_connection', pg_temp.facts('owner', 'e', 'acct_AcmeTwo') || '{"payouts_enabled":true}')
  #> '{connection,payouts_enabled}') = 'true'::jsonb, 'reconnecting the same account stays allowed and refreshes its facts');

-- Disconnect -------------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.rpc_fails('disconnect_workspace_stripe', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('developer')))
  = '42501 owner_or_admin_required'
  and pg_temp.rpc_fails('disconnect_workspace_stripe', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('analyst')))
  = '42501 owner_or_admin_required', 'developers and analysts cannot disconnect');
select pg_temp.check(pg_temp.rpc_fails('disconnect_workspace_stripe', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('other_owner')))
  = '42501 not_a_member', 'nor can an outsider');
select pg_temp.check(pg_temp.rpc_fails('disconnect_workspace_stripe', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('admin')))
  = '55000 connection_in_use' and (pg_temp.connection('acme')).status = 'active', 'a connection with products assigned cannot be disconnected');
delete from public.product_merchant_connections where connection_id = pg_temp.q('acme_connection');
-- An admin invitation that was still waiting on this connection.
insert into public.merchant_invitations(merchant_id, connection_id, token_sha256, email, expires_at, created_by)
select c.merchant_id, c.id, pg_temp.h('invitation'), 'admin@acme.example', clock_timestamp() + interval '1 day', pg_temp.q('owner')
from pg_temp.connection('acme') c;
select pg_temp.check(pg_temp.rpc('disconnect_workspace_stripe', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('admin')))
  = '{"account_id":"acct_AcmeTwo","platform_account_id":"acct_Platform","disconnected":true}'::jsonb,
  'an admin disconnects and learns which Stripe account to deauthorise');
select pg_temp.check((select c.id = pg_temp.q('acme_connection') and c.status = 'revoked' and c.revoked_at is not null and c.account_id = 'acct_AcmeTwo'
  from pg_temp.connection('acme') c), 'the connection is revoked, not deleted');
select pg_temp.check((select revoked_at is not null from public.merchant_invitations where token_sha256 = pg_temp.h('invitation')),
  'a waiting invitation for it is revoked too');
select pg_temp.check((select count(*) = 1 and bool_and(actor_user_id = pg_temp.q('admin') and target_id = pg_temp.q('acme_connection')
    and before_data->>'status' = 'active' and after_data->>'status' = 'revoked' and after_data->>'account_id' = 'acct_AcmeTwo')
  from public.audit_logs where action = 'workspace_stripe_disconnected'), 'the disconnect is written to the audit log');
select pg_temp.check((select bool_and(pg_temp.status('acme', m)->'connection' = 'null'::jsonb) from unnest(array['owner', 'admin', 'developer', 'analyst']) m),
  'after disconnecting, every member sees no connection');
select pg_temp.check(pg_temp.rpc('disconnect_workspace_stripe', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner')))
  = '{"account_id":null,"platform_account_id":null,"disconnected":false}'::jsonb and pg_temp.audits('workspace_stripe_disconnected') = 1,
  'disconnecting again changes nothing');
select pg_temp.check(pg_temp.rpc('disconnect_workspace_stripe', jsonb_build_object('workspace_id', pg_temp.q('linked'), 'user_id', pg_temp.q('linked_owner')))
  ->'disconnected' = 'false'::jsonb, 'nor does disconnecting a workspace that never connected');

-- After a disconnect -----------------------------------------------------------------------------------
select pg_temp.authorise('other', 'other_owner', 'o3');
select pg_temp.check((pg_temp.rpc('activate_workspace_stripe_connection', pg_temp.facts('other_owner', 'o3', 'acct_AcmeTwo'))
  #>> '{connection,account_id}') = 'acct_AcmeTwo', 'a released Stripe account can be connected by another workspace');
select pg_temp.authorise('acme', 'owner', 'f');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('owner', 'f', 'acct_AcmeTwo')) = '23505 stripe_account_in_use',
  'and then no longer by the workspace that released it');
select pg_temp.check((pg_temp.rpc('activate_workspace_stripe_connection', pg_temp.facts('owner', 'f', 'acct_AcmeFour'))
  #>> '{connection,status}') = 'active', 'a disconnected workspace can connect again');
select pg_temp.check((select c.id = pg_temp.q('acme_connection') and c.status = 'active' and c.revoked_at is null and c.account_id = 'acct_AcmeFour'
  from pg_temp.connection('acme') c) and (select count(*) = 1 from public.merchant_connections c join public.merchant_businesses b on b.id = c.merchant_id
  where b.workspace_id = pg_temp.q('acme')), 'reconnecting reuses the workspace''s one live connection');

-- A merchant business an admin linked to the workspace -----------------------------------------------
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Linked Holdings', 'billing@linked.example', pg_temp.q('owner'), pg_temp.q('linked')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode)
select id, 'acct_AdminPlatform', l from business, unnest(array[true, false]) l;
select pg_temp.check(pg_temp.status('linked', 'linked_owner')->'connection' = 'null'::jsonb, 'a pending connection reads as not connected');
-- A merchant an admin connected the old way, on another platform account, with no workspace.
with business as (
  insert into public.merchant_businesses(business_name, email, created_by)
  values ('Admin Run Ltd', 'ops@adminrun.example', pg_temp.q('owner')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, charges_enabled, details_submitted)
select id, 'acct_AdminPlatform', true, 'acct_AdminRun', 'active', true, true from business;
select pg_temp.authorise('linked', 'linked_owner', 'l1');
select pg_temp.check(pg_temp.rpc_fails('activate_workspace_stripe_connection', pg_temp.facts('linked_owner', 'l1', 'acct_AdminRun')) = '23505 stripe_account_in_use',
  'a Stripe account an admin connected for another merchant is in use, whichever platform connected it');
select pg_temp.check((pg_temp.rpc('activate_workspace_stripe_connection', pg_temp.facts('linked_owner', 'l1', 'acct_Linked'))
  #>> '{connection,business_name}') = 'Acme Trading Ltd', 'the workspace owner connects the business an admin linked');
select pg_temp.authorise('linked', 'linked_owner', 'l2');
select pg_temp.check((pg_temp.rpc('activate_workspace_stripe_connection', pg_temp.facts('linked_owner', 'l2', 'acct_Linked') || '{"business_name":null}')
  #>> '{connection,business_name}') = 'Linked Holdings', 'without a name on Stripe, the connection goes by the linked business name');
select pg_temp.check((select count(*) = 1 and bool_and(business_name = 'Linked Holdings' and email = 'billing@linked.example')
    from public.merchant_businesses where workspace_id = pg_temp.q('linked'))
  and (select c.platform_account_id = 'acct_Platform' and c.status = 'active' and c.account_id = 'acct_Linked' from pg_temp.connection('linked') c)
  and (select c.status = 'pending' and c.account_id is null and c.platform_account_id = 'acct_AdminPlatform'
    from public.merchant_connections c join public.merchant_businesses b on b.id = c.merchant_id
    where b.workspace_id = pg_temp.q('linked') and not c.livemode),
  'the linked business is reused as it is; only its live connection changes');

-- Housekeeping ------------------------------------------------------------------------------------------
update public.workspace_stripe_oauth_states set expires_at = clock_timestamp() - interval '2 days' where state_sha256 = pg_temp.h('a');
select pg_temp.rpc('begin_workspace_stripe_connect', pg_temp.begin_input('acme', 'owner', 'g'));
select pg_temp.check((pg_temp.state('a')).state_sha256 is null and (pg_temp.state('f')).activated_at is not null
  and (pg_temp.state('f')).invalidated_at is null and (pg_temp.state('e')).invalidated_at is null,
  'starting clears long-expired states; a state that connected is never invalidated');
select pg_temp.as_user(pg_temp.q('owner'));
select public.analytics_remove_member(pg_temp.q('acme'), pg_temp.q('admin'));
select set_config('request.jwt.claims', '', true);
select pg_temp.check(pg_temp.rpc_fails('workspace_stripe_status', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('admin')))
  = '42501 not_a_member'
  and pg_temp.rpc_fails('disconnect_workspace_stripe', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('admin')))
  = '42501 not_a_member', 'a removed admin loses access at once');
select pg_temp.check((select bool_and(actor_type = 'system' and actor_user_id is not null) and count(*) >= 20 from public.audit_logs
  where action like 'workspace\_stripe\_%' or action = 'workspace_merchant_business_created'),
  'every change names the user who made it');

select 'ok ' || count(*) || ' workspace stripe connect assertions' from connect_assertions;
rollback;
