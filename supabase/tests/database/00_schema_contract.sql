begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

select no_plan();

select has_table('public', 'products', 'products table exists');
select has_table('public', 'profiles', 'auth profile table exists');
select has_table('public', 'affiliates', 'affiliate workspace table exists');
select has_table('public', 'affiliate_users', 'affiliate membership table exists');
select has_table('public', 'affiliate_settings', 'per-user affiliate settings table exists');
select has_table('public', 'affiliate_links', 'issued link table exists');
select has_table('public', 'clicks', 'canonical click table exists');
select has_table('public', 'acquisitions', 'canonical acquisition bridge exists');
select has_table('public', 'provider_events', 'immutable provider event inbox exists');
select has_table('public', 'provider_event_processing', 'provider processing state is separate');
select has_table('public', 'events', 'idempotent canonical events exist');
select has_table('public', 'commission_rules', 'versioned commission rules exist');
select has_table('public', 'commission_entries', 'append-only commission ledger exists');
select has_table('public', 'payout_destinations', 'versioned payout destination history exists');
select has_table('public', 'payout_destination_events', 'payout destination event history exists');
select has_table('public', 'payouts', 'payout lifecycle table exists');
select has_table('public', 'payout_agreement_snapshots', 'payout agreement snapshots exist');
select has_table('public', 'affiliate_daily_metrics', 'partner-safe reporting aggregate exists');
select has_table('public', 'audit_logs', 'audit history exists');
select has_table('public', 'reconciliation_runs', 'reconciliation runs exist');
select has_table('public', 'reconciliation_exceptions', 'reconciliation exception queue exists');

select has_view('public', 'partner_profile', 'partner profile allowlist exists');
select has_view('public', 'partner_product_directory', 'partner product allowlist exists');
select has_view('public', 'partner_link_option_directory', 'partner link-option allowlist exists');
select has_view('public', 'partner_link_directory', 'partner link allowlist exists');
select has_view('public', 'partner_payout_summary', 'partner payout summary allowlist exists');
select has_view('public', 'partner_payout_history', 'partner payout history allowlist exists');
select has_view('public', 'partner_document_directory', 'partner document allowlist exists');
select has_view('public', 'partner_agreement_directory', 'partner agreement allowlist exists');

select columns_are(
  'public', 'partner_profile',
  array[
    'email', 'full_name', 'public_name', 'legal_name', 'entity_type', 'country_code',
    'timezone', 'preferred_currency', 'website', 'category', 'audience_description',
    'audience_countries', 'channels', 'channel_details', 'role', 'status', 'notifications'
  ],
  'profile view has only the browser contract columns'
);
select columns_are(
  'public', 'partner_product_directory',
  array[
    'id', 'slug', 'name', 'status', 'agreement_status', 'commercial_model',
    'payout_currency', 'has_live_funnel', 'main_tracking_url'
  ],
  'product view has only the browser contract columns'
);
select columns_are(
  'public', 'partner_link_option_directory',
  array['id', 'kind', 'product_id', 'key', 'name', 'available'],
  'link-option view has only the browser contract columns'
);
select columns_are(
  'public', 'partner_link_directory',
  array[
    'id', 'name', 'product_id', 'product_name', 'product_slug', 'funnel_id',
    'funnel_name', 'source_id', 'source_name', 'campaign_id', 'campaign_name',
    'sub1', 'sub2', 'sub3', 'status', 'tracking_url', 'parent_link_id', 'clicks',
    'leads', 'installs', 'purchases', 'earnings_minor', 'currency', 'created_at'
  ],
  'link view has only the browser contract columns'
);
select columns_are(
  'public', 'partner_payout_summary',
  array[
    'currency', 'open_minor', 'approved_minor', 'scheduled_minor', 'paid_minor',
    'carried_forward_minor', 'next_expected_payment_at', 'product_id'
  ],
  'payout summary exposes only values plus its product filter key'
);
select columns_are(
  'public', 'partner_payout_history',
  array[
    'id', 'product_name', 'period_starts_at', 'period_ends_at',
    'expected_payment_at', 'status', 'eligible_net_minor', 'earnings_minor',
    'adjustments_minor', 'final_payout_minor', 'currency', 'statement_number',
    'statement_available', 'payment_method', 'payment_reference', 'paid_at', 'product_id'
  ],
  'payout history exposes only partner facts plus its product filter key'
);
select columns_are(
  'public', 'partner_document_directory',
  array[
    'id', 'name', 'document_type', 'version', 'status', 'created_at',
    'effective_at', 'expires_at', 'terminated_at', 'partner_signed_at',
    'company_signed_at', 'supersedes_document_id', 'superseded_by_document_id',
    'download_available', 'product_id'
  ],
  'document view omits private object paths'
);
select columns_are(
  'public', 'partner_agreement_directory',
  array[
    'product_id', 'product_name', 'version', 'model', 'status',
    'attribution_window_days', 'renewal_duration_days', 'payout_frequency_days',
    'payout_currency', 'minimum_payout_minor', 'starts_at', 'ends_at', 'rules'
  ],
  'agreement view exposes the read-only commercial contract'
);

