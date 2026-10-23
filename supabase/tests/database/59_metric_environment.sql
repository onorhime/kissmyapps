-- Disposable regression: the selected mode covers every card, not only commerce.
begin;
set local time zone 'UTC';
\i supabase/tests/fixtures/external-canonical.sql
set local role authenticated;
select public.save_admin_funnel_metrics_draft(jsonb_build_object('funnel_id','ac570000-0000-4000-8000-000000000002','expected_revision',0,'metrics','[{"key":"leads","label":"Leads","type":"unique_people","event_name":"lead_created"},{"key":"lead_events","label":"Lead events","type":"event_count","event_name":"lead_created"},{"key":"attended","label":"Attendees","type":"current_state","event_name":"webinar_attendance_updated","state_value":"attended"},{"key":"ratio","label":"People per lead event","type":"ratio","numerator_key":"leads","denominator_key":"lead_events"},{"key":"legacy","label":"Legacy only","type":"unique_people","event_name":"legacy_only"}]'::jsonb));
select public.publish_admin_funnel_metrics('ac570000-0000-4000-8000-000000000002',1);
reset role;
-- Independent clicks for TEST and LIVE: the same acquisition cannot switch mode.
insert into public.clicks(id,public_click_id,affiliate_link_id,affiliate_id,product_id,funnel_id,sub1,destination_url_snapshot,occurred_at)
select 'ac590000-0000-4000-8000-000000000005','opaque_live_fixture_click_123456',affiliate_link_id,affiliate_id,product_id,funnel_id,sub1,destination_url_snapshot,occurred_at from public.clicks where id='ac570000-0000-4000-8000-000000000005';
insert into public.acquisitions(id,product_id,affiliate_id,click_record_id,funnel_id,attribution_method,created_at)
select 'ac590000-0000-4000-8000-000000000006',product_id,affiliate_id,'ac590000-0000-4000-8000-000000000005',funnel_id,attribution_method,created_at from public.acquisitions where id='ac570000-0000-4000-8000-000000000006';
create function pg_temp.mode_event(mode text,event text,person text,extra jsonb default '{}') returns jsonb language plpgsql as $$
declare packet jsonb;
begin
 packet:=jsonb_build_object('event_id',gen_random_uuid(),'event_name',event,'subject_id',person,'click_id',case when mode='live' then 'opaque_live_fixture_click_123456' else 'opaque_fixture_click_123456' end,'occurred_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))||extra;
 if mode is not null then packet:=packet||jsonb_build_object('schema_version','2','environment',mode,'dedupe_key',gen_random_uuid()::text);end if;
 return public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',packet);
end;$$;
select pg_temp.mode_event('test','lead_created','guest_subject_123456789');
select pg_temp.mode_event('test','lead_created','verified_subject_123456789');
select pg_temp.mode_event('test','identity_linked','verified_subject_123456789','{"aliased_subject_id":"guest_subject_123456789","state_value":"verified"}');
-- A genuine earlier join arrives later, at a higher operational revision. The
-- fallback webinar ID also keeps two webinars separate when context is omitted.
select set_config('qa.metric.first_join',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),true);
select pg_temp.mode_event('test','webinar_attendance_updated','guest_subject_123456789','{"webinar_id":"webinar_one","state_value":"unknown","state_revision":"1","channel":"organic"}');
select pg_temp.mode_event('test','webinar_attendance_updated','verified_subject_123456789',jsonb_build_object('webinar_id','webinar_one','context_id','registration_context','state_value','attended','state_revision','2','occurred_at',current_setting('qa.metric.first_join'),'channel','creator'));
select pg_temp.mode_event('test','webinar_attendance_updated','guest_subject_123456789','{"webinar_id":"webinar_one","state_value":"unknown","state_revision":"1","channel":"organic"}');
select pg_temp.mode_event('test','webinar_attendance_updated','verified_subject_123456789','{"webinar_id":"webinar_two","state_value":"missed","state_revision":"3","channel":"creator"}');
select set_config('qa.metric.test_latest',(select max(received_at)::text from public.funnel_metric_events where journey_environment='test'),true);
select pg_temp.mode_event('live','lead_created','verified_subject_123456789');
select pg_temp.mode_event('live','lead_created','second_live_subject_123456789');
select pg_temp.mode_event('live','webinar_attendance_updated','verified_subject_123456789','{"webinar_id":"webinar_one","state_value":"missed","state_revision":"9"}');
select pg_temp.mode_event(null,'lead_created','legacy_subject_123456789');
select pg_temp.mode_event(null,'webinar_attendance_updated','legacy_subject_123456789','{"context_id":"webinar_one","state_value":"attended"}');
select pg_temp.mode_event(null,'legacy_only','legacy_subject_123456789');
select set_config('qa.metric.report',jsonb_build_object('product_id','ac570000-0000-4000-8000-000000000001','funnel_id','ac570000-0000-4000-8000-000000000002','date_from',current_date::text,'date_to',current_date::text,'time_zone','UTC')::text,true);
set local role authenticated;
select set_config('qa.metric.test',public.get_admin_funnel_metrics_report(current_setting('qa.metric.report')::jsonb||'{"environment":"test"}')::text,true);
select set_config('qa.metric.live',public.get_admin_funnel_metrics_report(current_setting('qa.metric.report')::jsonb||'{"environment":"live"}')::text,true);
select pg_temp.check_true(current_setting('qa.metric.test')::jsonb#>>'{metrics,0,value}'='1','TEST distinct people resolve verified guest aliases');
select pg_temp.check_true(current_setting('qa.metric.test')::jsonb#>>'{metrics,1,value}'='2','TEST events exclude LIVE and unclassified historical rows');
select pg_temp.check_true(current_setting('qa.metric.test')::jsonb#>>'{metrics,2,value}'='1','higher attendance revision beats later stale unknown across aliases');
select pg_temp.check_true(current_setting('qa.metric.test')::jsonb#>>'{metrics,3,value}'='50.00','period ratio is computed only from TEST cards');
select pg_temp.check_true(current_setting('qa.metric.test')::jsonb#>>'{metrics,4,availability}'='awaiting_data','unclassified legacy source cannot pretend connected in TEST');
select pg_temp.check_true((current_setting('qa.metric.test')::jsonb->>'last_received_at')::timestamptz=current_setting('qa.metric.test_latest')::timestamptz,'latest receipt belongs to selected mode');
select pg_temp.check_true(current_setting('qa.metric.live')::jsonb#>>'{metrics,0,value}'='2','LIVE counts exclude TEST and unclassified people');
select pg_temp.check_true(current_setting('qa.metric.live')::jsonb#>>'{metrics,2,value}'='0','LIVE newer missed state cannot suppress TEST attendance');
select pg_temp.check_true(current_setting('qa.metric.live')::jsonb#>>'{metrics,3,value}'='100.00','LIVE ratio remains isolated');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.metric.report')::jsonb)#>>'{metrics,1,value}'='5','omitted environment retains historical unfiltered event compatibility');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.metric.report')::jsonb||'{"environment":"test","channel":"organic"}')#>>'{metrics,2,value}'='0','dimension filter cannot revive superseded lower revision');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.metric.report')::jsonb||'{"environment":"test","webinar_id":"webinar_two"}')#>>'{metrics,2,value}'='0','separate webinar missed state is respected');
select pg_temp.reject('select public.get_admin_funnel_metrics_report(current_setting(''qa.metric.report'')::jsonb||''{"environment":"sandbox"}'')','invalid environment fails closed');
select pg_temp.reject('select public.funnel_metrics_report_v1(current_setting(''qa.metric.report'')::jsonb,true)','private compatibility helper remains inaccessible');
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000012","role":"authenticated"}',true);
select pg_temp.check_true(public.get_partner_funnel_metrics_report(current_setting('qa.metric.report')::jsonb||'{"environment":"test"}')#>>'{metrics,0,value}'='1','creator report shares scoped alias behavior');
select pg_temp.reject('select public.get_partner_funnel_metrics_report(current_setting(''qa.metric.report'')::jsonb||''{"environment":"test","affiliate_id":"ac570000-0000-4000-8000-000000000014"}'')','mode never bypasses creator self scope');
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000013","role":"authenticated"}',true);
select pg_temp.reject('select public.get_partner_funnel_metrics_report(current_setting(''qa.metric.report'')::jsonb||''{"environment":"test"}'')','unrelated creator cannot access product');
reset role;
-- Financial rows still come from the verified ledger, scoped independently by
-- provider mode. Selecting mode must not be mistaken for an order dimension.
select pg_temp.make_order(1,8000,false,clock_timestamp());
select pg_temp.make_order(2,8000,true,clock_timestamp());
select pg_temp.admin();set local role authenticated;
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.metric.report')::jsonb||'{"environment":"test"}')#>>'{commerce,currencies,0,purchases}'='1','TEST commerce remains authoritative and is not lost to dimension filtering');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.metric.report')::jsonb||'{"environment":"live"}')#>>'{commerce,currencies,0,purchases}'='1','LIVE commerce remains separately authoritative');
reset role;
rollback;
