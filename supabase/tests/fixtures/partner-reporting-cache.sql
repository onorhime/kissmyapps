-- Controlled projection inputs, not a normalization/integration test. Test 26
-- separately proves zero-total Stripe checkouts create subscriptions without
-- purchases or commissions. Here the cache represents two such subscriptions.
\i supabase/tests/fixtures/partner-reporting-launch.sql

insert into public.provider_events(id,provider,provider_event_id,event_type,payload,signature_verified)
values('aa280000-0000-4000-8000-000000000031','stripe','evt_ReportingFixture28','invoice.paid','{"fixture":true,"livemode":true}',true);
insert into public.provider_event_processing(provider_event_id,status,processed_at)
values('aa280000-0000-4000-8000-000000000031','processed',now()-interval '1 minute')
on conflict(provider_event_id) do update set status='processed',processed_at=excluded.processed_at;
insert into public.commercial_metric_refresh_queue(affiliate_id,product_id,metric_date,status,processed_at)
values('aa280000-0000-4000-8000-000000000003','aa280000-0000-4000-8000-000000000001',current_date,'processed',now()-interval '1 minute');
insert into public.affiliate_daily_metrics(affiliate_id,product_id,affiliate_link_id,metric_date,
 source_id,campaign_id,funnel_id,sub1,sub2,sub3,clicks,visitors,funnel_starts,payment_views,currency,source_freshness,calculated_at)
select affiliate_id,product_id,id,current_date,source_id,campaign_id,funnel_id,sub1,sub2,sub3,
 8,6,4,3,'USD','{"click_tracker":"complete","first_party":"complete","stripe":"complete"}',now()
from public.affiliate_links where id=(current_setting('qa.reporting.link')::jsonb->>'id')::uuid;
insert into public.affiliate_daily_metrics(affiliate_id,product_id,metric_date,is_subscription_snapshot,active_subscriptions,currency,source_freshness,calculated_at)
values('aa280000-0000-4000-8000-000000000003','aa280000-0000-4000-8000-000000000001',current_date,true,2,'USD','{"stripe":"complete"}',now());
