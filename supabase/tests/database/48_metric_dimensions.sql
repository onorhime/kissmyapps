begin;
\i supabase/tests/fixtures/external-canonical.sql
set local role authenticated;
select public.save_admin_funnel_metrics_draft(jsonb_build_object('funnel_id','ac570000-0000-4000-8000-000000000002','expected_revision',0,'metrics','[{"key":"leads","label":"Leads","type":"unique_people","event_name":"email_lead"},{"key":"requests","label":"Webinar requests","type":"unique_per_context","event_name":"webinar_requested"},{"key":"state","label":"Current state","type":"current_state","event_name":"test_state","state_value":"active"},{"key":"presence","label":"Presence","type":"live_presence","event_name":"test_presence"}]'::jsonb));
select public.publish_admin_funnel_metrics('ac570000-0000-4000-8000-000000000002',1);
reset role;
select set_config('qa.metric',jsonb_build_object('event_id',gen_random_uuid(),'event_name','email_lead','click_id','opaque_fixture_click_123456','subject_id','opaque_customer_fixture_123456','context_id','group_123','channel','creator','entry_variant','book','webinar_id','event_1','intake_id','intake_1','occurred_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,true);
select public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',current_setting('qa.metric')::jsonb);
select public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',current_setting('qa.metric')::jsonb||jsonb_build_object('event_id',gen_random_uuid(),'subject_id','second_customer_fixture_123456','channel','organic','entry_variant','workshop','webinar_id','event_2','intake_id','intake_2'));
-- A newer state under different dimensions must not resurrect the older state
-- when a report filters to the older dimension (same subject and context).
select public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',current_setting('qa.metric')::jsonb||jsonb_build_object('event_id',gen_random_uuid(),'event_name','test_state','state_value','active','occurred_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
select public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',current_setting('qa.metric')::jsonb||jsonb_build_object('event_id',gen_random_uuid(),'event_name','test_state','state_value','inactive','channel','organic','occurred_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
select public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',current_setting('qa.metric')::jsonb||jsonb_build_object('event_id',gen_random_uuid(),'event_name','test_presence','state_value','active','session_id','session_123','occurred_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'presence_expires_at',to_char(clock_timestamp()+interval '4 minutes','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
select public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',current_setting('qa.metric')::jsonb||jsonb_build_object('event_id',gen_random_uuid(),'event_name','test_presence','state_value','left','channel','organic','session_id','session_123','occurred_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'presence_expires_at',to_char(clock_timestamp()+interval '4 minutes','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
select set_config('qa.report',jsonb_build_object('product_id','ac570000-0000-4000-8000-000000000001','funnel_id','ac570000-0000-4000-8000-000000000002','date_from',current_date::text,'date_to',current_date::text,'time_zone','UTC')::text,true);
set local role authenticated;
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.report')::jsonb)#>>'{metrics,0,value}'='2','unfiltered prior report preserved');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.report')::jsonb||'{"channel":"creator","entry_variant":"book","webinar_id":"event_1","intake_id":"intake_1","context_id":"group_123"}')#>>'{metrics,0,value}'='1','all dimensions filter same scoped relation');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.report')::jsonb||'{"channel":"missing"}')#>>'{metrics,0,value}'='0','connected source with no matching dimension is zero');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.report')::jsonb||'{"channel":"missing"}')#>>'{metrics,1,availability}'='awaiting_data','unconnected source remains distinct');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.report')::jsonb||'{"channel":"creator"}')#>>'{metrics,2,value}'='0','filtered current state cannot revive superseded evidence');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.report')::jsonb||'{"channel":"creator"}')#>>'{metrics,3,value}'='0','filtered presence cannot revive a departed session');
select pg_temp.reject('select public.get_admin_funnel_metrics_report(current_setting(''qa.report'')::jsonb||''{"channel":"person@example.com"}'')','personal values rejected');
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000012","role":"authenticated"}',true);
select pg_temp.check_true(public.get_partner_funnel_metrics_report(current_setting('qa.report')::jsonb||'{"channel":"creator"}')#>>'{metrics,0,value}'='1','creator dimensions retain self scope');
select pg_temp.reject('select public.get_partner_funnel_metrics_report(current_setting(''qa.report'')::jsonb||''{"channel":"creator","affiliate_id":"ac570000-0000-4000-8000-000000000014"}'')','filters cannot switch creator');
reset role;
select pg_temp.make_order(1,8000,false,clock_timestamp());
select public.ingest_external_order_eligibility('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',jsonb_build_object('event_id',gen_random_uuid(),'click_id','opaque_fixture_click_123456','external_order_id',(select core#>>'{input,order_id}' from test_external_orders where n=1),'stripe_account_id','acct_fixture','livemode',false,'subject_id','opaque_customer_fixture_123456','purchase_sequence',1,'context_id','group_123','status','fulfilled','occurred_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'channel','creator','entry_variant','book','webinar_id','event_1','intake_id','intake_1'));
select pg_temp.admin();set local role authenticated;
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.report')::jsonb||'{"channel":"creator"}')#>>'{commerce,currencies,0,purchases}'='1','verified sales filtered by trusted order context');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.report')::jsonb||'{"channel":"organic"}')#>'{commerce,currencies}'='[]'::jsonb,'sales do not leak into another channel');
reset role;
select pg_temp.check_true((select count(*)=0 from public.external_commission_awards),'measurement never creates earnings');
rollback;
