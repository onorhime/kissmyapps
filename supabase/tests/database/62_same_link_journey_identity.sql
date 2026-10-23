-- Provider-free test: two valid visits through one creator link become one
-- signup journey, while their original click references stay immutable.
begin;
set local time zone 'UTC';
\i supabase/tests/fixtures/external-canonical.sql
insert into public.funnel_journey_configuration(funnel_id,environment,conversion_window_days) values('ac570000-0000-4000-8000-000000000002','test',30);
insert into public.funnel_journey_clicks(click_record_id,environment) values('ac570000-0000-4000-8000-000000000005','test');
insert into public.affiliate_links(id,affiliate_id,product_id,funnel_id,name,public_code,tracking_url,sub1,status)
values('ac620000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000014','ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','Other creator link','other_identity_link','https://tracking.example.invalid/r/settlement-other/other_identity_link','other','paused'),
('ac620000-0000-4000-8000-000000000002','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','Same creator different link','another_identity_link','https://tracking.example.invalid/r/external-fixture/another_identity_link','another','paused');
insert into public.clicks(id,public_click_id,affiliate_link_id,affiliate_id,product_id,funnel_id,sub1,destination_url_snapshot,occurred_at,created_at,is_bot)
select ('ac620001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'revisit_fixture_click_'||lpad(n::text,3,'0'),
case n when 2 then 'ac620000-0000-4000-8000-000000000001'::uuid when 3 then 'ac620000-0000-4000-8000-000000000002'::uuid else 'ac570000-0000-4000-8000-000000000004'::uuid end,
case n when 2 then 'ac570000-0000-4000-8000-000000000014'::uuid else 'ac570000-0000-4000-8000-000000000003'::uuid end,
'ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',case n when 2 then 'other' when 3 then 'another' else 'fixture' end,'https://marathon.example.invalid',now()-interval '19 days',now()-interval '19 days',n=5
from generate_series(1,6)n;
insert into public.acquisitions(product_id,affiliate_id,click_record_id,funnel_id,attribution_method,created_at)
select c.product_id,c.affiliate_id,c.id,c.funnel_id,'deterministic_web',c.occurred_at from public.clicks c where c.id::text like 'ac620001%' and c.id<>'ac620001-0000-4000-8000-000000000006';
-- Explicit synthetic LIVE classification, never changing real click records.
alter table public.funnel_journey_clicks disable trigger funnel_journey_click_immutable;
update public.funnel_journey_clicks set environment='live' where click_record_id='ac620001-0000-4000-8000-000000000004';
alter table public.funnel_journey_clicks enable trigger funnel_journey_click_immutable;
create function pg_temp.revisit_event(event text,person text,click text,days numeric,extra jsonb default '{}') returns jsonb language plpgsql as $$begin
 return public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',jsonb_build_object('schema_version','2','environment','test','event_id',gen_random_uuid(),'event_name',event,'click_id',click,'subject_id',person,'dedupe_key',gen_random_uuid()::text,'occurred_at',to_char(statement_timestamp()-make_interval(secs=>(days*86400)::double precision),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))||extra);
end$$;
select set_config('qa.revisit.report',jsonb_build_object('product_id','ac570000-0000-4000-8000-000000000001','funnel_id','ac570000-0000-4000-8000-000000000002','date_from',(current_date-25)::text,'date_to',current_date::text,'time_zone','UTC','environment','test','conversion_window_days',30)::text,true);
set local role authenticated;
select public.save_admin_funnel_journey_definition('{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":0,"template":"custom","definition":{"stages":[{"key":"visited","label":"Landing visitors","source":"event","event_names":["landing_page_viewed"]},{"key":"signed_up","label":"Email leads","source":"event","event_names":["lead_created"]}],"rates":[{"key":"visit_signup","label":"Visit to signup","steps":["visited","signed_up"]}],"paths":[]}}');
select public.publish_admin_funnel_journey_definition('{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":1}');
reset role;
select pg_temp.revisit_event('landing_page_viewed','landing_visitor_before_1234','opaque_fixture_click_123456',18);
select pg_temp.revisit_event('lead_created','email_lead_before_123456','revisit_fixture_click_001',17);
select pg_temp.revisit_event('identity_linked','verified_learner_before_1234','revisit_fixture_click_001',16,'{"aliased_subject_id":"email_lead_before_123456","state_value":"verified"}');
select pg_temp.revisit_event('email_verified','verified_learner_before_1234','revisit_fixture_click_001',16);
select pg_temp.revisit_event('identity_linked','verified_learner_before_1234','revisit_fixture_click_001',16,'{"aliased_subject_id":"landing_visitor_before_1234","aliased_click_id":"opaque_fixture_click_123456","state_value":"verified","dedupe_key":"visitor_link:before"}');
select pg_temp.check_true((select count(distinct canonical_subject_id)=1 and count(distinct click_record_id)=2 from public.funnel_journey_identities where subject_id in('landing_visitor_before_1234','email_lead_before_123456','verified_learner_before_1234')),'two clicks become one learner without rewriting either click');
-- Retry uses the original evidence (new transport ID is allowed).
select pg_temp.check_true((select public.ingest_funnel_metric_event(product_id,funnel_id,evidence||jsonb_build_object('event_id',gen_random_uuid()))->>'duplicate'='true' from public.funnel_metric_events where business_key='visitor_link:before'),'same identity evidence retries safely');
-- Deliver the alias BEFORE either origin event: both clicks remain correct.
select pg_temp.revisit_event('identity_linked','verified_learner_after_1234','revisit_fixture_click_001',16,'{"aliased_subject_id":"landing_visitor_after_1234","aliased_click_id":"opaque_fixture_click_123456","state_value":"verified"}');
select pg_temp.revisit_event('landing_page_viewed','landing_visitor_after_1234','opaque_fixture_click_123456',18);
select pg_temp.revisit_event('lead_created','verified_learner_after_1234','revisit_fixture_click_001',17);
select pg_temp.revisit_event('email_verified','verified_learner_after_1234','revisit_fixture_click_001',16);
select pg_temp.check_true((select click_record_id='ac570000-0000-4000-8000-000000000005' from public.funnel_journey_identities where subject_id='landing_visitor_after_1234'),'alias-first delivery preserves anonymous click');
select pg_temp.check_true((select click_record_id='ac620001-0000-4000-8000-000000000001' from public.funnel_journey_identities where subject_id='verified_learner_after_1234'),'alias-first delivery preserves stable learner click');
set local role authenticated;
select pg_temp.check_true((select r->>'denominator'='2' and r->>'numerator'='2' and r->>'value'='100.00' from jsonb_array_elements(public.get_admin_funnel_metrics_report(current_setting('qa.revisit.report')::jsonb)#>'{journey,configured_rates}')r where r->>'key'='visit_signup'),'landing-to-signup report counts both ordered learners across click tokens');
reset role;
-- Ordinary events still cannot replace stable acquisition even on the same link.
select pg_temp.reject($q$select pg_temp.revisit_event('resource_opened','verified_learner_before_1234','opaque_fixture_click_123456',0)$q$,'ordinary events cannot reassign canonical click');
select pg_temp.reject($q$select pg_temp.revisit_event('identity_linked','another_verified_learner_1234','revisit_fixture_click_001',0,'{"aliased_subject_id":"landing_visitor_before_1234","aliased_click_id":"opaque_fixture_click_123456","state_value":"verified"}')$q$,'shared browser cannot merge two verified people');
select pg_temp.reject($q$select pg_temp.revisit_event('identity_linked','verified_learner_before_1234','revisit_fixture_click_001',0,'{"aliased_subject_id":"other_creator_visitor_1234","aliased_click_id":"revisit_fixture_click_002","state_value":"verified"}')$q$,'another creator cannot be merged');
select pg_temp.reject($q$select pg_temp.revisit_event('identity_linked','verified_learner_before_1234','revisit_fixture_click_001',0,'{"aliased_subject_id":"other_link_visitor_1234","aliased_click_id":"revisit_fixture_click_003","state_value":"verified"}')$q$,'different link is conservatively rejected even for same creator');
select pg_temp.reject($q$select pg_temp.revisit_event('identity_linked','verified_learner_before_1234','revisit_fixture_click_001',0,'{"aliased_subject_id":"live_click_visitor_1234","aliased_click_id":"revisit_fixture_click_004","state_value":"verified"}')$q$,'live alias never joins test journey');
select pg_temp.reject($q$select pg_temp.revisit_event('identity_linked','verified_learner_before_1234','revisit_fixture_click_001',0,'{"aliased_subject_id":"bot_click_visitor_1234","aliased_click_id":"revisit_fixture_click_005","state_value":"verified"}')$q$,'bot alias rejected');
select pg_temp.reject($q$select pg_temp.revisit_event('identity_linked','verified_learner_before_1234','revisit_fixture_click_001',0,'{"aliased_subject_id":"no_acquisition_visitor_1234","aliased_click_id":"revisit_fixture_click_006","state_value":"verified"}')$q$,'unattributed alias rejected');
select pg_temp.reject($q$select pg_temp.revisit_event('identity_linked','verified_learner_before_1234','revisit_fixture_click_001',0,'{"aliased_subject_id":"unknown_visitor_1234","aliased_click_id":"unknown_click_123456789","state_value":"verified"}')$q$,'unknown opaque token is not trusted evidence');
select pg_temp.reject($q$select pg_temp.revisit_event('resource_opened','verified_learner_before_1234','revisit_fixture_click_001',0,'{"aliased_click_id":"opaque_fixture_click_123456"}')$q$,'alias evidence restricted to verified identity events');
select pg_temp.check_true(not exists(select 1 from public.external_commerce_orders),'journey linkage creates no orders or commissions');
select pg_temp.check_true(not has_function_privilege('authenticated','public.ingest_funnel_metric_event(uuid,uuid,jsonb)','execute') and not has_function_privilege('service_role','public.ingest_funnel_metric_event_before_link_environments(uuid,uuid,jsonb)','execute'),'only scoped service ingress exposed');
rollback;