select has_column('public', 'affiliate_links', 'sub1', 'links persist sub1');
select has_column('public', 'affiliate_users', 'activation_pending', 'memberships persist pending activation');
select has_column('public', 'affiliate_users', 'activated_at', 'memberships persist completed activation');
select col_default_is('public', 'affiliate_users', 'active', 'false', 'new memberships fail closed');
select has_column('public', 'affiliate_links', 'sub2', 'links persist sub2');
select has_column('public', 'affiliate_links', 'sub3', 'links persist sub3');
select has_column('public', 'affiliate_links', 'status', 'links persist lifecycle status');
select has_column('public', 'affiliate_links', 'is_main', 'links identify the canonical partner-product main link');
select has_column('public', 'funnels', 'is_default', 'funnels identify the sole product default');
select has_column('public', 'platform_settings', 'tracking_enabled', 'production tracking has an explicit kill switch');
select col_default_is(
  'public', 'platform_settings', 'tracking_enabled', 'false',
  'production tracking fails closed by default'
);
select has_column('public', 'clicks', 'public_click_id', 'clicks use an explicit public click identifier');
select has_column('public', 'clicks', 'sub1', 'clicks snapshot sub1 at redirect time');
select has_column('public', 'clicks', 'sub2', 'clicks snapshot sub2 at redirect time');
select has_column('public', 'clicks', 'sub3', 'clicks snapshot sub3 at redirect time');
select has_column('public', 'clicks', 'destination_url_snapshot', 'clicks snapshot the exact resolved destination');
select has_column('public', 'acquisitions', 'click_record_id', 'acquisitions use an explicit click row foreign key');
select hasnt_column('public', 'acquisitions', 'click_id', 'ambiguous acquisition click_id is absent');
select has_column('public', 'events', 'source_event_id', 'events have an idempotency identifier');
select has_column('public', 'events', 'schema_version', 'events have a schema version');
select has_column('public', 'events', 'trust', 'events record their evidence trust boundary');
select has_column('public', 'events', 'commercial_eligible', 'events explicitly declare commercial eligibility');
select has_column('public', 'commission_rules', 'version', 'commission rules are versioned');
select has_column('public', 'commission_entries', 'source_payout_id', 'carry entries identify their source payout');
select has_column('public', 'payouts', 'calculation_finalized_at', 'payouts record finalization');
select has_column('public', 'payouts', 'approved_by', 'payouts record approval actor');
select has_column('public', 'payouts', 'payout_destination_id', 'payouts reference destination history');
select has_column('public', 'payouts', 'held_from_status', 'payout holds remember the exact resume state');
select has_column('public', 'payouts', 'reconciliation_run_id', 'finalized payouts reference reconciliation evidence');
select has_column('public', 'affiliate_daily_metrics', 'completeness', 'reporting facts declare completeness');
select has_column('public', 'affiliate_daily_metrics', 'reconciliation_stage', 'reporting facts declare reconciliation stage');
select has_column('public', 'affiliate_daily_metrics', 'is_subscription_snapshot', 'current subscriptions are an explicit non-additive snapshot');

select ok(
  not exists (
    select 1
    from pg_enum as value
    join pg_type as enum_type on enum_type.oid = value.enumtypid
    join pg_namespace as namespace on namespace.oid = enum_type.typnamespace
    where namespace.nspname = 'public'
      and enum_type.typname in ('event_source', 'provider_name')
      and value.enumlabel = 'amplitude'
  ),
  'Amplitude is not an inbound canonical event or provider source'
);

