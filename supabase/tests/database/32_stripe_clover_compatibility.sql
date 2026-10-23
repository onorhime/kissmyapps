-- Appended to scoped 24/25/26 fixtures inside BEGIN/ROLLBACK only.
reset role;
select pg_temp.check_true(not has_function_privilege('anon','public.supplement_stripe_subscription_event(uuid,uuid,jsonb)','EXECUTE'),'recovery is not public');
select pg_temp.check_true(not has_function_privilege('authenticated','public.supplement_stripe_subscription_event(uuid,uuid,jsonb)','EXECUTE'),'partners cannot supplement provider evidence');
select pg_temp.check_true(kma_internal.stripe_subscription_period('{"items":{"has_more":false,"data":[{"current_period_start":1788710400,"current_period_end":1791302400}]}}','start')='1788710400','item-level periods supported');
select pg_temp.expect_error($q$select kma_internal.stripe_subscription_period('{"items":{"has_more":true,"data":[{"current_period_start":1788710400,"current_period_end":1791302400}]}}','start')$q$,'23514','truncated periods rejected');
do $$ declare ev jsonb; input_value jsonb:=(select value from audit_values where key='free-invoice-input'); obj jsonb;
begin
 obj:=(select value-'paid'||'{"id":"in_RollbackClover9501"}'::jsonb from audit_values where key='free-invoice');
 input_value:=input_value||'{"object_id":"in_RollbackClover9501"}'::jsonb;
 ev:=pg_temp.free_provider('invoice.paid',obj||'{"paid":false}'::jsonb);
 perform pg_temp.expect_error(format('select pg_temp.normalize_free(%L,%L)',ev,input_value),'23514','explicit paid false rejected');
 ev:=pg_temp.free_provider('invoice.paid',obj);
 perform pg_temp.check_true(pg_temp.normalize_free(ev,input_value)->>'status'='processed','Clover zero invoice without legacy paid normalizes');
end $$;
do $$ declare ev jsonb; obj jsonb; recovered jsonb; original jsonb; result jsonb;
begin
 select jsonb_build_object('id',s.stripe_subscription_id,'object','subscription','livemode',true,
   'status','active','currency','usd','customer',s.stripe_customer_id,'metadata',jsonb_build_object('kma_attempt_id',e.checkout_attempt_id))
 into obj from public.subscriptions s join public.stripe_subscription_evidence e on e.subscription_id=s.id
 where s.stripe_subscription_id='sub_RollbackFree9501';
 if obj is null then raise exception 'fixture unavailable'; end if;
 ev:=pg_temp.free_provider('customer.subscription.created',obj);
 select payload into original from public.provider_events where id=(ev->>'id')::uuid;
 recovered:=jsonb_set(original,'{data,object,items}',(select jsonb_build_object('has_more',false,'data',
   jsonb_build_array(jsonb_build_object('current_period_start',value->'period_start','current_period_end',value->'period_end')))
   from audit_values where key='free-input'));
 perform pg_temp.expect_error(format('select public.supplement_stripe_subscription_event(%L,%L,%L)',ev->>'id',ev->>'token',jsonb_set(recovered,'{data,object,status}','"canceled"')),'23514','different original state cannot be substituted');
 perform public.supplement_stripe_subscription_event((ev->>'id')::uuid,(ev->>'token')::uuid,recovered);
 perform public.supplement_stripe_subscription_event((ev->>'id')::uuid,(ev->>'token')::uuid,recovered);
 result:=public.normalize_stripe_provider_event((ev->>'id')::uuid,(ev->>'token')::uuid,jsonb_build_object('kind','subscription_changed','object_id',obj->>'id'));
 perform pg_temp.check_true(result->>'status'='processed','original event supplemental periods normalize');
 perform pg_temp.check_true((select payload=original from public.provider_events where id=(ev->>'id')::uuid),'signed receipt remains unchanged');
end $$;
select count(*) as passed_clover_assertions from audit_checks;
