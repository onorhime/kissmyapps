-- Disposable, provider-free regression of product-owned journey definitions.
begin;
set local time zone 'UTC';
\i supabase/tests/fixtures/external-canonical.sql
select set_config('qa.generic.report',jsonb_build_object('product_id','ac570000-0000-4000-8000-000000000001','funnel_id','ac570000-0000-4000-8000-000000000002','date_from',(current_date-25)::text,'date_to',current_date::text,'time_zone','UTC','environment','test','conversion_window_days',30)::text,true);
select set_config('qa.generic.definition','{
 "stages":[
 {"key":"started","label":"Trial started","source":"event","event_names":["trial_started"]},
 {"key":"activated","label":"Workspace activated","source":"event","event_names":["workspace_activated"],"context_field":"context_id"},
 {"key":"retained","label":"Active workspace","source":"event","event_names":["workspace_state","workspace_status"],"state_value":"active","context_field":"context_id"},
 {"key":"completed","label":"Project completed","source":"event","event_names":["project_completed"],"context_field":"context_id"},
 {"key":"registered","label":"Demo registered","source":"event","event_names":["demo_registered"],"context_field":"context_id"},
 {"key":"attended","label":"Confirmed demo attendance","source":"event","event_names":["demo_attendance"],"state_value":"attended","context_field":"context_id"},
 {"key":"assessment_start","label":"Attempt started","source":"event","event_names":["assessment_started"],"context_field":"assessment_attempt_id"},
 {"key":"assessment_end","label":"Attempt completed","source":"event","event_names":["assessment_completed"],"context_field":"assessment_attempt_id"},
 {"key":"paid","label":"Verified purchasers","source":"purchase"}],
 "rates":[
 {"key":"activation","label":"Trial to activation","steps":["started","activated"]},
 {"key":"retention","label":"Activation to active workspace","steps":["activated","retained"]},
 {"key":"attendance","label":"Demo attendance rate","steps":["registered","attended"]},
 {"key":"assessment","label":"Same attempt completion","steps":["assessment_start","assessment_end"]}],
 "paths":[
 {"key":"product_paid","label":"Trial through paid use","steps":["started","activated","retained","completed","paid"]},
 {"key":"demo_paid","label":"Demo through payment","steps":["registered","attended","paid"]},
 {"key":"two_contexts","label":"Workspace and assessment then purchase","steps":["activated","assessment_start","assessment_end","completed","paid"]}]
}',true);
create function pg_temp.generic_event(event text,person text,days numeric,extra jsonb default '{}') returns jsonb language plpgsql as $$
declare packet jsonb;
begin
 packet:=jsonb_build_object('schema_version','2','environment','test','event_id',gen_random_uuid(),'event_name',event,'click_id','opaque_fixture_click_123456','subject_id',person,'dedupe_key',gen_random_uuid()::text,'occurred_at',to_char(statement_timestamp()-make_interval(secs=>(days*86400)::double precision),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))||extra;
 return public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002',packet);
end;$$;
create function pg_temp.journey_value(section text,key text,field text,filters jsonb default '{}') returns text language sql as $$
 select item->>field from jsonb_array_elements(public.get_admin_funnel_metrics_report(current_setting('qa.generic.report')::jsonb||filters)->'journey'->section) item where item->>'key'=key;