select has_function(
  'public', 'get_partner_dashboard_summary',
  array['uuid', 'date', 'date', 'text', 'uuid', 'uuid', 'uuid', 'text', 'text'],
  'dashboard summary RPC has the gateway signature'
);
select has_function(
  'public', 'get_partner_dashboard_trends',
  array['uuid', 'date', 'date', 'text', 'uuid', 'uuid', 'uuid', 'text', 'text', 'text', 'text'],
  'dashboard trends RPC has the gateway signature'
);
select has_function('public', 'get_partner_payout_detail', array['uuid'], 'payout detail RPC exists');
select has_function('public', 'create_partner_link', array['jsonb'], 'create-link RPC exists');
select has_function('public', 'update_partner_link', array['uuid', 'jsonb'], 'update-link RPC exists');
select has_function('public', 'set_partner_link_status', array['uuid', 'link_status'], 'link-status RPC exists');
select has_function('public', 'update_partner_profile', array['jsonb'], 'profile update RPC exists');
select has_function('public', 'update_partner_settings', array['jsonb'], 'settings update RPC exists');
select has_function(
  'public', 'get_admin_context', array[]::text[],
  'admin context RPC exists'
);
select has_function(
  'public', 'get_admin_products', array[]::text[],
  'admin product-directory RPC exists'
);
select has_function(
  'public', 'create_admin_product', array['jsonb'],
  'admin draft-product creation RPC exists'
);
select has_function(
  'public', 'current_partner_activation_status', array[]::text[],
  'current activation status RPC exists'
);
select has_function(
  'public', 'complete_partner_activation', array[]::text[],
  'password-proven partner activation RPC exists'
);
select has_function(
  'public', 'register_tracking_click', array['text', 'text', 'jsonb'],
  'atomic redirect click-registration RPC exists'
);
select has_function(
  'public', 'ingest_browser_event', array['jsonb'],
  'browser event-ingestion RPC exists'
);
select has_function(
  'public', 'ingest_funnel_event', array['jsonb'],
  'trusted funnel event-ingestion RPC exists'
);
select has_function('public', 'get_admin_affiliates', array[]::text[], 'admin partner directory RPC exists');
select has_function('public', 'get_admin_sources', array[]::text[], 'admin source directory RPC exists');
select has_function('public', 'get_admin_product_configuration', array['uuid'], 'admin product configuration RPC exists');
select has_function('public', 'configure_admin_tracking', array['jsonb'], 'admin tracking configuration RPC exists');
select has_function('public', 'create_admin_funnel', array['jsonb'], 'admin funnel creation RPC exists');
select has_function('public', 'update_admin_funnel', array['jsonb'], 'admin funnel update RPC exists');
select has_function('public', 'set_admin_funnel_status', array['jsonb'], 'admin funnel status RPC exists');
select has_function('public', 'create_admin_source', array['jsonb'], 'admin source creation RPC exists');
select has_function('public', 'archive_admin_source', array['uuid'], 'admin source archival RPC exists');
select has_function('public', 'create_admin_campaign', array['jsonb'], 'admin campaign creation RPC exists');
select has_function('public', 'set_admin_campaign_status', array['jsonb'], 'admin campaign status RPC exists');
select has_function('public', 'create_admin_agreement', array['jsonb'], 'admin agreement creation RPC exists');
select has_function('public', 'create_admin_commission_rule', array['jsonb'], 'admin commission-rule creation RPC exists');
select has_function('public', 'set_admin_commission_rule_status', array['jsonb'], 'admin commission-rule status RPC exists');
select has_function('public', 'activate_admin_agreement', array['jsonb'], 'admin agreement activation RPC exists');
select has_function('public', 'activate_admin_product', array['jsonb'], 'admin product activation RPC exists');
select has_function('public', 'issue_admin_main_link', array['jsonb'], 'admin canonical main-link RPC exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.affiliates'::regclass),
  'affiliate workspaces use row-level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.affiliate_links'::regclass),
  'affiliate links use row-level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.commission_entries'::regclass),
  'commission entries use row-level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.payouts'::regclass),
  'payouts use row-level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.audit_logs'::regclass),
  'audit logs use row-level security'
);

