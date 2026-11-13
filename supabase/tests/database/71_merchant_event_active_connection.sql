-- A Stripe account released by one merchant and connected by another leaves a revoked
-- row and an active row for the same account. Account events must reach the active one.
begin;
set local time zone 'UTC';
create temporary table event_assertions(label text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Merchant event assertion failed: %', label; end if;
  insert into event_assertions values (label);
end $$;
create function pg_temp.event(overrides jsonb) returns jsonb language sql as $$
  select public.apply_merchant_connection_event(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'account_id', 'acct_Shared',
    'event_id', 'evt_shared_1', 'event_type', 'account.updated',
    'event_created', extract(epoch from clock_timestamp())::bigint,
    'payload_sha256', repeat('a', 64), 'provider_verified_at', clock_timestamp(),
    'charges_enabled', false, 'payouts_enabled', true, 'details_submitted', true) || overrides)
$$;

insert into auth.users(id, email, email_confirmed_at) values
  ('e7100000-0000-4000-8000-000000000001', 'first@owner.example', now()),
  ('e7100000-0000-4000-8000-000000000002', 'second@owner.example', now());
insert into public.merchant_businesses(id, business_name, email, created_by) values
  ('b7100000-0000-4000-8000-000000000001', 'First owner', 'first@owner.example', 'e7100000-0000-4000-8000-000000000001'),
  ('b7100000-0000-4000-8000-000000000002', 'Second owner', 'second@owner.example', 'e7100000-0000-4000-8000-000000000002');
-- The revoked row is inserted first, so an unordered pick would tend to find it.
insert into public.merchant_connections(id, merchant_id, platform_account_id, livemode, account_id, status,
    charges_enabled, payouts_enabled, details_submitted, confirmed_at, verified_at, revoked_at) values
  ('c7100000-0000-4000-8000-000000000001', 'b7100000-0000-4000-8000-000000000001', 'acct_KMAPlatform', true, 'acct_Shared',
    'revoked', true, true, true, now() - interval '2 days', now() - interval '2 days', now() - interval '1 day');
insert into public.merchant_connections(id, merchant_id, platform_account_id, livemode, account_id, status,
    charges_enabled, payouts_enabled, details_submitted, confirmed_at, verified_at) values
  ('c7100000-0000-4000-8000-000000000002', 'b7100000-0000-4000-8000-000000000002', 'acct_KMAPlatform', true, 'acct_Shared',
    'active', true, true, true, now() - interval '1 hour', now() - interval '1 hour');

select pg_temp.check(pg_temp.event('{}') @> '{"matched":true,"status":"active"}'::jsonb,
  'an account update is matched to the active connection');
select pg_temp.check((select not charges_enabled from public.merchant_connections where id = 'c7100000-0000-4000-8000-000000000002'),
  'the active connection takes the new capability');
select pg_temp.check((select charges_enabled and status = 'revoked' from public.merchant_connections where id = 'c7100000-0000-4000-8000-000000000001'),
  'the revoked connection is left as it was');

select pg_temp.check(pg_temp.event('{"event_id":"evt_shared_2","event_type":"account.application.deauthorized"}')
    @> '{"matched":true,"status":"revoked"}'::jsonb,
  'removing the app at Stripe revokes the active connection');
select pg_temp.check((select status = 'revoked' and revoked_at > now() - interval '1 minute'
    from public.merchant_connections where id = 'c7100000-0000-4000-8000-000000000002'),
  'the connection that was active is now revoked');
select pg_temp.check((select revoked_at < now() - interval '12 hours' from public.merchant_connections where id = 'c7100000-0000-4000-8000-000000000001'),
  'the older revoked connection keeps its original revoke time');

select 'ok ' || count(*) || ' merchant event active connection assertions' from event_assertions;
rollback;
