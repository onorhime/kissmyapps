-- Run with candidate DDL in one transaction that ALWAYS rolls back.
-- Uses existing canonical facts; never inserts synthetic financial rows.
create temporary table subscription_checks(label text);
grant select,insert on subscription_checks to authenticated;
create function pg_temp.sub_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Subscription assertion failed: %',label; end if;
  insert into subscription_checks values(label);
end $$;
create function pg_temp.sub_error(statement text,code text,label text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate<>code then raise; end if;
    insert into subscription_checks values(label);return;
  end;
  raise exception 'Expected rejection: %',label;
end $$;
grant execute on function pg_temp.sub_assert(boolean,text),pg_temp.sub_error(text,text,text) to authenticated;
select pg_temp.sub_assert(not has_function_privilege('anon','public.get_admin_subscriptions(text,text,uuid,integer,integer,text)','execute'),'anonymous denied');
select pg_temp.sub_assert(not has_function_privilege('service_role','public.get_admin_subscriptions(text,text,uuid,integer,integer,text)','execute'),'service cannot use browser read contract');
select pg_temp.sub_assert(has_function_privilege('authenticated','public.get_admin_subscriptions(text,text,uuid,integer,integer,text)','execute'),'authenticated can request role-checked report');
do $$ declare owner_id uuid; h jsonb; item jsonb; variant text; row_count bigint;
begin
  select user_id into strict owner_id from public.admin_users where role='owner' and active order by created_at limit 1;
  perform set_config('kma_test.sub_owner',owner_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated','amr',jsonb_build_array(jsonb_build_object('method','password')))::text,true);
  select count(*) into row_count from public.subscriptions;
  h:=public.get_admin_subscriptions();
  perform pg_temp.sub_assert((h->>'total')::bigint=row_count,'directory count equals canonical subscriptions');
  perform pg_temp.sub_assert(jsonb_array_length(h->'items')=least(25,row_count),'default page bounded');
  perform pg_temp.sub_assert((h#>>'{summary,active}')::bigint=(select count(*) from public.subscriptions where status='active'),'active count exact');
  perform pg_temp.sub_assert((h#>>'{summary,trialing}')::bigint=(select count(*) from public.subscriptions where status='trialing'),'trial count separate');
  perform pg_temp.sub_assert(h::text !~ '(stripe_customer_id|public_attempt_id|checkout_url|success_url|cancel_url|client_secret|email|payload|ip_hash)','projection excludes sensitive fields');
  perform set_config('kma_test.sub_snapshot',jsonb_build_object('total',h->'total','summary',h->'summary','stripe_work_pending',h->'stripe_work_pending',
    'page_zero_total_checkouts',(select count(*) from jsonb_array_elements(h->'items') i where (i->>'zero_total_checkout')::boolean),
    'page_recorded_paid_invoices',(select coalesce(sum((i->>'recorded_paid_invoices')::bigint),0) from jsonb_array_elements(h->'items') i))::text,true);
  for item in select value from jsonb_array_elements(h->'items') loop
    perform pg_temp.sub_assert((item->>'recorded_paid_invoices')::bigint=(select count(*) from public.transactions where subscription_id=(item->>'id')::uuid and gross_minor>0),'paid count not inferred from active status');
    perform pg_temp.sub_assert(item->>'stripe_subscription_id'=(select stripe_subscription_id from public.subscriptions where id=(item->>'id')::uuid),'Stripe reference exact');
    perform pg_temp.sub_assert(item->>'partner_name' is not distinct from (select a.public_name from public.acquisitions ac join public.affiliates a on a.id=ac.affiliate_id where ac.id=(item->>'acquisition_id')::uuid),'partner matches acquisition');
    perform pg_temp.sub_assert(item->>'source_name' is not distinct from (select s.name from public.acquisitions ac join public.sources s on s.id=ac.source_id where ac.id=(item->>'acquisition_id')::uuid),'source matches acquisition');
    perform pg_temp.sub_assert(item->>'sub1' is not distinct from (select c.sub1 from public.acquisitions ac join public.clicks c on c.id=ac.click_record_id where ac.id=(item->>'acquisition_id')::uuid),'placement matches immutable click');
    perform pg_temp.sub_assert((item->>'checkout_list_amount_minor')::bigint is not distinct from (select a.unit_amount_minor from public.stripe_subscription_evidence e join public.checkout_attempts a on a.id=e.checkout_attempt_id where e.subscription_id=(item->>'id')::uuid),'list price uses original checkout snapshot');
    perform pg_temp.sub_assert((item->>'zero_total_checkout')::boolean=exists(select 1 from public.events e where e.source='stripe' and e.event_name='checkout.no_payment_required' and e.properties->>'subscription_id'=item->>'stripe_subscription_id' and e.product_id=(item->>'product_id')::uuid and e.account_id=(item->>'account_id')::uuid and e.acquisition_id=(item->>'acquisition_id')::uuid),'zero total requires exact subscription evidence');
  end loop;
  foreach variant in array array['active','trialing','incomplete','past_due','unpaid','cancelled'] loop
    h:=public.get_admin_subscriptions(p_status=>variant);
    perform pg_temp.sub_assert((h->>'total')::bigint=(select count(*) from public.subscriptions where status::text=variant),'status filter '||variant);
  end loop;
  h:=public.get_admin_subscriptions(p_product_id=>'10000000-0000-4000-8000-ffffffffffff');
  perform pg_temp.sub_assert(h->>'total'='0' and h->'items'='[]','unknown product is empty, not whole catalog');
  h:=public.get_admin_subscriptions(p_query=>'%');
  perform pg_temp.sub_assert((h->>'total')::bigint=0,'search percent is literal, not wildcard');
  h:=public.get_admin_subscriptions(p_offset=>100000);
  perform pg_temp.sub_assert(h->'items'='[]' and (h->>'total')::bigint=row_count,'empty page retains matching total');
  if row_count>1 then
    perform pg_temp.sub_assert(public.get_admin_subscriptions(p_limit=>1)->'items'->0->>'id' is distinct from public.get_admin_subscriptions(p_limit=>1,p_offset=>1)->'items'->0->>'id','pages do not overlap');
  end if;
  foreach variant in array array['p_limit=>0','p_limit=>101','p_limit=>null','p_offset=>-1','p_offset=>100001','p_sort=>null',$q$p_sort=>'invalid'$q$,$q$p_status=>'paused'$q$,$q$p_query=>repeat('a',121)$q$] loop
    perform pg_temp.sub_error('select public.get_admin_subscriptions('||variant||')','22023','invalid filter '||variant);
  end loop;
end $$;
set local role authenticated;
select pg_temp.sub_assert(public.get_admin_subscriptions() ? 'summary','actual authenticated role reads report');
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('kma_test.sub_owner'),'role','authenticated','amr',jsonb_build_array(jsonb_build_object('method','recovery')))::text,true);
select pg_temp.sub_error('select public.get_admin_subscriptions()','42501','recovery session denied');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-ffffffffffff","amr":[{"method":"password"}]}',true);
select pg_temp.sub_error('select public.get_admin_subscriptions()','42501','partner or non-admin denied');
select set_config('request.jwt.claims','{}',true);
select pg_temp.sub_error('select public.get_admin_subscriptions()','28000','missing session denied');
reset role;
-- Role changes exist only inside this rollback transaction and are never committed.
do $$ declare variant text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('kma_test.sub_owner'),'amr',jsonb_build_array(jsonb_build_object('method','password')))::text,true);
  foreach variant in array array['operations','finance','analyst'] loop
    update public.admin_users set role=variant where user_id=current_setting('kma_test.sub_owner')::uuid;
    perform pg_temp.sub_assert(public.get_admin_subscriptions() ? 'items','allowed role '||variant);
  end loop;
  update public.admin_users set role='support' where user_id=current_setting('kma_test.sub_owner')::uuid;
  perform pg_temp.sub_error('select public.get_admin_subscriptions()','42501','support denied');
  update public.admin_users set role='owner',active=false where user_id=current_setting('kma_test.sub_owner')::uuid;
  perform pg_temp.sub_error('select public.get_admin_subscriptions()','42501','inactive admin denied');
end $$;
select count(*) as passed_subscription_assertions, current_setting('kma_test.sub_snapshot')::jsonb as recorded_snapshot from subscription_checks;