select ok(
  not has_schema_privilege('authenticated', 'public', 'CREATE'),
  'authenticated users cannot create objects in public'
);
select ok(
  not has_schema_privilege('anon', 'public', 'USAGE'),
  'anonymous users cannot use the application schema'
);
select ok(
  not has_table_privilege('authenticated', 'public.affiliate_links', 'SELECT'),
  'browser users cannot select the raw affiliate-link table'
);
select ok(
  not has_table_privilege('authenticated', 'public.clicks', 'SELECT'),
  'browser users cannot select raw clicks'
);
select ok(
  not has_table_privilege('authenticated', 'public.acquisitions', 'SELECT'),
  'browser users cannot select acquisitions'
);
select ok(
  not has_table_privilege('authenticated', 'public.accounts', 'SELECT'),
  'browser users cannot select customer accounts'
);
select ok(
  not has_table_privilege('authenticated', 'public.provider_events', 'SELECT'),
  'browser users cannot select provider payloads'
);
select ok(
  not has_table_privilege('authenticated', 'public.commission_entries', 'SELECT'),
  'browser users cannot select internal ledger columns'
);
select ok(
  not has_table_privilege('authenticated', 'public.payout_destinations', 'SELECT'),
  'browser users cannot select payout provider references'
);
select ok(
  not has_table_privilege('authenticated', 'public.documents', 'SELECT'),
  'browser users cannot select private document paths'
);
select ok(
  has_table_privilege('authenticated', 'public.partner_link_directory', 'SELECT'),
  'browser users can select the link allowlist'
);
select ok(
  has_table_privilege('authenticated', 'public.partner_payout_history', 'SELECT'),
  'browser users can select payout history allowlist'
);
select ok(
  not has_table_privilege('anon', 'public.partner_profile', 'SELECT'),
  'anonymous users cannot select partner views'
);

select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join unnest(array['public', 'authenticated', 'anon']::text[]) as checked_role(role_name)
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and (
        has_table_privilege(checked_role.role_name, relation.oid, 'SELECT')
        or has_table_privilege(checked_role.role_name, relation.oid, 'INSERT')
        or has_table_privilege(checked_role.role_name, relation.oid, 'UPDATE')
        or has_table_privilege(checked_role.role_name, relation.oid, 'DELETE')
        or has_table_privilege(checked_role.role_name, relation.oid, 'TRUNCATE')
        or has_table_privilege(checked_role.role_name, relation.oid, 'REFERENCES')
        or has_table_privilege(checked_role.role_name, relation.oid, 'TRIGGER')
      )
  ),
  0::bigint,
  'PUBLIC, authenticated, and anonymous roles have zero direct privileges on every public base table'
);
select is(
  (
    select array_agg(relation.relname::text order by relation.relname::text)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('v', 'm')
      and has_table_privilege('authenticated', relation.oid, 'SELECT')
  ),
  array[
    'partner_agreement_directory', 'partner_document_directory',
    'partner_link_directory', 'partner_link_option_directory',
    'partner_payout_history', 'partner_payout_summary',
    'partner_product_directory', 'partner_profile'
  ]::text[],
  'authenticated SELECT is exactly the eight browser allowlist views'
);

