-- Hosted READ-ONLY acceptance. No fixture rows, temporary tables, provider calls,
-- definition changes, queue changes or payment/payout actions. Result contains
-- statuses/counts only; identities and financial amounts stay inside the audit.
-- Any failed assertion aborts this transaction. Run the entire file together.
begin read only;
set local statement_timeout = '25s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '90s';

do $$
declare scope record; info jsonb; unseen uuid; permitted uuid[]; first_day date; last_day date;
begin
  if current_setting('transaction_read_only') <> 'on' then raise exception 'Read-only transaction required'; end if;
  if to_regclass('supabase_migrations.schema_migrations') is null then
    info := jsonb_build_object('registry','unavailable','candidate_applied',null);
  else
    execute $q$select jsonb_build_object('registry','available','count',count(*),'latest',max(version),
      'previous_baseline_present',bool_or(version='20261019100000'),
      'candidate_applied',bool_or(version='20261022100000')) from supabase_migrations.schema_migrations$q$ into info;
  end if;
  perform set_config('qa.hosted.migrations',info::text,true);
  if has_function_privilege('authenticated','public.agreement_is_launch_ready(uuid,timestamptz)','execute')
    or has_function_privilege('authenticated','public.tracking_only_product_is_ready(uuid)','execute')
    or has_function_privilege('authenticated','kma_internal.partner_billing_report_is_ready(uuid,uuid,date,date)','execute')
    or has_function_privilege('authenticated','public.get_partner_dashboard_summary_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text)','execute')
    or has_function_privilege('authenticated','public.get_partner_dashboard_trends_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text,text,text)','execute')
    or has_table_privilege('authenticated','public.agreements','select')
    or has_table_privilege('authenticated','public.funnels','select')
    or has_table_privilege('authenticated','public.affiliate_daily_metrics','update') then
    raise exception 'Internal helpers or raw business tables exposed to browser role';
  end if;
  if has_function_privilege('anon','public.partner_agreement_is_launch_ready(uuid)','execute')
    or has_function_privilege('anon','public.partner_tracking_only_product_is_ready(uuid)','execute')
    or has_function_privilege('anon','public.get_partner_dashboard_summary(uuid,date,date,text,uuid,uuid,uuid,text,text)','execute')
    or has_function_privilege('anon','public.get_partner_dashboard_trends(uuid,date,date,text,uuid,uuid,uuid,text,text,text,text)','execute') then
    raise exception 'Anonymous readiness or report execution granted';
  end if;
  if (select count(*) from pg_proc where oid in (
      'public.partner_agreement_is_launch_ready(uuid)'::regprocedure,
      'public.partner_tracking_only_product_is_ready(uuid)'::regprocedure,
      'public.get_partner_dashboard_summary_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text)'::regprocedure,
      'public.get_partner_dashboard_trends_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text,text,text)'::regprocedure)
      and prosecdef and provolatile='s' and proconfig @> array['search_path=""']) <> 4 then
    raise exception 'Scoped read-only function execution settings differ';
  end if;
  loop
    unseen := gen_random_uuid();
    exit when not exists(select 1 from public.affiliate_users where user_id=unseen)
      and not exists(select 1 from public.products where id=unseen)
      and not exists(select 1 from public.agreements where id=unseen);
  end loop;
  perform set_config('qa.hosted.unseen',unseen::text,true);
  -- Prefer the historical commercial product only when it still has a suitable
  -- member. Otherwise select an existing single-workspace commercial member.
  select au.user_id,a.id affiliate_id,p.id product_id,g.id agreement_id,a.reporting_timezone tz,
    public.agreement_is_launch_ready(g.id,statement_timestamp()) agreement_ready into scope
  from public.affiliate_users au join public.affiliates a on a.id=au.affiliate_id
  join public.agreements g on g.affiliate_id=a.id join public.products p on p.id=g.product_id
  where au.active and a.status='active' and p.status='active' and p.tracking_mode='commercial'
    and (select count(*) from public.affiliate_users m join public.affiliates ma on ma.id=m.affiliate_id
      where m.user_id=au.user_id and m.active and ma.status in('active','paused'))=1
  order by (p.id='fdbabb87-9743-4521-bc8d-11804fe1185f') desc,
    (g.status='active') desc,(au.role='owner') desc,g.version desc,au.user_id limit 1;
  perform set_config('qa.hosted.scope',coalesce(to_jsonb(scope),'{}'::jsonb)::text,true);
  if scope.user_id is not null then
    select array_agg(distinct id) into permitted from (
      select product_id id from public.agreements where affiliate_id=scope.affiliate_id union
      select product_id from public.affiliate_links where affiliate_id=scope.affiliate_id union
      select product_id from public.payouts where affiliate_id=scope.affiliate_id union
      select product_id from public.affiliate_daily_metrics where affiliate_id=scope.affiliate_id) p;
    perform set_config('qa.hosted.allowed',to_jsonb(permitted)::text,true);
    select coalesce(max(metric_date),(now() at time zone scope.tz)::date) into last_day
    from public.affiliate_daily_metrics where affiliate_id=scope.affiliate_id and product_id=scope.product_id
      and metric_date <= (now() at time zone scope.tz)::date;
    first_day := last_day-1;
    perform set_config('qa.hosted.period',jsonb_build_object('from',first_day,'through',last_day)::text,true);
    perform set_config('qa.hosted.billing_ready',kma_internal.partner_billing_report_is_ready(scope.affiliate_id,scope.product_id,first_day,last_day)::text,true);
    select jsonb_build_object('rows',count(*),'clicks',case when count(*)>0 and bool_and(coalesce(completeness='complete' or source_freshness->>'click_tracker'='complete',false)) then sum(clicks) end,
      'starts',case when count(*)>0 and bool_and(coalesce(completeness='complete' or source_freshness->>'first_party'='complete',false)) then sum(funnel_starts) end,
      'views',case when count(*)>0 and bool_and(coalesce(completeness='complete' or source_freshness->>'first_party'='complete',false)) then sum(payment_views) end) into info
    from public.affiliate_daily_metrics where affiliate_id=scope.affiliate_id and product_id=scope.product_id
      and metric_date between first_day and last_day and not is_subscription_snapshot;
    perform set_config('qa.hosted.expected_traffic',info::text,true);
  end if;
  perform set_config('qa.hosted.backlog',jsonb_build_object(
    'unresolved_stripe_receipts',(select count(*) from public.provider_events e left join public.provider_event_processing s on s.provider_event_id=e.id
      where e.provider='stripe' and (not e.signature_verified or s.status is distinct from 'processed'::public.processing_status)),
    'unresolved_commercial_facts',(select count(*) from public.commercial_fact_processing where status<>'processed'),
    'scoped_unresolved_metric_refreshes',(select count(*) from public.commercial_metric_refresh_queue where affiliate_id=scope.affiliate_id and product_id=scope.product_id and metric_date between first_day and last_day and status<>'processed'))::text,true);
