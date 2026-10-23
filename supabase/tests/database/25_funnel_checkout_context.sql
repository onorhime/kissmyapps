-- Appended to fixture 24 ONLY inside the runner's BEGIN/ROLLBACK transaction.
-- No Stripe call, HTTP, email delivery, live signature or persistent test data.
reset role;
insert into public.funnels(id,product_id,key,name,destination_url,status,is_default) values
 ('70000000-0000-4000-8000-000000009501','20000000-0000-4000-8000-000000009501','primary','Rollback funnel','https://bc-learn-funnel.vercel.app/','live',true);
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009501","role":"authenticated","amr":[{"method":"password"}]}',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009501","role":"authenticated","amr":[{"method":"password"}]}',true);
insert into audit_values values('context-offer',public.create_admin_billing_offer('{
 "product_id":"20000000-0000-4000-8000-000000009501","key":"monthly","name":"Rollback only offer","billing_mode":"subscription",
 "stripe_price_id":"price_RollbackFixture9501","currency":"USD","unit_amount_minor":100,
 "success_url_template":"https://bc-learn-funnel.vercel.app/checkout/complete?session_id={CHECKOUT_SESSION_ID}",
 "cancel_url":"https://bc-learn-funnel.vercel.app/?checkout=cancelled"}'));
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.record_billing_offer_stripe_verification(jsonb_build_object(
 'billing_offer_id',(select value->>'id' from audit_values where key='context-offer'),
 'stripe_price_id','price_RollbackFixture9501','livemode',true,'active',true,'currency','USD','unit_amount_minor',100,'billing_mode','subscription'));
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009501","role":"authenticated","amr":[{"method":"password"}]}',true);
select public.activate_admin_product('{"product_id":"20000000-0000-4000-8000-000000009501"}');
select public.set_admin_billing_offer_status(jsonb_build_object('billing_offer_id',(select value->>'id' from audit_values where key='context-offer'),'status','active'));
insert into audit_values values('context-link',public.issue_admin_main_link('{
 "affiliate_id":"30000000-0000-4000-8000-000000009501","product_id":"20000000-0000-4000-8000-000000009501"}'));
reset role;
select pg_temp.check_true(not has_function_privilege('authenticated','public.get_funnel_checkout_context(jsonb,uuid,uuid)','EXECUTE'),'browser cannot read checkout context RPC');
select pg_temp.check_true(not has_function_privilege('anon','public.prepare_quoted_checkout_attempt(jsonb)','EXECUTE'),'anonymous browser cannot prepare quoted checkout');
select pg_temp.check_true(not has_table_privilege('authenticated','kma_internal.funnel_request_limits','INSERT'),'browser cannot reset rate limits');
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into audit_values select 'context-click',to_jsonb(r) from public.register_tracking_click('audit-regression-partner',
 (select value->>'public_code' from audit_values where key='context-link'),jsonb_build_object('session_id_hash',repeat('c',64))) r;
insert into audit_values values('context-input',jsonb_build_object('action','offer','offer_key','monthly','click_id',(select value->>'click_id' from audit_values where key='context-click')));
select pg_temp.check_true(public.get_funnel_checkout_context((select value from audit_values where key='context-input'),
 '20000000-0000-4000-8000-000000009501','70000000-0000-4000-8000-000000009501')->>'unit_amount_minor'='100','offer context returns exact stored amount');
select pg_temp.expect_error(format('select public.get_funnel_checkout_context(%L::jsonb,%L::uuid,%L::uuid)',
 (select value from audit_values where key='context-input'),'20000000-0000-4000-8000-000000009501','70000000-0000-4000-8000-000000009599'),
 'P0002','foreign funnel cannot read context');
select pg_temp.expect_error(format('select public.get_funnel_checkout_context(%L::jsonb,%L::uuid,%L::uuid)',
 (select value from audit_values where key='context-input'),'20000000-0000-4000-8000-000000009599','70000000-0000-4000-8000-000000009501'),
 'P0002','foreign product cannot read context');
insert into audit_values values('quoted-input',jsonb_build_object('click_id',(select value->>'click_id' from audit_values where key='context-click'),
 'offer_key','monthly','offer_version',1,'idempotency_key','rollback_attempt_9501'));
select pg_temp.expect_error(format('select public.prepare_quoted_checkout_attempt(%L::jsonb)',
 (select value||'{"offer_version":2}'::jsonb from audit_values where key='quoted-input')),'P0002','changed offer version cannot be charged');
select pg_temp.expect_error(format('select public.prepare_quoted_checkout_attempt(%L::jsonb)',
 (select value||'{"price":1}'::jsonb from audit_values where key='quoted-input')),'22023','caller cannot inject price');
insert into audit_values select 'context-attempt',to_jsonb(r) from public.prepare_quoted_checkout_attempt((select value from audit_values where key='quoted-input')) r;
select pg_temp.check_true((select r.public_attempt_id=(select value->>'public_attempt_id' from audit_values where key='context-attempt')
 from public.prepare_quoted_checkout_attempt((select value from audit_values where key='quoted-input')) r),'checkout retries keep one attempt');
select public.finalize_checkout_attempt(jsonb_build_object('attempt_id',(select value->>'attempt_id' from audit_values where key='context-attempt'),
 'status','open','stripe_session_id','cs_live_RollbackFixture9501','checkout_url','https://checkout.stripe.com/c/pay/rollback9501','expires_at',now()+interval '1 hour'));
insert into audit_values values('status-input',jsonb_build_object('action','status','click_id',(select value->>'click_id' from audit_values where key='context-click'),
 'attempt_id',(select value->>'public_attempt_id' from audit_values where key='context-attempt'),'session_id','cs_live_RollbackFixture9501'));
select pg_temp.check_true(public.get_funnel_checkout_context((select value from audit_values where key='status-input'),
 '20000000-0000-4000-8000-000000009501','70000000-0000-4000-8000-000000009501')->>'status'='pending','open Stripe checkout is not paid');
select pg_temp.expect_error(format('select public.get_funnel_checkout_context(%L::jsonb,%L::uuid,%L::uuid)',
 (select value||'{"session_id":"cs_live_ForeignSession9501"}'::jsonb from audit_values where key='status-input'),
 '20000000-0000-4000-8000-000000009501','70000000-0000-4000-8000-000000009501'),'P0002','receipt is bound to exact session');
select pg_temp.expect_error(format('select public.finalize_checkout_attempt(%L::jsonb)',jsonb_build_object(
 'attempt_id',(select value->>'attempt_id' from audit_values where key='context-attempt'),'status','completed')),
 '22023','checkout adapter cannot claim payment completion');
do $$ declare n integer; token text:=(select value->>'click_id' from audit_values where key='context-click');
begin
 for n in 1..6 loop perform public.consume_funnel_request(token,'checkout');end loop;
 perform pg_temp.expect_error(format('select public.consume_funnel_request(%L,%L)',token,'checkout'),'KMA29','durable checkout rate limit enforced');
end $$;
reset role;
update public.products set status='paused' where id='20000000-0000-4000-8000-000000009501';
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.check_true(public.get_funnel_checkout_context((select value from audit_values where key='status-input'),
 '20000000-0000-4000-8000-000000009501','70000000-0000-4000-8000-000000009501')->>'status'='pending','paused product still permits existing receipt status');
select pg_temp.expect_error(format('select public.get_funnel_checkout_context(%L::jsonb,%L::uuid,%L::uuid)',
 (select value from audit_values where key='context-input'),'20000000-0000-4000-8000-000000009501','70000000-0000-4000-8000-000000009501'),
 'P0002','paused product cannot serve a payable offer');
reset role;
select count(*) as passed_combined_audit_and_funnel_assertions from audit_checks;