select ok(
  has_function_privilege('authenticated', 'public.get_partner_dashboard_summary(uuid,date,date,text,uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'browser users can execute the summary RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.create_partner_link(jsonb)', 'EXECUTE'),
  'browser users can execute the constrained create-link RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.register_tracking_click(text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.ingest_browser_event(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.ingest_funnel_event(jsonb)', 'EXECUTE'),
  'authenticated browsers cannot execute service ingestion boundaries'
);
select ok(
  has_function_privilege('service_role', 'public.register_tracking_click(text,text,jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.ingest_browser_event(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.ingest_funnel_event(jsonb)', 'EXECUTE'),
  'only the Edge service role receives the tracking-ingestion RPC grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.products', 'SELECT')
  and not has_table_privilege('authenticated', 'public.products', 'INSERT')
  and not has_table_privilege('authenticated', 'public.products', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.products', 'DELETE'),
  'browser users have no direct product-table privileges'
);
select ok(
  not has_function_privilege('authenticated', 'public.audit_mutation()', 'EXECUTE'),
  'browser users cannot call the audit writer'
);
select ok(
  not has_function_privilege('authenticated', 'public.reject_mutation()', 'EXECUTE'),
  'browser users cannot call internal trigger helpers'
);
select is(
  (
    select array_agg(
      (function.oid::regprocedure)::text
      order by (function.oid::regprocedure)::text collate "C"
    )
    from pg_proc as function
    join pg_namespace as namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege('authenticated', function.oid, 'EXECUTE')
  ),
  array[
    'activate_admin_agreement(jsonb)',
    'activate_admin_product(jsonb)',
    'advance_admin_payout_period(jsonb)',
    'archive_admin_source(uuid)',
    'complete_partner_activation()',
    'configure_admin_tracking(jsonb)',
    'create_admin_agreement(jsonb)',
    'create_admin_billing_offer(jsonb)',
    'create_admin_campaign(jsonb)',
    'create_admin_commission_rule(jsonb)',
    'create_admin_funnel(jsonb)',
    'create_admin_payout_period(jsonb)',
    'create_admin_product(jsonb)',
    'create_admin_source(jsonb)',
    'create_partner_link(jsonb)',
    'current_partner_activation_status()',
    'current_user_can_download_storage_object(text,text)',
    'current_user_can_view_product(uuid)',
    'current_user_has_affiliate(uuid)',
    'current_user_has_affiliate_role(uuid,text[],boolean)',
    'current_user_is_admin()',
    'current_user_is_admin(text[])',
    'get_admin_affiliates()',
    'get_admin_billing_offer_verification_candidate(uuid)',
    'get_admin_context()',
    'get_admin_product_configuration(uuid)',
    'get_admin_products()',
    'get_admin_sources()',
    'get_partner_dashboard_summary(uuid,date,date,text,uuid,uuid,uuid,text,text)',
    'get_partner_dashboard_trends(uuid,date,date,text,uuid,uuid,uuid,text,text,text,text)',
    'get_partner_payout_detail(uuid)',
    'issue_admin_main_link(jsonb)',
    'prepare_admin_payout_statements(jsonb)',
    'set_admin_billing_offer_status(jsonb)',
    'set_admin_campaign_status(jsonb)',
    'set_admin_commission_rule_status(jsonb)',
    'set_admin_funnel_status(jsonb)',
    'set_partner_link_status(uuid,link_status)',
    'storage_path_affiliate_id(text)',
    'update_admin_billing_offer(jsonb)',
    'update_admin_funnel(jsonb)',
    'update_partner_link(uuid,jsonb)',
    'update_partner_profile(jsonb)',
    'update_partner_settings(jsonb)'
  ]::text[],
  'authenticated EXECUTE is exactly the approved policy helpers and browser RPCs'
);
select is(
  (
    select count(*)
    from pg_proc as function
    join pg_namespace as namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and (
        has_function_privilege('public', function.oid, 'EXECUTE')
        or has_function_privilege('anon', function.oid, 'EXECUTE')
      )
  ),
  0::bigint,
  'PUBLIC and anonymous roles cannot execute any public-schema function'
);
select is(
  (
    select count(*)
    from pg_proc as function
    join pg_namespace as namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.prosecdef
      and not coalesce('search_path=""' = any(function.proconfig), false)
  ),
  0::bigint,
  'every SECURITY DEFINER function pins an empty search_path'
);