end $$;

set local role anon;
do $$ begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  begin
    perform public.partner_agreement_is_launch_ready(current_setting('qa.hosted.unseen')::uuid);
    raise exception 'Anonymous readiness access succeeded';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.get_partner_dashboard_summary(current_setting('qa.hosted.unseen')::uuid,current_date,current_date,'UTC',null,null,null,null,null);
    raise exception 'Anonymous report access succeeded';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
do $$
declare subject uuid; product uuid:=coalesce((current_setting('qa.hosted.scope')::jsonb->>'product_id')::uuid,current_setting('qa.hosted.unseen')::uuid);
begin
  -- Exercise both missing JWT and an identity that has no membership. The
  -- random identity is never inserted into Auth or an application table.
  foreach subject in array array[null::uuid,current_setting('qa.hosted.unseen')::uuid] loop
    perform set_config('request.jwt.claim.sub',coalesce(subject::text,''),true);
    perform set_config('request.jwt.claims',case when subject is null then '{}' else jsonb_build_object('sub',subject,'role','authenticated')::text end,true);
    if public.partner_agreement_is_launch_ready((current_setting('qa.hosted.scope')::jsonb->>'agreement_id')::uuid)
      or public.partner_tracking_only_product_is_ready(product)
      or public.partner_agreement_is_launch_ready(null)
      or public.partner_tracking_only_product_is_ready(null)
      or exists(select 1 from public.partner_product_directory)
      or exists(select 1 from public.partner_link_option_directory) then
      raise exception 'Missing session or nonmember disclosed partner data';
    end if;
    begin
      perform * from public.get_partner_dashboard_summary(product,current_date,current_date,'UTC',null,null,null,null,null);
      raise exception 'Missing session or nonmember report succeeded';
    exception when insufficient_privilege then null; end;
  end loop;
end $$;

do $$
declare context jsonb:=current_setting('qa.hosted.scope')::jsonb; expected jsonb; period jsonb;
  s record; item record; projected jsonb; products integer:=0; options integer:=0; trend_rows integer:=0;
  chosen_found boolean:=false; main_link boolean:=false; main_url boolean:=false;
  ready boolean; monetary text[]:=array['trials','purchases','activations','renewals','cancellations','refunds','disputes','gross_collected_minor','eligible_revenue_minor','earnings_minor','active_subscriptions'];