$$;
grant execute on function pg_temp.journey_value(text,text,text,jsonb) to authenticated;
set local role authenticated;
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac570000-0000-4000-8000-000000000002')->'published'='null'::jsonb,'new funnel has no hidden webinar template');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.generic.report')::jsonb)#>'{journey,configured_stages}'='[]'::jsonb,'unpublished journey reports no hidden stages');
select public.save_admin_funnel_journey_definition(jsonb_build_object('funnel_id','ac570000-0000-4000-8000-000000000002','expected_revision',0,'template','custom','definition',current_setting('qa.generic.definition')::jsonb));
select pg_temp.reject('select public.save_admin_funnel_journey_definition(jsonb_build_object(''funnel_id'',''ac570000-0000-4000-8000-000000000002'',''expected_revision'',0,''template'',''custom'',''definition'',current_setting(''qa.generic.definition'')::jsonb))','stale draft cannot overwrite');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.generic.report')::jsonb)#>'{journey,configured_stages}'='[]'::jsonb,'saving draft cannot change published report');
reset role;
select pg_temp.reject('select pg_temp.generic_event(''trial_started'',''generic_good_guest_123456789'',18)','draft custom stage cannot authorize ingestion');
set local role authenticated;
select public.publish_admin_funnel_journey_definition('{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":1}');
select pg_temp.reject('select public.publish_admin_funnel_journey_definition(''{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":1}'')','repeat publish stale revision rejected');
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac570000-0000-4000-8000-000000000002')#>>'{published,version}'='1','definition publication is versioned');
select pg_temp.check_true(pg_temp.journey_value('configured_rates','activation','status')='zero_denominator','unobserved rates have no fabricated percentage');
reset role;
-- Published journey events need no custom reporting card.
select pg_temp.generic_event('trial_started','generic_good_guest_123456789',18);
select pg_temp.generic_event('trial_started','generic_good_verified_123456789',17.5);
select pg_temp.generic_event('identity_linked','generic_good_verified_123456789',17,'{"aliased_subject_id":"generic_good_guest_123456789","state_value":"verified"}');
select pg_temp.generic_event('workspace_activated','generic_good_verified_123456789',16,'{"context_id":"workspace_a"}');
select pg_temp.generic_event('workspace_state','generic_good_verified_123456789',15,'{"context_id":"workspace_a","state_value":"inactive","state_revision":"1","channel":"organic"}');
select pg_temp.generic_event('workspace_status','generic_good_verified_123456789',14,'{"context_id":"workspace_a","state_value":"active","state_revision":"2","channel":"creator"}');
select pg_temp.generic_event('workspace_state','generic_good_guest_123456789',13,'{"context_id":"workspace_a","state_value":"inactive","state_revision":"1","channel":"organic"}');
select pg_temp.generic_event('project_completed','generic_good_verified_123456789',12,'{"context_id":"workspace_a"}');
select pg_temp.generic_event('assessment_started','generic_good_verified_123456789',15,'{"assessment_attempt_id":"attempt_a"}');
select pg_temp.generic_event('assessment_completed','generic_good_verified_123456789',14,'{"assessment_attempt_id":"attempt_a"}');
select pg_temp.generic_event('demo_registered','generic_good_verified_123456789',11,'{"context_id":"demo_a"}');
select pg_temp.generic_event('demo_attendance','generic_good_verified_123456789',10,'{"context_id":"demo_a","state_value":"attended","state_revision":"2"}');
select pg_temp.generic_event('demo_attendance','generic_good_verified_123456789',9,'{"context_id":"demo_a","state_value":"unknown","state_revision":"1"}');
select pg_temp.make_order(1,8000,false,statement_timestamp()-interval '2 days');
select pg_temp.generic_event('checkout_created','generic_good_verified_123456789',3,jsonb_build_object('order_id',(select core#>>'{input,order_id}' from test_external_orders where n=1)));
-- Reversed ordering, different contexts and different learners never convert.
select pg_temp.generic_event('workspace_activated','generic_reverse_123456789',16,'{"context_id":"workspace_b"}');
select pg_temp.generic_event('trial_started','generic_reverse_123456789',14);
select pg_temp.generic_event('trial_started','generic_cross_123456789',18);
select pg_temp.generic_event('workspace_activated','generic_cross_123456789',17,'{"context_id":"workspace_c"}');
select pg_temp.generic_event('workspace_state','generic_cross_123456789',16,'{"context_id":"workspace_d","state_value":"active","state_revision":"1"}');
select pg_temp.generic_event('project_completed','generic_cross_123456789',15,'{"context_id":"workspace_c"}');
select pg_temp.generic_event('demo_registered','generic_cross_123456789',12,'{"context_id":"demo_b"}');
select pg_temp.generic_event('demo_attendance','generic_cross_123456789',11,'{"context_id":"demo_c","state_value":"attended","state_revision":"1"}');
select pg_temp.generic_event('assessment_started','generic_cross_123456789',10,'{"assessment_attempt_id":"attempt_b"}');
select pg_temp.generic_event('assessment_completed','generic_cross_123456789',9,'{"assessment_attempt_id":"attempt_c"}');
select pg_temp.generic_event('trial_started','generic_only_start_123456789',18);
select pg_temp.generic_event('workspace_activated','generic_only_activate_123456789',17,'{"context_id":"workspace_e"}');
-- Missing context is accepted as evidence, but cannot claim a contextual stage.
select pg_temp.generic_event('workspace_activated','generic_missing_context_123456789',17);
-- A newer inactive state on another channel must not resurrect old active state.
select pg_temp.generic_event('workspace_state','generic_superseded_123456789',15,'{"context_id":"workspace_f","state_value":"active","state_revision":"1","channel":"creator"}');
select pg_temp.generic_event('workspace_state','generic_superseded_123456789',14,'{"context_id":"workspace_f","state_value":"inactive","state_revision":"2","channel":"organic"}');
set local role authenticated;
select pg_temp.check_true(pg_temp.journey_value('configured_stages','started','people')='4','aliases collapse to one distinct person');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','activated','people')='4','contextual stages exclude missing context');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','retained','people')='2','state revision outranks delayed timestamps across aliases and event aliases');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','retained','people','{"channel":"creator"}')='1','dimension filter cannot revive superseded state');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','retained','people','{"channel":"organic"}')='0','newer active state is not rewritten by organic filter');
select pg_temp.check_true(pg_temp.journey_value('configured_rates','activation','numerator')='2','ordered rate rejects reversed order and cross-person matching');
select pg_temp.check_true(pg_temp.journey_value('configured_rates','activation','denominator')='4','rate denominator is distinct people at first stage');
select pg_temp.check_true(pg_temp.journey_value('configured_rates','activation','value')='50.00','ordered conversion percentage uses one cohort');
select pg_temp.check_true(pg_temp.journey_value('configured_rates','retention','numerator')='1','same context required across sequence');
select pg_temp.check_true(pg_temp.journey_value('configured_rates','attendance','numerator')='1','different demo context cannot become attendance conversion');
select pg_temp.check_true(pg_temp.journey_value('configured_rates','assessment','numerator')='1','different assessment attempt cannot become completion conversion');
select pg_temp.check_true(pg_temp.journey_value('configured_paths','product_paid','people')='1','full ordered arbitrary product path counts person');
select pg_temp.check_true(pg_temp.journey_value('configured_paths','demo_paid','people')='1','paths intentionally overlap for same paid person');
select pg_temp.check_true(pg_temp.journey_value('configured_paths','two_contexts','people')='1','independent context fields do not require same context value');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','paid','people')='1','only verified ledger establishes paid stage');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','paid','people','{"currency":"EUR"}')='0','purchase facts honor currency');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','paid','people','{"conversion_window_days":10}')='0','conversion window follows acquisition not report event dates');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','started','people',jsonb_build_object('date_from',current_date::text))='0','old acquisition not credited to today cohort');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','started','people','{"environment":"live"}')='0','test journey evidence excluded from live');
select pg_temp.reject('select public.get_admin_funnel_metrics_report(current_setting(''qa.generic.report'')::jsonb||''{"journey_version":99}'')','unknown published version rejected');
select pg_temp.reject('select public.get_admin_funnel_metrics_report(current_setting(''qa.generic.report'')::jsonb||''{"journey_version":null}'')','null published version rejected');
reset role;
-- Existing business evidence and financial ingestion boundaries are unchanged.
select pg_temp.reject('select pg_temp.generic_event(''purchase_completed'',''generic_good_verified_123456789'',1)','generic event cannot mint purchase');
select pg_temp.reject('select pg_temp.generic_event(''completely_unknown_event'',''generic_good_verified_123456789'',1)','unconfigured noncanonical events rejected');
select pg_temp.reject('update public.funnel_journey_definition_versions set definition=''{}'' where funnel_id=''ac570000-0000-4000-8000-000000000002''','published definitions cannot be rewritten');
select pg_temp.reject('delete from public.funnel_journey_definition_versions','published definitions cannot be deleted');
-- Restrict every write and validation boundary, independently of UI validation.
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":[{"key":"x","label":"x","source":"purchase","event_names":["lead_created"]}],"rates":[],"paths":[]}'')','purchase source forbids sender event rules');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":[{"key":"x","label":"x","source":"event","event_names":["purchase_completed"]}],"rates":[],"paths":[]}'')','financial event names reserved');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":[{"key":"x","label":"x","source":"event","event_names":["identity_linked"]}],"rates":[],"paths":[]}'')','identity infrastructure is not a report stage');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":[{"key":"x","label":"x","source":"purchase"},{"key":"x","label":"duplicate","source":"purchase"}],"rates":[],"paths":[]}'')','duplicate stage key rejected');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":[{"key":"x","label":"x","source":"purchase"}],"rates":[{"key":"rate","label":"Bad reference","steps":["x","missing"]}],"paths":[]}'')','missing references rejected');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":[{"key":"x","label":"x","source":"purchase"}],"rates":[{"key":"rate","label":"Repeated step","steps":["x","x"]}],"paths":[]}'')','looping repeated stages rejected');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(jsonb_build_object(''stages'',(select jsonb_agg(jsonb_build_object(''key'',''s''||n,''label'',''Stage'',''source'',''purchase'')) from generate_series(1,21)n),''rates'',''[]''::jsonb,''paths'',''[]''::jsonb))','bounded stage count enforced');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(null)','missing definition rejected');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":null,"rates":[],"paths":[]}'')','null stages rejected');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":[{"key":"x","label":"x","source":"event","event_names":["event","event"]}],"rates":[],"paths":[]}'')','duplicate event aliases rejected');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(''{"stages":[{"key":"x","label":"x","source":"event","event_names":["event"],"context_field":"email"}],"rates":[],"paths":[]}'')','unsupported personal context field rejected');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(jsonb_set(current_setting(''qa.generic.definition'')::jsonb,''{rates}'',(select jsonb_agg(jsonb_build_object(''key'',''r''||n,''label'',''Rate'',''steps'',''["started","paid"]''::jsonb)) from generate_series(1,21)n)))','rate count bounded');
select pg_temp.reject('select kma_internal.validate_funnel_journey_definition(jsonb_set(current_setting(''qa.generic.definition'')::jsonb,''{paths}'',''[{"key":"p","label":"Too many steps","steps":["started","activated","retained","completed","registered","attended","assessment_start","assessment_end","paid"]}]''::jsonb))','path step count bounded');
insert into auth.users(id,email) values('ac600000-0000-4000-8000-000000000050','journey-analyst@example.invalid');
insert into public.admin_users(user_id,role) values('ac600000-0000-4000-8000-000000000050','analyst');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"ac600000-0000-4000-8000-000000000050","role":"authenticated"}',true);
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac570000-0000-4000-8000-000000000002')#>>'{published,version}'='1','analyst may inspect published rules');
select pg_temp.reject('select public.save_admin_funnel_journey_definition(jsonb_build_object(''funnel_id'',''ac570000-0000-4000-8000-000000000002'',''expected_revision'',2,''template'',''custom'',''definition'',current_setting(''qa.generic.definition'')::jsonb))','analyst cannot edit definitions');
select pg_temp.admin();
select pg_temp.reject('select public.save_admin_funnel_journey_definition(''{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":2,"template":"custom"}'')','save requires definition');
select pg_temp.reject('select public.publish_admin_funnel_journey_definition(''{"funnel_id":"ac570000-0000-4000-8000-000000000002"}'')','publication requires expected revision');
select pg_temp.reject('select * from public.funnel_journey_definition_drafts','browser cannot read draft table directly');
select pg_temp.reject('select kma_internal.import_existing_webinar_journey_definitions()','browser cannot invoke backfill');
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000012","role":"authenticated"}',true);
select pg_temp.check_true(public.get_partner_funnel_metrics_report(current_setting('qa.generic.report')::jsonb)#>>'{journey,definition_version}'='1','creator sees selected published rules');
select pg_temp.reject('select public.get_admin_funnel_journey_definition(''ac570000-0000-4000-8000-000000000002'')','creator cannot read admin definitions');
select pg_temp.reject('select public.publish_admin_funnel_journey_definition(''{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":2}'')','creator cannot publish');
select pg_temp.reject('select public.get_partner_funnel_metrics_report(current_setting(''qa.generic.report'')::jsonb||''{"affiliate_id":"ac570000-0000-4000-8000-000000000014"}'')','dynamic report never bypasses creator self scope');
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000013","role":"authenticated"}',true);
select pg_temp.reject('select public.get_partner_funnel_metrics_report(current_setting(''qa.generic.report'')::jsonb)','unrelated creator denied product report');
select pg_temp.admin();
-- A new blank version removes stages explicitly without deleting old evidence.
select public.save_admin_funnel_journey_definition('{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":2,"template":"blank","definition":{"stages":[],"rates":[],"paths":[]}}');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.generic.report')::jsonb)#>>'{journey,definition_version}'='1','draft edits do not affect published report');
select public.publish_admin_funnel_journey_definition('{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":3}');
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.generic.report')::jsonb)#>'{journey,configured_stages}'='[]'::jsonb,'explicit blank publication removes hidden stages');
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac570000-0000-4000-8000-000000000002')#>>'{versions,1,version}'='1','old definition remains selectable');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','started','people','{"journey_version":1}')='4','historical version uses its own saved rules');
reset role;
select pg_temp.generic_event('trial_started','generic_late_delivery_123456789',16);
set local role authenticated;
select pg_temp.check_true(pg_temp.journey_value('configured_stages','started','people','{"journey_version":1}')='5','old published event remains authorized for delayed delivery');
reset role;
-- Another product can publish its own event vocabulary. Neither events nor
-- published definitions bleed across products/funnels even with shared labels.
insert into public.products(id,slug,name) values('ac600000-0000-4000-8000-000000000001','generic-second-product','Workshop product');
insert into public.funnels(id,product_id,key,name,destination_url) values('ac600000-0000-4000-8000-000000000002','ac600000-0000-4000-8000-000000000001','workshop','Workshop funnel','https://workshop.example.invalid');
insert into public.affiliate_links(id,affiliate_id,product_id,funnel_id,name,public_code,tracking_url,sub1,status) values('ac600000-0000-4000-8000-000000000004','ac570000-0000-4000-8000-000000000003','ac600000-0000-4000-8000-000000000001','ac600000-0000-4000-8000-000000000002','Workshop link','generic_workshop_link','https://tracking.example.invalid/r/external-fixture/generic_workshop_link','fixture','paused');
insert into public.clicks(id,public_click_id,affiliate_link_id,affiliate_id,product_id,funnel_id,sub1,destination_url_snapshot,occurred_at) values('ac600000-0000-4000-8000-000000000005','opaque_workshop_click_123456','ac600000-0000-4000-8000-000000000004','ac570000-0000-4000-8000-000000000003','ac600000-0000-4000-8000-000000000001','ac600000-0000-4000-8000-000000000002','fixture','https://workshop.example.invalid',statement_timestamp()-interval '20 days');
insert into public.acquisitions(id,product_id,affiliate_id,click_record_id,funnel_id,attribution_method,created_at) values('ac600000-0000-4000-8000-000000000006','ac600000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000003','ac600000-0000-4000-8000-000000000005','ac600000-0000-4000-8000-000000000002','deterministic_web',statement_timestamp()-interval '20 days');
set local role authenticated;
select public.save_admin_funnel_journey_definition('{"funnel_id":"ac600000-0000-4000-8000-000000000002","expected_revision":0,"template":"custom","definition":{"stages":[{"key":"reserved","label":"Workshop reserved","source":"event","event_names":["workshop_reserved"]}],"rates":[],"paths":[]}}');
select public.publish_admin_funnel_journey_definition('{"funnel_id":"ac600000-0000-4000-8000-000000000002","expected_revision":1}');
reset role;
select set_config('qa.workshop.event',jsonb_build_object('schema_version','2','environment','test','event_id',gen_random_uuid(),'event_name','workshop_reserved','click_id','opaque_workshop_click_123456','subject_id','generic_good_verified_123456789','dedupe_key','workshop_reserved_one','occurred_at',to_char(statement_timestamp()-interval '10 days','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,true);
select public.ingest_funnel_metric_event('ac600000-0000-4000-8000-000000000001','ac600000-0000-4000-8000-000000000002',current_setting('qa.workshop.event')::jsonb);
select pg_temp.reject('select pg_temp.generic_event(''workshop_reserved'',''generic_good_verified_123456789'',1)','another product cannot authorize current product event');
select pg_temp.reject('select public.ingest_funnel_metric_event(''ac570000-0000-4000-8000-000000000001'',''ac600000-0000-4000-8000-000000000002'',current_setting(''qa.workshop.event'')::jsonb)','wrong product/funnel scope cannot ingest');
set local role authenticated;
select pg_temp.check_true(public.get_admin_funnel_metrics_report(current_setting('qa.generic.report')::jsonb||'{"product_id":"ac600000-0000-4000-8000-000000000001","funnel_id":"ac600000-0000-4000-8000-000000000002"}')#>>'{journey,configured_stages,0,people}'='1','second product reports only its configured vocabulary');
select pg_temp.check_true(pg_temp.journey_value('configured_stages','started','people','{"journey_version":1}')='5','same subject name in another product stays isolated');
-- Backfill is selective: explicit webinar template AND configured tracking.
select public.configure_admin_funnel_journey('{"funnel_id":"ac600000-0000-4000-8000-000000000002","environment":"test"}');
reset role;
select pg_temp.check_true(kma_internal.import_existing_webinar_journey_definitions()=0,'backfill never replaces authored custom or blank versions');
select pg_temp.check_true((select count(*) from public.funnel_journey_definition_versions)=3,'existing history survives repeated backfill');
insert into public.funnels(id,product_id,key,name,destination_url)
select ('ac600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'ac600000-0000-4000-8000-000000000001','import-'||n,'Import case '||n,'https://workshop.example.invalid' from generate_series(31,34)n;
set local role authenticated;
select public.save_admin_funnel_metrics_draft(jsonb_build_object('funnel_id','ac600000-0000-4000-8000-'||lpad(n::text,12,'0'),'expected_revision',0,'template','webinar','metrics','[{"key":"registered","label":"Registered","type":"unique_people","event_name":"webinar_registered"}]'::jsonb)) from (values(31),(33),(34)) f(n);
select public.publish_admin_funnel_metrics(('ac600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,1) from (values(31),(33),(34)) f(n);
select public.configure_admin_funnel_journey(jsonb_build_object('funnel_id','ac600000-0000-4000-8000-'||lpad(n::text,12,'0'),'environment','test')) from (values(31),(32),(34)) f(n);
select public.save_admin_funnel_journey_definition('{"funnel_id":"ac600000-0000-4000-8000-000000000034","expected_revision":0,"template":"custom","definition":{"stages":[],"rates":[],"paths":[]}}');
reset role;
select pg_temp.check_true(kma_internal.import_existing_webinar_journey_definitions()=1,'only explicitly configured webinar reporting receives inherited template');
select pg_temp.check_true(kma_internal.import_existing_webinar_journey_definitions()=0,'import is idempotent');
set local role authenticated;
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac600000-0000-4000-8000-000000000031')#>>'{published,template}'='webinar','imported webinar rules are visible as a published version');
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac600000-0000-4000-8000-000000000032')->'published'='null'::jsonb,'tracking configuration alone does not add webinar stages');
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac600000-0000-4000-8000-000000000033')->'published'='null'::jsonb,'webinar cards alone do not enable a hidden journey');
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac600000-0000-4000-8000-000000000034')#>>'{draft,template}'='custom','existing unpublished custom draft remains untouched');
select pg_temp.check_true(public.get_admin_funnel_journey_definition('ac600000-0000-4000-8000-000000000034')->'published'='null'::jsonb,'backfill does not publish an authored draft');
reset role;
rollback;
