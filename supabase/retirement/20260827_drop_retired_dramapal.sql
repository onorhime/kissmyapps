begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

do $retirement_preflight$
declare
  expected_tables text[] := array[
    'adset_postbacks',
    'app_users',
    'apple_notification_events',
    'apple_transactions',
    'catalogue_snapshots',
    'coin_subscription_entitlements',
    'daily_reward_claims',
    'device_installs',
    'episode_unlocks',
    'favorites',
    'hosted_episodes',
    'hosted_series',
    'hosted_series_aliases',
    'idempotency_results',
    'planner_action_unlocks',
    'playback_grants',
    'playback_progress',
    'schema_migrations',
    'stripe_checkout_sessions',
    'stripe_customers',
    'stripe_subscriptions',
    'stripe_transactions',
    'stripe_webhook_events',
    'subscription_entitlements',
    'ticket_ledger',
    'ticket_wallets',
    'web_attributions',
    'web_exchange_tokens'
  ];
  missing_tables text[];
  unexpected_tables text[];
begin
  select array_agg(expected_table order by expected_table)
  into missing_tables
  from unnest(expected_tables) as expected_table
  where not exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and relation.relname = expected_table
  );

  select array_agg(relation.relname order by relation.relname)
  into unexpected_tables
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and not (relation.relname = any(expected_tables));

  if coalesce(cardinality(missing_tables), 0) > 0 then
    raise exception 'DramaPal retirement aborted: expected public tables are missing: %', missing_tables;
  end if;

  if coalesce(cardinality(unexpected_tables), 0) > 0 then
    raise exception 'DramaPal retirement aborted: unexpected public tables exist: %', unexpected_tables;
  end if;
end
$retirement_preflight$;

-- Every DramaPal table is named explicitly. RESTRICT is intentional: any
-- unreviewed dependency outside this list aborts the transaction.
drop table
  public.adset_postbacks,
  public.app_users,
  public.apple_notification_events,
  public.apple_transactions,
  public.catalogue_snapshots,
  public.coin_subscription_entitlements,
  public.daily_reward_claims,
  public.device_installs,
  public.episode_unlocks,
  public.favorites,
  public.hosted_episodes,
  public.hosted_series,
  public.hosted_series_aliases,
  public.idempotency_results,
  public.planner_action_unlocks,
  public.playback_grants,
  public.playback_progress,
  public.schema_migrations,
  public.stripe_checkout_sessions,
  public.stripe_customers,
  public.stripe_subscriptions,
  public.stripe_transactions,
  public.stripe_webhook_events,
  public.subscription_entitlements,
  public.ticket_ledger,
  public.ticket_wallets,
  public.web_attributions,
  public.web_exchange_tokens
restrict;

commit;