begin
  if context->>'user_id' is null then
    perform set_config('qa.hosted.member_result','{"status":"unavailable_no_active_commercial_member"}',true);
    return;
  end if;
  perform set_config('request.jwt.claim.sub',context->>'user_id',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',context->>'user_id','role','authenticated')::text,true);
  if public.partner_agreement_is_launch_ready((context->>'agreement_id')::uuid) is distinct from (context->>'agreement_ready')::boolean then
    raise exception 'Member readiness differs from internal scoped truth';
  end if;
  if public.partner_agreement_is_launch_ready(current_setting('qa.hosted.unseen')::uuid)
    or public.partner_tracking_only_product_is_ready(current_setting('qa.hosted.unseen')::uuid) then
    raise exception 'Unknown identifier disclosed readiness';
  end if;
  -- Materialize every column so projection pruning cannot mask a private helper
  -- execution failure. Contents are deliberately not returned to the operator.
  for item in select * from public.partner_product_directory loop
    projected:=to_jsonb(item); products:=products+1;
    if not current_setting('qa.hosted.allowed')::jsonb @> jsonb_build_array(item.id) then raise exception 'Product directory escaped member scope';end if;
    chosen_found:=chosen_found or item.id=(context->>'product_id')::uuid;
    if item.id=(context->>'product_id')::uuid then
      main_link:=item.main_link_id is not null;main_url:=item.main_tracking_url is not null;
    end if;
  end loop;
  for item in select * from public.partner_link_option_directory loop
    projected:=to_jsonb(item); options:=options+1;
    if item.product_id is not null and not current_setting('qa.hosted.allowed')::jsonb @> jsonb_build_array(item.product_id) then raise exception 'Option directory escaped member scope';end if;
  end loop;
  if not chosen_found then raise exception 'Selected authorized product missing from full directory projection';end if;
  period:=current_setting('qa.hosted.period')::jsonb;
  expected:=current_setting('qa.hosted.expected_traffic')::jsonb;
  ready:=current_setting('qa.hosted.billing_ready')::boolean;
  select * into strict s from public.get_partner_dashboard_summary((context->>'product_id')::uuid,
    (period->>'from')::date,(period->>'through')::date,context->>'tz',null,null,null,null,null);
  if s.clicks is distinct from (expected->>'clicks')::bigint or s.funnel_starts is distinct from (expected->>'starts')::bigint
    or s.payment_views is distinct from (expected->>'views')::bigint then raise exception 'Traffic visibility differs from measured source completeness';end if;
  if not ready and exists(select 1 from jsonb_each(to_jsonb(s)) e where e.key=any(monetary) and e.value<>'null'::jsonb) then
    raise exception 'Unresolved billing evidence disclosed money or subscriptions';
  end if;
  for item in select * from public.get_partner_dashboard_trends((context->>'product_id')::uuid,
    (period->>'from')::date,(period->>'through')::date,context->>'tz',null,null,null,null,null,'day','source') loop
    trend_rows:=trend_rows+1;
    if item.active_subscriptions is not null then raise exception 'Source trend invented a subscription snapshot';end if;
    if not ready and exists(select 1 from jsonb_each(to_jsonb(item)) e where e.key=any(monetary) and e.value<>'null'::jsonb) then
      raise exception 'Unresolved billing evidence leaked into trends';
    end if;
  end loop;
  begin
    perform * from public.get_partner_dashboard_summary(current_setting('qa.hosted.unseen')::uuid,
      (period->>'from')::date,(period->>'through')::date,context->>'tz',null,null,null,null,null);
    raise exception 'Unrelated product report succeeded';
  exception when insufficient_privilege then null;end;
  perform set_config('qa.hosted.member_result',jsonb_build_object('status','passed','product_projection_rows',products,
    'option_projection_rows',options,'summary_has_data',s.has_data,'trend_rows',trend_rows,
    'traffic_cache_rows',expected->'rows','traffic_completeness_contract','passed',
    'selected_main_link_present',main_link,'selected_main_tracking_url_present',main_url,
    'agreement_ready',context->'agreement_ready','billing_queue_ready',ready,
    'billing_backlog_suppression',case when not ready then 'passed' else 'not_exercised_queues_clear' end,
    'period_source',case when (expected->>'rows')::integer>0 then 'latest_recorded_cache_day_and_prior_day' else 'no_traffic_cache' end)::text,true);
end $$;
reset role;

select jsonb_build_object('transaction_read_only',current_setting('transaction_read_only')='on',
  'migration_state',current_setting('qa.hosted.migrations')::jsonb,
  'security_contract','passed','anonymous_denial','passed','missing_session_and_nonmember_denial','passed',
  'member_reporting',current_setting('qa.hosted.member_result')::jsonb,
  'operational_backlog',current_setting('qa.hosted.backlog')::jsonb,
  'candidate_schema_present',to_regclass('public.funnel_journey_configuration') is not null,
  'candidate_report_present',to_regprocedure('kma_internal.funnel_journey_report(uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,integer,text,jsonb)') is not null,
  'scope','current hosted baseline only; no candidate deployment or provider verification') as read_only_acceptance;
rollback;
