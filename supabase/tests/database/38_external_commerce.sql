-- Disposable database only. Provider verification is covered by injected edge
-- tests; SQL verifies authority, idempotency, immutable scope and held accounting.
begin;
create function pg_temp.check_true(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAIL: %',label;end if;end $$;
create function pg_temp.reject(q text,label text) returns void language plpgsql as $$begin begin execute q;exception when others then return;end;raise exception 'FAIL accepted: %',label;end $$;
grant execute on function pg_temp.check_true(boolean,text),pg_temp.reject(text,text) to authenticated,service_role;
insert into public.platform_settings(singleton,tracking_base_url) values(true,'https://tracking.example.invalid') on conflict(singleton) do update set tracking_base_url=excluded.tracking_base_url;
insert into public.products(id,slug,name) values('ac570000-0000-4000-8000-000000000001','external-marathon-fixture','Fixture marathon');
insert into public.funnels(id,product_id,key,name,destination_url) values('ac570000-0000-4000-8000-000000000002','ac570000-0000-4000-8000-000000000001','marathon','Fixture funnel','https://marathon.example.invalid');
insert into public.affiliates(id,public_name,slug) values('ac570000-0000-4000-8000-000000000003','Fixture partner','external-fixture');
insert into public.affiliate_links(id,affiliate_id,product_id,funnel_id,name,public_code,tracking_url,sub1,status) values('ac570000-0000-4000-8000-000000000004','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','Fixture link','external_fixture_link','https://tracking.example.invalid/r/external-fixture/external_fixture_link','fixture','paused');
insert into public.clicks(id,public_click_id,affiliate_link_id,affiliate_id,product_id,funnel_id,sub1,destination_url_snapshot) values('ac570000-0000-4000-8000-000000000005','opaque_fixture_click_123456','ac570000-0000-4000-8000-000000000004','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','fixture','https://marathon.example.invalid');
insert into public.acquisitions(id,product_id,affiliate_id,click_record_id,funnel_id,attribution_method) values('ac570000-0000-4000-8000-000000000006','ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000003','ac570000-0000-4000-8000-000000000005','ac570000-0000-4000-8000-000000000002','deterministic_web');
select set_config('qa.kma_external',jsonb_build_object('product_id','ac570000-0000-4000-8000-000000000001','funnel_id','ac570000-0000-4000-8000-000000000002','attribution_sha256',repeat('a',64),'provider_occurred_at','2026-10-13T11:00:00Z','input',jsonb_build_object('event_id','ac570000-0000-4000-8000-000000000007','kind','purchase','click_id','opaque_fixture_click_123456','occurred_at','2026-10-13T11:00:00Z','order_id','ac570000-0000-4000-8000-000000000008','checkout_session_id','cs_test_fixture','payment_intent_id','pi_fixture','account_id','acct_fixture','livemode',false,'amount_minor',17900,'currency','USD','attribution',jsonb_build_object('kmaClick','opaque_fixture_click_123456','status','unverified')))::text,true);
set local role authenticated;
select pg_temp.reject('select public.ingest_external_commerce(current_setting(''qa.kma_external'')::jsonb)','browser cannot forge financial truth');
select pg_temp.reject('select * from public.external_commerce_orders','browser cannot inspect private ledger');
reset role;
set local role service_role;
select pg_temp.reject('select public.ingest_external_commerce(current_setting(''qa.kma_external'')::jsonb)','unconfigured merchant denied');
insert into public.external_commerce_merchants(product_id,funnel_id,stripe_account_id,livemode,enabled) values('ac570000-0000-4000-8000-000000000001','ac570000-0000-4000-8000-000000000002','acct_fixture',false,true);
select set_config('qa.kma_receipt',public.ingest_external_commerce(current_setting('qa.kma_external')::jsonb)::text,true);
select pg_temp.check_true((current_setting('qa.kma_receipt')::jsonb->>'duplicate')='false','first provider fact accepted');
select pg_temp.check_true((current_setting('qa.kma_receipt')::jsonb->>'event_id')<>'ac570000-0000-4000-8000-000000000007','receipt is internal ledger UUID');
select pg_temp.check_true(public.ingest_external_commerce(current_setting('qa.kma_external')::jsonb)->>'duplicate'='true','external event replay idempotent');
select pg_temp.check_true(public.ingest_external_commerce(jsonb_set(current_setting('qa.kma_external')::jsonb,'{input,event_id}','"ac570000-0000-4000-8000-000000000009"'))->>'duplicate'='true','different external ID does not duplicate provider fact');
select pg_temp.reject('select public.ingest_external_commerce(jsonb_set(current_setting(''qa.kma_external'')::jsonb,''{input,amount_minor}'',''100''))','event amount immutable');
select pg_temp.reject('select public.ingest_external_commerce(jsonb_set(current_setting(''qa.kma_external'')::jsonb,''{input,account_id}'',''"acct_foreign"''))','cross merchant rejected');
select pg_temp.reject('select public.ingest_external_commerce(jsonb_set(current_setting(''qa.kma_external'')::jsonb,''{funnel_id}'',''"ac570000-0000-4000-8000-000000000099"''))','cross funnel rejected');
select public.ingest_external_commerce(jsonb_set(current_setting('qa.kma_external')::jsonb,'{input}',(current_setting('qa.kma_external')::jsonb->'input')||'{"event_id":"ac570000-0000-4000-8000-000000000010","kind":"refund","refund_id":"re_fixture"}'));
select pg_temp.check_true((select count(*)=1 from public.external_commerce_orders),'purchase and refund share immutable order');
select pg_temp.check_true((select count(*)=2 from public.external_commerce_events),'one purchase and one refund fact');
select pg_temp.check_true((select sum(case when kind='purchase' then amount_minor else -amount_minor end)=0 from public.external_commerce_events),'full refund offsets gross revenue exactly');
select pg_temp.check_true((select bool_and(commission_status='held') from public.external_commerce_orders),'no rate or commission is approved');
select pg_temp.check_true((select affiliate_id='ac570000-0000-4000-8000-000000000003' from public.external_commerce_orders),'creator resolved from trusted click only');
select pg_temp.reject('update public.external_commerce_orders set amount_minor=1','service cannot mutate ledger');
reset role;
select pg_temp.reject('delete from public.external_commerce_events','immutable even to trusted DB owner');
select pg_temp.check_true((select count(*)=0 from public.payouts),'no payout created');

-- Refund before purchase is also reconciled without inventing two sales.
select set_config('qa.kma_reverse',jsonb_set(current_setting('qa.kma_external')::jsonb,'{input}',(current_setting('qa.kma_external')::jsonb->'input')||'{"event_id":"ac570000-0000-4000-8000-000000000020","order_id":"ac570000-0000-4000-8000-000000000021","payment_intent_id":"pi_reverse","checkout_session_id":"cs_test_reverse","kind":"refund","refund_id":"re_reverse"}')::text,true);
set local role service_role;
select public.ingest_external_commerce(current_setting('qa.kma_reverse')::jsonb);
select public.ingest_external_commerce(jsonb_set(current_setting('qa.kma_reverse')::jsonb,'{input}',((current_setting('qa.kma_reverse')::jsonb->'input')-'refund_id')||'{"event_id":"ac570000-0000-4000-8000-000000000022","kind":"purchase"}'));
select pg_temp.check_true((select count(*)=4 from public.external_commerce_events),'reverse ordering keeps four unique facts');
select pg_temp.check_true((select sum(case when kind='purchase' then amount_minor else -amount_minor end)=0 from public.external_commerce_events),'reverse ordering keeps net revenue zero');
reset role;
rollback;
