-- Only executed by --keep in a freshly initialized, disposable native cluster.
set time zone 'UTC';
insert into auth.users(id,email,email_confirmed_at) values
('ac570000-0000-4000-8000-000000000011','metric-admin@example.invalid',now()),
('ac570000-0000-4000-8000-000000000012','metric-partner@example.invalid',now()),
('ac570000-0000-4000-8000-000000000013','other-partner@example.invalid',now());
insert into public.admin_users(user_id,role) values('ac570000-0000-4000-8000-000000000011','owner');
update public.affiliates set status='active' where id='ac570000-0000-4000-8000-000000000003';
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at) values('ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000012','owner',true,false,now());
insert into public.affiliates(id,public_name,slug,status) values('ac570000-0000-4000-8000-000000000014','Unrelated creator','metric-other','active');
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at) values('ac570000-0000-4000-8000-000000000014','ac570000-0000-4000-8000-000000000013','owner',true,false,now());
insert into public.products(id,slug,name) values('ac570000-0000-4000-8000-000000000041','generic-course-fixture','Generic course fixture');
insert into public.funnels(id,product_id,key,name,destination_url) values('ac570000-0000-4000-8000-000000000042','ac570000-0000-4000-8000-000000000041','course-launch','Course launch','https://course.example.invalid');
insert into public.affiliate_links(id,affiliate_id,product_id,funnel_id,name,public_code,tracking_url,sub1,status) values('ac570000-0000-4000-8000-000000000044','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000041','ac570000-0000-4000-8000-000000000042','Course link','course_fixture_link','https://tracking.example.invalid/r/external-fixture/course_fixture_link','course','paused');
insert into public.clicks(id,public_click_id,affiliate_link_id,affiliate_id,product_id,funnel_id,sub1,destination_url_snapshot) values('ac570000-0000-4000-8000-000000000045','opaque_course_click_123456','ac570000-0000-4000-8000-000000000044','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000041','ac570000-0000-4000-8000-000000000042','course','https://course.example.invalid');
insert into public.acquisitions(id,product_id,affiliate_id,click_record_id,funnel_id,attribution_method) values('ac570000-0000-4000-8000-000000000046','ac570000-0000-4000-8000-000000000041','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000045','ac570000-0000-4000-8000-000000000042','deterministic_web');
select set_config('request.jwt.claims','{"sub":"ac570000-0000-4000-8000-000000000011","role":"authenticated"}',false);
set role authenticated;
select public.save_admin_funnel_metrics_draft('{"funnel_id":"ac570000-0000-4000-8000-000000000002","expected_revision":0,"template":"webinar","metrics":[
{"key":"registrations","label":"Webinar registrations","type":"unique_per_context","event_name":"webinar_registered","visible":true},
{"key":"started","label":"Assessments started","type":"unique_people","event_name":"assessment_started","visible":true},
{"key":"completed","label":"Assessments completed","type":"unique_people","event_name":"assessment_completed","visible":true},
{"key":"completion","label":"Assessment completion","type":"ratio","numerator_key":"completed","denominator_key":"started","visible":true},
{"key":"pool","label":"Waiting for a group","type":"current_state","event_name":"pool_state","state_value":"awaiting_match","visible":true},
{"key":"confirmed","label":"Confirmed group members","type":"current_state","event_name":"cohort_state","state_value":"confirmed","visible":true},
{"key":"attended","label":"Webinar attendees","type":"unique_per_context","event_name":"webinar_attended","visible":true},
{"key":"live","label":"In webinar now","type":"live_presence","event_name":"webinar_presence","visible":true},
{"key":"email_leads","label":"Starter-pack signups","type":"unique_people","event_name":"email_lead","visible":true},
{"key":"requests","label":"Webinar invitations requested","type":"unique_per_context","event_name":"webinar_requested","visible":true},
{"key":"checkout_opened","label":"Checkout opened","type":"unique_per_context","event_name":"checkout_opened","visible":true},
{"key":"checkout_closed","label":"Checkout outcomes","type":"event_count","event_name":"checkout_closed","visible":true},
{"key":"resource_accessed","label":"Resources accessed","type":"unique_per_context","event_name":"resource_accessed","visible":true},
{"key":"attendance_confirmed","label":"Confirmed webinar attendees","type":"current_state","event_name":"webinar_attendance","state_value":"attended","visible":true},
{"key":"attendance_missed","label":"Did not attend","type":"current_state","event_name":"webinar_attendance","state_value":"missed","visible":true}]}');
select public.publish_admin_funnel_metrics('ac570000-0000-4000-8000-000000000002',1);
select public.save_admin_funnel_metrics_draft('{"funnel_id":"ac570000-0000-4000-8000-000000000042","expected_revision":0,"template":"blank","metrics":[{"key":"signups","label":"Course signups","type":"unique_people","event_name":"course_signup","visible":true},{"key":"lessons","label":"Lessons completed","type":"unique_per_context","event_name":"course_lesson_completed","visible":true}]}');
select public.publish_admin_funnel_metrics('ac570000-0000-4000-8000-000000000042',1);
reset role;
-- No webinar attendance is invented. Only the non-SpeakSix sample product gets
-- a clearly isolated test event to prove the generic engine has no brand branch.
set role service_role;
select public.ingest_funnel_metric_event('ac570000-0000-4000-8000-000000000041','ac570000-0000-4000-8000-000000000042',jsonb_build_object('event_id','ac570000-0000-4000-8000-000000000047','event_name','course_signup','click_id','opaque_course_click_123456','subject_id','opaque_course_person_123456','occurred_at',to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
reset role;