select has_trigger('public', 'commission_entries', 'commission_entries_are_append_only', 'commission ledger is append-only');
select has_trigger('public', 'transactions', 'transactions_are_append_only', 'transactions are append-only');
select has_trigger('public', 'transactions', 'transactions_validate_identity', 'canonical transactions validate subscription and provider identity');
select has_trigger('public', 'refunds', 'refunds_are_append_only', 'refunds are append-only');
select has_trigger('public', 'refunds', 'refunds_validate_identity', 'refunds validate Stripe event and transaction identity');
select has_trigger('public', 'disputes', 'disputes_are_append_only', 'disputes are append-only');
select has_trigger('public', 'disputes', 'disputes_validate_identity', 'disputes validate Stripe event and transaction identity');
select has_trigger('public', 'conversions', 'conversions_are_append_only', 'conversions are append-only');
select has_trigger('public', 'subscriptions', 'subscriptions_validate_identity', 'subscription identity is protected');
select has_trigger('public', 'entitlements', 'entitlements_validate_identity', 'entitlement identity is protected');
select has_trigger('public', 'provider_events', 'provider_events_are_append_only', 'provider payloads are append-only');
select has_trigger('public', 'events', 'events_validate_identity', 'canonical events validate acquisition and trust identity');
select has_trigger('public', 'payouts', 'payouts_protect_history', 'payout history is protected');
select has_trigger('public', 'payout_destinations', 'payout_destinations_protect_history', 'destination history is protected');
select has_trigger('public', 'products', 'products_audit_mutation', 'product mutations are audited');
select has_trigger('public', 'audit_logs', 'audit_logs_are_append_only', 'audit history is append-only');
select has_trigger('public', 'reconciliation_runs', 'reconciliation_runs_protect_history', 'reconciliation transitions are protected');
select has_trigger('public', 'reconciliation_exceptions', 'reconciliation_exceptions_protect_history', 'completed reconciliation exceptions are protected');
select has_trigger('public', 'payouts', 'payouts_require_agreement_snapshot', 'every payout requires a snapshot before commit');
select ok(
  lower(pg_get_functiondef('public.validate_commission_entry()'::regprocedure)) like '%for share%',
  'commission posting takes a payout-period row lock that serializes against closure'
);
select ok(
  lower(pg_get_functiondef('public.protect_commission_rule_history()'::regprocedure)) like '%for update%',
  'commission-rule writes lock their agreement row and serialize against activation'
);
select ok(
  lower(pg_get_functiondef('public.validate_subscription_identity()'::regprocedure)) like '%for update%',
  'subscription writes lock their acquisition row and serialize against resolution'
);
select ok(
  lower(pg_get_functiondef('public.validate_payout_agreement_snapshot()'::regprocedure)) like '%for update%',
  'payout snapshot writes lock their payout row and serialize against finalization'
);

select is(
  (select public from storage.buckets where id = 'affiliate-private-documents'),
  false,
  'affiliate document bucket is private'
);
select is(
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'affiliate_private_documents_partner_read'),
  1::bigint,
  'private document objects have one scoped partner-read policy'
);
create table public.default_privilege_table_probe (id bigint);
create sequence public.default_privilege_sequence_probe;
create function public.default_privilege_function_probe()
returns void language sql set search_path = '' as $$ select $$;
select is(
  (
    select count(*)
    from unnest(array['public', 'anon', 'authenticated']::text[]) as checked_role(role_name)
    where has_table_privilege(checked_role.role_name, 'public.default_privilege_table_probe', 'SELECT')
      or has_table_privilege(checked_role.role_name, 'public.default_privilege_table_probe', 'INSERT')
      or has_table_privilege(checked_role.role_name, 'public.default_privilege_table_probe', 'UPDATE')
      or has_table_privilege(checked_role.role_name, 'public.default_privilege_table_probe', 'DELETE')
  ),
  0::bigint,
  'future public tables inherit no browser or PUBLIC privileges'
);
select is(
  (
    select count(*)
    from unnest(array['public', 'anon', 'authenticated']::text[]) as checked_role(role_name)
    where has_sequence_privilege(checked_role.role_name, 'public.default_privilege_sequence_probe', 'USAGE')
      or has_sequence_privilege(checked_role.role_name, 'public.default_privilege_sequence_probe', 'SELECT')
      or has_sequence_privilege(checked_role.role_name, 'public.default_privilege_sequence_probe', 'UPDATE')
  ),
  0::bigint,
  'future public sequences inherit no browser or PUBLIC privileges'
);
select is(
  (
    select count(*)
    from unnest(array['public', 'anon', 'authenticated']::text[]) as checked_role(role_name)
    where has_function_privilege(
      checked_role.role_name,
      'public.default_privilege_function_probe()',
      'EXECUTE'
    )
  ),
  0::bigint,
  'future public functions inherit no browser or PUBLIC execution'
);

select * from finish();
rollback;
