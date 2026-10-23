-- Read-only function manifest. Hashes reveal no function bodies, credentials,
-- learner identifiers or financial values. Compare with the local baseline.
begin read only;
set local statement_timeout = '10s';
set local lock_timeout = '2s';
with expected(signature) as (values
 ('public.partner_agreement_is_launch_ready(uuid)'),
 ('public.partner_tracking_only_product_is_ready(uuid)'),
 ('public.agreement_is_launch_ready(uuid,timestamptz)'),
 ('public.tracking_only_product_is_ready(uuid)'),
 ('kma_internal.partner_billing_report_is_ready(uuid,uuid,date,date)'),
 ('public.get_partner_dashboard_summary(uuid,date,date,text,uuid,uuid,uuid,text,text)'),
 ('public.get_partner_dashboard_trends(uuid,date,date,text,uuid,uuid,uuid,text,text,text,text)'),
 ('public.get_partner_dashboard_summary_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text)'),
 ('public.get_partner_dashboard_trends_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text,text,text)'),
 ('public.validate_funnel_metric_event(jsonb,boolean)'),
 ('public.ingest_funnel_metric_event(uuid,uuid,jsonb)'),
 ('public.funnel_metrics_report(jsonb,boolean)'),
 ('public.get_admin_funnel_metrics_report(jsonb)'),
 ('public.get_partner_funnel_metrics_report(jsonb)'),
 ('public.configure_admin_funnel_journey(jsonb)'),
 ('public.get_admin_funnel_journey_configuration(uuid)'),
 ('kma_internal.funnel_journey_report(uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,integer,text,jsonb)')
)
select jsonb_agg(jsonb_build_object('signature',e.signature,'present',p.oid is not null,
 'source_md5',md5(p.prosrc),'security_definer',p.prosecdef,'volatility',p.provolatile,
 'settings',to_jsonb(p.proconfig),'anon_execute',has_function_privilege('anon',p.oid,'execute'),
 'authenticated_execute',has_function_privilege('authenticated',p.oid,'execute')) order by e.signature) as definition_manifest
from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature);
rollback;
