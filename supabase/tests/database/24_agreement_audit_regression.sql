-- Transaction-only synthetic fixtures: no Auth API calls, HTTP, or deliveries.
begin;
create temporary table audit_checks(label text);
create temporary table audit_values(key text primary key,value jsonb);
grant select,insert,update on audit_checks,audit_values to authenticated,service_role;
create function pg_temp.check_true(value boolean,label text) returns void language plpgsql as $$
begin
  if value is distinct from true then raise exception 'audit assertion failed: %',label; end if;
  insert into pg_temp.audit_checks values(label);
end;
$$;
create function pg_temp.expect_error(statement text,expected text,label text) returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate <> expected then raise; end if;
    insert into pg_temp.audit_checks values(label);
    return;
  end;
  raise exception 'expected rejection: %',label;
end;
$$;
grant execute on function pg_temp.check_true(boolean,text),pg_temp.expect_error(text,text,text) to authenticated,service_role;
select pg_temp.check_true(not has_table_privilege('authenticated','kma_internal.product_deletion_scopes','INSERT'),'browser cannot grant itself history deletion');
select pg_temp.check_true(not exists(select 1 from auth.users where id::text like '10000000-0000-4000-8000-0000000095%'),'fixture namespace is unused');
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
select ('10000000-0000-4000-8000-00000000950'||n)::uuid,'00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','audit-role-'||n||'@example.invalid',now(),'{}','{}' from generate_series(1,7)n;
insert into public.admin_users(user_id,role,active) values('10000000-0000-4000-8000-000000009501','owner',true);
insert into public.affiliates(id,public_name,slug,status) values
 ('30000000-0000-4000-8000-000000009501','Audit partner','audit-regression-partner','active'),
 ('30000000-0000-4000-8000-000000009502','Foreign partner','audit-regression-foreign','active');
insert into public.affiliate_users(affiliate_id,user_id,role,active,activation_pending,activated_at) values
 ('30000000-0000-4000-8000-000000009501','10000000-0000-4000-8000-000000009502','owner',true,false,now()),
 ('30000000-0000-4000-8000-000000009501','10000000-0000-4000-8000-000000009503','finance',true,false,now()),
 ('30000000-0000-4000-8000-000000009501','10000000-0000-4000-8000-000000009504','analyst',true,false,now()),
 ('30000000-0000-4000-8000-000000009501','10000000-0000-4000-8000-000000009505','member',true,false,now()),
 ('30000000-0000-4000-8000-000000009501','10000000-0000-4000-8000-000000009506','owner',false,false,now()),
 ('30000000-0000-4000-8000-000000009502','10000000-0000-4000-8000-000000009507','owner',true,false,now());
insert into public.products(id,slug,name,status) values('20000000-0000-4000-8000-000000009501','audit-regression-product','Audit product','draft');
insert into public.agreements(id,affiliate_id,product_id,version,model,status) values
 ('40000000-0000-4000-8000-000000009501','30000000-0000-4000-8000-000000009501','20000000-0000-4000-8000-000000009501',1,'cpa','draft');
insert into public.commission_rules(id,agreement_id,name,model,trigger_event,fixed_amount_minor,currency,status)
 values('50000000-0000-4000-8000-000000009501','40000000-0000-4000-8000-000000009501','Audit commission','cpa','purchase.completed',100,'USD','active');
insert into storage.objects(id,bucket_id,name,metadata,version) values
 ('60000000-0000-4000-8000-000000009501','affiliate-private-documents','30000000-0000-4000-8000-000000009501/agreements/terms.pdf','{"mimetype":"application/pdf","size":100,"eTag":"fixture-etag"}','fixture-version'),
 ('60000000-0000-4000-8000-000000009502','affiliate-private-documents','30000000-0000-4000-8000-000000009501/agreements/unused.pdf','{"mimetype":"application/pdf","size":100}','fixture-version');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009501","role":"authenticated","amr":[{"method":"password"}]}',true);
insert into audit_values values('document',public.create_admin_agreement_document(jsonb_build_object(
  'agreement_id','40000000-0000-4000-8000-000000009501','name','Audit terms',
  'file_path','30000000-0000-4000-8000-000000009501/agreements/terms.pdf','content_sha256',repeat('a',64))));
