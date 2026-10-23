-- Billing projections use synthetic verified-source and cache fixtures.
-- No provider requests, customer payments or payouts occur; everything rolls back.
begin;
\i supabase/tests/fixtures/partner-reporting-cache.sql
create temporary table billing_assertions(label text);
grant insert,select on billing_assertions to authenticated;
create function pg_temp.billing_check(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Billing assertion failed: %',label; end if;
  insert into billing_assertions values(label);
end $$;
grant execute on function pg_temp.billing_check(boolean,text) to authenticated;

do $$ declare member uuid; tz text; day date; begin
  select au.user_id,a.reporting_timezone into strict member,tz
  from public.affiliate_users au join public.affiliates a on a.id=au.affiliate_id
  join auth.users u on u.id=au.user_id
  where au.affiliate_id='aa280000-0000-4000-8000-000000000003' and au.active
    and lower(u.email)='report-partner@example.invalid';
  day := (now() at time zone tz)::date;
  perform set_config('kma_test.member',member::text,true);
  perform set_config('kma_test.partner','aa280000-0000-4000-8000-000000000003',true);
  perform set_config('kma_test.product','aa280000-0000-4000-8000-000000000001',true);
  perform set_config('kma_test.day',day::text,true);
  perform set_config('kma_test.timezone',tz,true);
  perform pg_temp.billing_check(kma_internal.partner_billing_report_is_ready(
    current_setting('kma_test.partner')::uuid,current_setting('kma_test.product')::uuid,day-1,day),
    'synthetic initial queues are clear before backlog variations');
  perform pg_temp.billing_check(not has_function_privilege('authenticated',
    'kma_internal.partner_billing_report_is_ready(uuid,uuid,date,date)','execute'),'internal billing helper private');
  perform pg_temp.billing_check(not has_function_privilege('anon',
    'public.get_partner_dashboard_summary(uuid,date,date,text,uuid,uuid,uuid,text,text)','execute'),'anonymous denied');
  perform pg_temp.billing_check(not has_function_privilege('authenticated',
    'public.get_partner_dashboard_summary_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text)','execute'),'commercial implementation private');
  perform pg_temp.billing_check(not has_table_privilege('authenticated','public.affiliate_daily_metrics','update'),'partner cannot alter metrics');
end $$;

create temporary table billing_original as select * from public.affiliate_daily_metrics
where affiliate_id=current_setting('kma_test.partner')::uuid and product_id=current_setting('kma_test.product')::uuid
and metric_date=current_setting('kma_test.day')::date;
select pg_temp.billing_check((select count(*)=2 and count(*) filter(where is_subscription_snapshot)=1
  from billing_original),'one traffic row and one snapshot fixture');
create temporary table billing_queue as select * from public.commercial_metric_refresh_queue
where affiliate_id=current_setting('kma_test.partner')::uuid and product_id=current_setting('kma_test.product')::uuid;
create temporary table billing_receipt as select * from public.provider_event_processing order by processed_at desc limit 1;
select pg_temp.billing_check((select count(*)=1 from billing_receipt),'synthetic processed receipt for retry fixture');

create function pg_temp.restore_billing() returns void language plpgsql as $$ begin
  delete from public.affiliate_daily_metrics
  where affiliate_id=current_setting('kma_test.partner')::uuid and product_id=current_setting('kma_test.product')::uuid
    and metric_date between current_setting('kma_test.day')::date-1 and current_setting('kma_test.day')::date;
  insert into public.affiliate_daily_metrics select * from billing_original;
end $$;
select pg_temp.restore_billing();

create function pg_temp.expect_billing(purchases bigint,earnings bigint,subs bigint,label text)
returns void language plpgsql as $$ declare s record; t record; begin
  select * into strict s from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date-1,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
  perform pg_temp.billing_check(s.purchases is not distinct from purchases,label||': summary purchases');
  perform pg_temp.billing_check(s.earnings_minor is not distinct from earnings,label||': summary earnings');
  perform pg_temp.billing_check(s.active_subscriptions is not distinct from subs,label||': summary subscriptions');
  perform pg_temp.billing_check(s.reconciliation_stage='preliminary',label||': remains preliminary, not payable');
  perform pg_temp.billing_check(s.installs is null and s.leads is null,label||': optional analytics still unknown');
  select * into strict t from public.get_partner_dashboard_trends(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null,'day','source');
  perform pg_temp.billing_check(t.purchases is not distinct from purchases,label||': trend purchases');
  perform pg_temp.billing_check(t.earnings_minor is not distinct from earnings,label||': trend earnings');
  perform pg_temp.billing_check(t.active_subscriptions is null,label||': source table never invents a snapshot');
  perform pg_temp.billing_check(s.clicks>0 and t.clicks>0,label||': verified traffic unaffected');
end $$;
grant execute on function pg_temp.expect_billing(bigint,bigint,bigint,text) to authenticated;

select set_config('request.jwt.claim.sub',current_setting('kma_test.member'),true),
 set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('kma_test.member'),'role','authenticated')::text,true);
set local role authenticated;
-- A zero-revenue subscription snapshot must not be called a purchase.
select pg_temp.expect_billing(0,0,2,'synthetic zero-revenue subscription snapshot');
reset role;

