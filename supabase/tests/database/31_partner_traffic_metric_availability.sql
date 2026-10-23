-- Traffic availability remains separate from billing readiness. All fixture
-- rows and variations are synthetic, private to this rollback transaction.
begin;
\i supabase/tests/fixtures/partner-reporting-cache.sql
-- Incomplete financial processing must not hide already measured traffic.
update public.provider_event_processing set status='pending',processed_at=null
where provider_event_id='aa280000-0000-4000-8000-000000000031';
create temporary table reporting_assertions (label text);
grant insert, select on reporting_assertions to authenticated;
create function pg_temp.report_check(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Reporting assertion failed: %',label; end if;
  insert into reporting_assertions values(label);
end $$;
grant execute on function pg_temp.report_check(boolean,text) to authenticated;

do $$
declare
  partner uuid := 'aa280000-0000-4000-8000-000000000003';
  product uuid := 'aa280000-0000-4000-8000-000000000001';
  member uuid;
  tz text;
  day date;
begin
  select au.user_id,a.reporting_timezone into strict member,tz
  from public.affiliate_users au join public.affiliates a on a.id=au.affiliate_id
  join auth.users u on u.id=au.user_id
  where au.affiliate_id=partner and au.active and lower(u.email)='report-partner@example.invalid';
  day := (now() at time zone tz)::date;
  perform set_config('kma_test.partner',partner::text,true);
  perform set_config('kma_test.product',product::text,true);
  perform set_config('kma_test.member',member::text,true);
  perform set_config('kma_test.timezone',tz,true);
  perform set_config('kma_test.day',day::text,true);
  perform pg_temp.report_check((select count(*)=2 and count(*) filter(where not is_subscription_snapshot)=1
    and sum(clicks)>0 and sum(funnel_starts)>0 and sum(payment_views)>0
    from public.affiliate_daily_metrics where affiliate_id=partner and product_id=product and metric_date=day),
    'bounded current one-link plus snapshot fixture');
  perform pg_temp.report_check(not exists(select 1 from public.affiliate_daily_metrics
    where affiliate_id=partner and product_id=product and metric_date=day-1),'unused prior test day');
  perform pg_temp.report_check(not exists(select 1 from public.affiliate_users where user_id='00000000-0000-4000-8000-000000000031'),'unused nonmember identity');
  perform pg_temp.report_check(not has_function_privilege('anon','public.get_partner_dashboard_summary(uuid,date,date,text,uuid,uuid,uuid,text,text)','execute'),'anonymous report denied');
  perform pg_temp.report_check(not has_function_privilege('authenticated','public.get_partner_dashboard_summary_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text)','execute'),'private implementation remains private');
  perform pg_temp.report_check(not has_table_privilege('authenticated','public.affiliate_daily_metrics','update'),'partner cannot rewrite metrics');
  perform pg_temp.report_check((select count(*)=2 from pg_proc where oid in (
    'public.get_partner_dashboard_summary_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text)'::regprocedure,
    'public.get_partner_dashboard_trends_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text,text,text)'::regprocedure)
    and prosecdef and provolatile='s' and proconfig @> array['search_path=""']),'stable scoped function settings retained');
end $$;

create temporary table original_reporting as select * from public.affiliate_daily_metrics
where affiliate_id=current_setting('kma_test.partner')::uuid and product_id=current_setting('kma_test.product')::uuid
and metric_date=current_setting('kma_test.day')::date;
grant select on original_reporting to authenticated;

create function pg_temp.expect_traffic(click_value bigint, start_value bigint, view_value bigint, label text)
returns void language plpgsql as $$
declare summary record; trend record;
begin
  select * into strict summary from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date-1,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
  perform pg_temp.report_check(summary.has_data and summary.reconciliation_stage='preliminary',label||': honest preliminary state');
  perform pg_temp.report_check(summary.clicks is not distinct from click_value,label||': summary clicks');
  perform pg_temp.report_check(summary.funnel_starts is not distinct from start_value,label||': summary starts');
  perform pg_temp.report_check(summary.payment_views is not distinct from view_value,label||': summary paywall');
  perform pg_temp.report_check(summary.purchases is null and summary.earnings_minor is null,label||': financial gates unchanged');
  select * into strict trend from public.get_partner_dashboard_trends(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null,'day','source');
  perform pg_temp.report_check(trend.clicks is not distinct from click_value,label||': trend clicks');
  perform pg_temp.report_check(trend.funnel_starts is not distinct from start_value,label||': trend starts');
  perform pg_temp.report_check(trend.payment_views is not distinct from view_value,label||': trend paywall');
  perform pg_temp.report_check(trend.purchases is null and trend.earnings_minor is null,label||': trend financial gates unchanged');
end $$;
grant execute on function pg_temp.expect_traffic(bigint,bigint,bigint,text) to authenticated;

select set_config('request.jwt.claim.sub',current_setting('kma_test.member'),true),
  set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('kma_test.member'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.expect_traffic(sum(clicks)::bigint,sum(funnel_starts)::bigint,sum(payment_views)::bigint,
  'complete synthetic traffic with missing analytics and partial snapshot') from original_reporting;
do $$
declare item record;
begin
  select * into strict item from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),
    '00000000-0000-4000-8000-000000000031',null,null,null,null);
  perform pg_temp.report_check(not item.has_data and item.clicks is null,'empty source is unknown, not fabricated zero');
  begin
    perform * from public.get_partner_dashboard_summary('00000000-0000-4000-8000-000000000031',
      current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
    raise exception 'Unauthorized product succeeded';
  exception when insufficient_privilege then perform pg_temp.report_check(true,'foreign product denied'); end;
end $$;
reset role;

update public.affiliate_daily_metrics set source_freshness='{"click_tracker":"complete"}'
where id in (select id from original_reporting where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_traffic(sum(clicks)::bigint,null,null,'missing first-party source') from original_reporting;
reset role;

update public.affiliate_daily_metrics set source_freshness='{"first_party":"complete","click_tracker":true}'
where id in (select id from original_reporting where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_traffic(null,sum(funnel_starts)::bigint,sum(payment_views)::bigint,'malformed click freshness') from original_reporting;
reset role;

update public.affiliate_daily_metrics set source_freshness='{}'
where id in (select id from original_reporting where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_traffic(null,null,null,'absent source freshness');
reset role;

update public.affiliate_daily_metrics set completeness='complete',source_freshness='{}'
where id in (select id from original_reporting where not is_subscription_snapshot);
set local role authenticated;
-- The overall summary still includes a partial subscription snapshot, so money
-- stays unknown there; complete legacy source rows retain their traffic counts.
do $$ declare s record; begin
  select * into strict s from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
  perform pg_temp.report_check(s.clicks=(select sum(clicks) from original_reporting) and s.earnings_minor is null,'legacy complete rows and partial snapshot');
end $$;
reset role;

update public.affiliate_daily_metrics set completeness='partial',source_freshness='{"click_tracker":"complete","first_party":"complete"}',
  clicks=0,visitors=0,funnel_starts=0,payment_views=0,app_store_clicks=0
where id in (select id from original_reporting where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_traffic(0,0,0,'known measured zero');
reset role;

-- A second unknown bucket must not disappear through bool_and's NULL handling.
insert into public.affiliate_daily_metrics
select (jsonb_populate_record(null::public.affiliate_daily_metrics,to_jsonb(m)||jsonb_build_object(
  'id',gen_random_uuid(),'metric_date',m.metric_date-1,'source_freshness','{}'::jsonb))).*
from public.affiliate_daily_metrics m where id in (select id from original_reporting where not is_subscription_snapshot);
set local role authenticated;
do $$ declare s record; begin
  select * into strict s from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date-1,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
  perform pg_temp.report_check(s.clicks is null and s.funnel_starts is null,'mixed available and missing source buckets remain unknown');
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000031',true),
  set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000031","role":"authenticated"}',true);
do $$ begin
  begin
    perform * from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
      current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
    raise exception 'Nonmember reporting succeeded';
  exception when insufficient_privilege then perform pg_temp.report_check(true,'nonmember denied'); end;
end $$;
reset role;
select count(*) as passed_reporting_assertions from reporting_assertions;

rollback;