select pg_temp.check_true((select value->>'status'='awaiting_partner_signature' and length(value->>'terms_sha256')=64
  and value #>> '{terms_snapshot,rules,0,fixed_amount_minor}'='100' from audit_values where key='document'),'request creates immutable commercial snapshot');
select pg_temp.expect_error($q$select public.set_admin_commission_rule_status('{
  "commission_rule_id":"50000000-0000-4000-8000-000000009501","status":"superseded"}')$q$,'P0001','request freezes commission rules');
select pg_temp.expect_error($q$select public.request_admin_document_cleanup('30000000-0000-4000-8000-000000009501/agreements/terms.pdf')$q$,'P0001','referenced PDF cannot enter cleanup');
select public.request_admin_document_cleanup('30000000-0000-4000-8000-000000009501/agreements/unused.pdf');
select pg_temp.check_true(not has_function_privilege('authenticated','public.claim_agreement_email_jobs(integer)','EXECUTE'),'browser cannot lease notification jobs');

do $$ declare n integer;
begin
  for n in 3..7 loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub','10000000-0000-4000-8000-00000000950'||n,
      'role','authenticated','amr',jsonb_build_array(jsonb_build_object('method','password')))::text,true);
    perform pg_temp.expect_error(format('select public.partner_sign_agreement_document(%L::jsonb)',
      jsonb_build_object('document_id',(select value->>'id' from audit_values where key='document'),'legal_name','Audit signer','acknowledged',true)),
      '42501','non-owner, inactive or foreign role rejected '||n);
  end loop;
end;
$$;
reset role;
update public.affiliates set status='paused' where id='30000000-0000-4000-8000-000000009501';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009502","role":"authenticated","amr":[{"method":"password"}]}',true);
select pg_temp.expect_error(format('select public.partner_sign_agreement_document(%L::jsonb)',jsonb_build_object(
  'document_id',(select value->>'id' from audit_values where key='document'),'legal_name','Audit signer','acknowledged',true)),
  '42501','paused affiliate Owner cannot sign');
reset role;
update public.affiliates set status='active' where id='30000000-0000-4000-8000-000000009501';
update storage.objects set version='changed-version' where id='60000000-0000-4000-8000-000000009501';
set local role authenticated;
select pg_temp.expect_error(format('select public.partner_sign_agreement_document(%L::jsonb)',jsonb_build_object(
  'document_id',(select value->>'id' from audit_values where key='document'),'legal_name','Audit signer','acknowledged',true)),
  'P0001','changed PDF identity requires a new signature request');
reset role;
update storage.objects set version='fixture-version' where id='60000000-0000-4000-8000-000000009501';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009502","role":"authenticated","amr":[{"method":"recovery"}]}',true);
select pg_temp.expect_error(format('select public.partner_sign_agreement_document(%L::jsonb)',jsonb_build_object(
  'document_id',(select value->>'id' from audit_values where key='document'),'legal_name','Audit signer','acknowledged',true)),
  '42501','recovery-only session cannot sign');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009502","role":"authenticated","amr":[{"method":"password"}]}',true);
select pg_temp.expect_error(format('select public.partner_sign_agreement_document(%L::jsonb)',jsonb_build_object(
  'document_id',(select value->>'id' from audit_values where key='document'),'legal_name','Audit signer','acknowledged',false)),
  '22023','explicit acknowledgement is required');
select pg_temp.check_true(public.partner_sign_agreement_document(jsonb_build_object(
  'document_id',(select value->>'id' from audit_values where key='document'),'legal_name','Audit signer','acknowledged',true))
  ->>'status'='awaiting_kissmyapps_signature','partner Owner signs successfully without HTTP');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009501","role":"authenticated","amr":[{"method":"password"}]}',true);
select pg_temp.check_true(public.admin_countersign_agreement_document(jsonb_build_object(
  'document_id',(select value->>'id' from audit_values where key='document')))->>'status'='signed','admin countersigns without HTTP');
select pg_temp.expect_error($q$select public.set_admin_commission_rule_status('{
  "commission_rule_id":"50000000-0000-4000-8000-000000009501","status":"superseded"}')$q$,'P0001','signed-but-inactive agreement still freezes rules');
select pg_temp.expect_error($q$select public.delete_admin_product('{
  "product_id":"20000000-0000-4000-8000-000000009501","confirmation":"audit-regression-product"}')$q$,'P0001','signed evidence blocks whole-product deletion');
select pg_temp.check_true(public.activate_admin_agreement('{"agreement_id":"40000000-0000-4000-8000-000000009501"}')->>'status'='active','unchanged signed terms can activate');
reset role;
select pg_temp.expect_error($q$update public.documents set partner_signer_name='Changed' where agreement_id='40000000-0000-4000-8000-000000009501'$q$,'P0001','stored signature cannot be edited');
select pg_temp.check_true((select count(*)=1 from kma_internal.agreement_email_jobs where document_id=(select (value->>'id')::uuid from audit_values where key='document') and event_type='signing_request'),'signing requests target the one partner Owner, not other members');

set local role service_role;
insert into audit_values values('jobs',public.claim_agreement_email_jobs());
select pg_temp.check_true((select jsonb_array_length(value)=1 and value #>> '{0,type}'='agreement_fully_signed' from audit_values where key='jobs'),'stale milestones are cancelled and final milestone is leased once');
select pg_temp.check_true(jsonb_array_length(public.claim_agreement_email_jobs())=0,'unexpired lease prevents duplicate claim');
select pg_temp.expect_error(format('select public.seal_agreement_email_job(%L,%L,%L::jsonb)',
  (select value #>> '{0,id}' from audit_values where key='jobs'),(select value #>> '{0,claimToken}' from audit_values where key='jobs'),
  '{"from":"sender@example.invalid","to":"wrong@example.invalid","subject":"test","html":"test"}'), '22023','worker cannot change the queued recipient');
insert into audit_values values('envelope',public.seal_agreement_email_job(
  (select (value #>> '{0,id}')::uuid from audit_values where key='jobs'),
  (select (value #>> '{0,claimToken}')::uuid from audit_values where key='jobs'),
  '{"from":"sender@example.invalid","to":"audit-role-2@example.invalid","subject":"test","html":"test"}'));
select pg_temp.check_true(public.seal_agreement_email_job(
  (select (value #>> '{0,id}')::uuid from audit_values where key='jobs'),
  (select (value #>> '{0,claimToken}')::uuid from audit_values where key='jobs'),
  '{"from":"changed@example.invalid","to":"changed@example.invalid","subject":"changed","html":"changed"}')
  = (select value from audit_values where key='envelope'),'retry reuses frozen provider envelope');
select public.finish_agreement_email_job((select (value #>> '{0,id}')::uuid from audit_values where key='jobs'),
  (select (value #>> '{0,claimToken}')::uuid from audit_values where key='jobs'),null,'provider_unavailable',true);
reset role;
update kma_internal.agreement_email_jobs set first_attempt_at=now()-interval '21 hours',next_attempt_at=now()
  where id=(select (value #>> '{0,id}')::uuid from audit_values where key='jobs');
set local role service_role;
select pg_temp.check_true(jsonb_array_length(public.claim_agreement_email_jobs())=0,'ambiguous sends are not retried beyond the provider deduplication window');
select pg_temp.check_true(jsonb_array_length(public.claim_document_cleanup_jobs())=1,'only the explicitly queued unused PDF is leased for cleanup');
reset role;
select pg_temp.check_true((select status='failed' from kma_internal.agreement_email_jobs where id=(select (value #>> '{0,id}')::uuid from audit_values where key='jobs')),'expired retry remains visible to operators');

-- Populated tracking-only deletion: real RPC-created attribution, not just empty rows.
insert into public.products(id,slug,name,status) values
 ('20000000-0000-4000-8000-000000009502','audit-delete-tracking','Audit tracking delete','draft'),
 ('20000000-0000-4000-8000-000000009503','audit-delete-draft','Audit draft delete','draft');
insert into public.funnels(id,product_id,key,name,destination_url,status,is_default) values
 ('70000000-0000-4000-8000-000000009502','20000000-0000-4000-8000-000000009502','audit-demo','Audit demo','https://kissmyapps.dev/audit-demo','live',true);
insert into public.platform_settings(singleton,tracking_base_url,tracking_enabled)
  values(true,'https://go.kissmyapps.dev',false) on conflict(singleton) do nothing;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009501","role":"authenticated","amr":[{"method":"password"}]}',true);
select public.set_admin_product_tracking_mode(jsonb_build_object('product_id','20000000-0000-4000-8000-000000009502',
  'mode','tracking_only','expected_updated_at',(select updated_at from public.get_admin_products() where id='20000000-0000-4000-8000-000000009502')));
select public.activate_admin_product('{"product_id":"20000000-0000-4000-8000-000000009502"}');
select public.configure_admin_tracking(jsonb_build_object('base_url','https://go.kissmyapps.dev','enabled',true,
  'expected_updated_at',public.get_admin_platform_settings() #>> '{tracking,updated_at}'));
insert into audit_values values('link',public.issue_admin_main_link('{
  "affiliate_id":"30000000-0000-4000-8000-000000009501","product_id":"20000000-0000-4000-8000-000000009502"}'));
set local role service_role;
insert into audit_values select 'click',to_jsonb(r) from public.register_tracking_click('audit-regression-partner',
  (select value->>'public_code' from audit_values where key='link'),jsonb_build_object('session_id_hash',repeat('b',64))) r;
select public.ingest_browser_event(jsonb_build_object('event_id','80000000-0000-4000-8000-000000009502',
  'event_name','funnel_started','click_id',(select value->>'click_id' from audit_values where key='click'),'occurred_at',now(),'properties','{}'::jsonb));
reset role;
select pg_temp.check_true(exists(select 1 from public.clicks where product_id='20000000-0000-4000-8000-000000009502' and not commercial_eligible)
  and exists(select 1 from public.events where product_id='20000000-0000-4000-8000-000000009502' and not commercial_eligible),'tracking fixture contains real noncommercial click and event');
select pg_temp.expect_error($q$delete from public.clicks where product_id='20000000-0000-4000-8000-000000009502'$q$,'P0001','tracking history cannot be deleted outside the scoped RPC');
select pg_temp.expect_error($q$update public.events set commercial_eligible=true where product_id='20000000-0000-4000-8000-000000009502'$q$,'23514','tracking events cannot be promoted to commercial facts');
select pg_temp.expect_error($q$update public.events set properties='{"changed":true}' where product_id='20000000-0000-4000-8000-000000009502'$q$,'P0001','tracking history cannot be rewritten');
set local role authenticated;
select pg_temp.expect_error($q$select public.delete_admin_product('{"product_id":"20000000-0000-4000-8000-000000009502","confirmation":"AUDIT-DELETE-TRACKING"}')$q$,'22023','deletion confirmation must match the exact slug');
select pg_temp.check_true(public.delete_admin_product('{"product_id":"20000000-0000-4000-8000-000000009502","confirmation":"audit-delete-tracking"}')->>'id'
  ='20000000-0000-4000-8000-000000009502','populated tracking-only product and approved-funnel cycle delete successfully');
reset role;
select pg_temp.check_true(not exists(select 1 from public.products where id='20000000-0000-4000-8000-000000009502')
  and not exists(select 1 from public.clicks where product_id='20000000-0000-4000-8000-000000009502')
  and not exists(select 1 from public.events where product_id='20000000-0000-4000-8000-000000009502')
  and not exists(select 1 from public.funnels where product_id='20000000-0000-4000-8000-000000009502'),'scoped deletion removes exactly the test product tracking chain');
select pg_temp.check_true(exists(select 1 from public.audit_logs where action='product.delete' and target_id='20000000-0000-4000-8000-000000009502'),'product deletion audit evidence is retained');

-- Draft commercial configuration and pending PDFs are removable, signed evidence is not.
insert into public.agreements(id,affiliate_id,product_id,version,model,status) values
 ('40000000-0000-4000-8000-000000009503','30000000-0000-4000-8000-000000009501','20000000-0000-4000-8000-000000009503',1,'cpa','draft');
insert into public.commission_rules(agreement_id,name,model,trigger_event,fixed_amount_minor,currency,status)
 values('40000000-0000-4000-8000-000000009503','Draft delete rule','cpa','purchase.completed',100,'USD','active');
insert into storage.objects(id,bucket_id,name,metadata,version) values
 ('60000000-0000-4000-8000-000000009503','affiliate-private-documents','30000000-0000-4000-8000-000000009501/agreements/delete.pdf','{"mimetype":"application/pdf","size":100}','fixture-version');
set local role authenticated;
select public.create_admin_billing_offer('{"product_id":"20000000-0000-4000-8000-000000009503","key":"monthly","name":"Audit monthly","billing_mode":"subscription"}');
select pg_temp.expect_error(format('select public.create_admin_agreement_document(%L::jsonb)',jsonb_build_object(
  'agreement_id','40000000-0000-4000-8000-000000009503','name','Cannot reuse tombstoned file',
  'file_path','30000000-0000-4000-8000-000000009501/agreements/unused.pdf','content_sha256',repeat('b',64))),
  'P0001','a queued file cannot be attached after a cleanup claim');
select public.create_admin_agreement_document(jsonb_build_object('agreement_id','40000000-0000-4000-8000-000000009503',
  'name','Unsigned delete terms','file_path','30000000-0000-4000-8000-000000009501/agreements/delete.pdf','content_sha256',repeat('c',64)));
select pg_temp.check_true(public.delete_admin_product('{"product_id":"20000000-0000-4000-8000-000000009503","confirmation":"audit-delete-draft"}')->>'id'
  ='20000000-0000-4000-8000-000000009503','draft product with billing offer, active draft rule and pending document can be deleted');
reset role;
select pg_temp.check_true(exists(select 1 from kma_internal.document_cleanup_jobs where file_path='30000000-0000-4000-8000-000000009501/agreements/delete.pdf' and status='pending'),
  'deleting an unsigned document enqueues its exact unreferenced file');
select pg_temp.check_true(exists(select 1 from public.documents where id=(select (value->>'id')::uuid from audit_values where key='document')),
  'other product signed evidence survives every cleanup operation');
select pg_temp.check_true(not exists(select 1 from kma_internal.product_deletion_scopes),'no deletion scope survives an operation');
select count(*) as passed_audit_assertions from audit_checks;
rollback;