update public.affiliate_daily_metrics set purchases=3,earnings_minor=125
where id in (select id from billing_original where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_billing(3,125,2,'known preliminary cached amounts');
reset role;
select pg_temp.restore_billing();

update public.affiliate_daily_metrics set source_freshness=source_freshness-'stripe'
where id in (select id from billing_original where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_billing(null,null,2,'missing billing freshness stays unknown');
reset role;
update public.affiliate_daily_metrics set source_freshness=source_freshness||'{"stripe":true}'::jsonb
where id in (select id from billing_original where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_billing(null,null,2,'malformed billing freshness stays unknown');
reset role;
select pg_temp.restore_billing();

update public.affiliate_daily_metrics set calculated_at=calculated_at-interval '1 day'
where id in (select id from billing_original where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_billing(null,null,2,'stale cached amounts after newer refresh');
reset role;
select pg_temp.restore_billing();

update public.affiliate_daily_metrics set source_freshness='{}'
where id in (select id from billing_original where is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_billing(0,0,null,'unknown snapshot cannot hide known recorded money');
reset role;
select pg_temp.restore_billing();

update public.provider_event_processing set status='pending',processed_at=null
where provider_event_id in (select provider_event_id from billing_receipt);
set local role authenticated;
select pg_temp.expect_billing(null,null,null,'pending Stripe receipt withholds billing not traffic');
reset role;
update public.provider_event_processing set status='failed',processing_error='fixture_failure'
where provider_event_id in (select provider_event_id from billing_receipt);
set local role authenticated;
select pg_temp.expect_billing(null,null,null,'failed receipt withholds billing');
reset role;
update public.provider_event_processing p set status=o.status,processed_at=o.processed_at,processing_error=o.processing_error
from billing_receipt o where p.provider_event_id=o.provider_event_id;

update public.commercial_metric_refresh_queue set status='pending',processed_at=null
where id in (select id from billing_queue where metric_date=current_setting('kma_test.day')::date);
set local role authenticated;
select pg_temp.expect_billing(null,null,null,'pending metrics withhold prior cached billing');
reset role;
update public.commercial_metric_refresh_queue q set status=o.status,processed_at=o.processed_at
from billing_queue o where q.id=o.id;

-- Missing queue evidence must not turn a partial row into verified money.
delete from public.commercial_metric_refresh_queue where id in
 (select id from billing_queue where metric_date=current_setting('kma_test.day')::date);
set local role authenticated;
select pg_temp.expect_billing(null,null,null,'missing processing evidence');
reset role;
insert into public.commercial_metric_refresh_queue select * from billing_queue
where metric_date=current_setting('kma_test.day')::date;

-- Known historical complete rows still work without optional source flags.
update public.affiliate_daily_metrics set completeness='complete',source_freshness='{}'
where id in (select id from billing_original where not is_subscription_snapshot);
set local role authenticated;
select pg_temp.expect_billing(0,0,2,'legacy complete money plus partial snapshot');
reset role;
select pg_temp.restore_billing();

-- Unknown second date cannot vanish via bool_and / sum ignoring NULL.
insert into public.affiliate_daily_metrics
select (jsonb_populate_record(null::public.affiliate_daily_metrics,to_jsonb(m)||jsonb_build_object(
 'id',gen_random_uuid(),'metric_date',m.metric_date-1,'source_freshness','{}'::jsonb))).*
from billing_original m where not m.is_subscription_snapshot;
set local role authenticated;
do $$ declare s record; begin
  select * into strict s from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date-1,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
  perform pg_temp.billing_check(s.purchases is null and s.earnings_minor is null,'mixed known and unknown date is unknown');
end $$;
reset role;
select pg_temp.restore_billing();

-- The existing agreement rejects an unmatched currency before reporting.
-- Do not weaken integrity triggers or manufacture a foreign-currency agreement.
do $$ begin
  begin
    update public.affiliate_daily_metrics set currency='EUR'
    where id in (select id from billing_original where not is_subscription_snapshot);
    raise exception 'Unmatched currency succeeded';
  exception when check_violation then perform pg_temp.billing_check(true,'unmatched currency rejected by immutable agreement boundary'); end;
end $$;

-- This uncommitted queue-only fixture is never visible to a worker.
insert into public.commercial_fact_processing(source_kind,source_id,occurred_at)
values('transaction','00000000-0000-4000-8000-000000000033',now());
set local role authenticated;
select pg_temp.expect_billing(null,null,null,'unfinished commercial calculation withholds billing');
reset role;
delete from public.commercial_fact_processing where source_id='00000000-0000-4000-8000-000000000033';

delete from public.affiliate_daily_metrics where id in
 (select id from billing_original where not is_subscription_snapshot);
set local role authenticated;
do $$ declare s record; begin
  select * into strict s from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
  perform pg_temp.billing_check(s.purchases is null and s.earnings_minor is null and s.clicks is null
    and s.active_subscriptions=2,'snapshot alone never fabricates zero money or traffic');
end $$;
reset role;
select pg_temp.restore_billing();

set local role authenticated;
do $$ declare s record; begin
  select * into strict s from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
    current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),
    '00000000-0000-4000-8000-000000000033',null,null,null,null);
  perform pg_temp.billing_check(not s.has_data and s.purchases is null and s.earnings_minor is null,'empty source not zero');
  begin
    perform * from public.get_partner_dashboard_summary('00000000-0000-4000-8000-000000000033',
      current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
    raise exception 'Foreign product succeeded';
  exception when insufficient_privilege then perform pg_temp.billing_check(true,'foreign product denied'); end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000033',true),
 set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000033","role":"authenticated"}',true);
do $$ begin
  begin
    perform * from public.get_partner_dashboard_summary(current_setting('kma_test.product')::uuid,
      current_setting('kma_test.day')::date,current_setting('kma_test.day')::date,current_setting('kma_test.timezone'),null,null,null,null,null);
    raise exception 'Nonmember succeeded';
  exception when insufficient_privilege then perform pg_temp.billing_check(true,'nonmember denied'); end;
end $$;
reset role;
select count(*) as passed_billing_assertions from billing_assertions;

rollback;
