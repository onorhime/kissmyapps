// Scoped reporting-definition release. No financial/identity/queue fixture writes.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const project = 'mmyruzjemjecqyivhrgr'
const version = '20260907150000'
const file = `supabase/migrations/${version}_partner_billing_metric_availability.sql`
const sql = readFileSync(file,'utf8')
const body = sql.replace(/(^|\n)begin;\s*/,'$1').replace(/commit;\s*$/,'')
const query = input => JSON.parse(execFileSync('pnpm',['exec','supabase','db','query','--linked',
  '--project-ref',project,'--file','/dev/stdin','--output','json'],{
  input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000,maxBuffer:8*1024*1024,
})).rows
const names = ['get_partner_dashboard_summary_commercial','get_partner_dashboard_trends_commercial']
const snapshot = () => query(`select jsonb_build_object(
 'definitions',(select jsonb_object_agg(proname,md5(prosrc)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and proname in ('${names.join("','")}')),
 'contracts',(select jsonb_object_agg(proname,jsonb_build_object('acl',proacl,'config',proconfig,'owner',proowner,
  'security_definer',prosecdef,'volatility',provolatile,'args',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid)))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('${names.join("','")}')),
 'other_functions',(select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.oid)) from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and proname not in ('${names.join("','")}')),
 'records', (select jsonb_object_agg(table_name,digest) from (
 ${['products','agreements','affiliate_links','billing_offers','clicks','events','provider_events','checkout_attempts','subscriptions','transactions','commission_entries','payouts','affiliate_daily_metrics'].map(t=>`select '${t}' as table_name,md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) as digest from public.${t} t`).join(' union all ')}
 ) s),
 'migrations',(select count(*) from supabase_migrations.schema_migrations)
) as state`)[0].state
const guard = `do $$ begin
 if (select count(*) from supabase_migrations.schema_migrations)<>43
  or exists(select 1 from supabase_migrations.schema_migrations where version='${version}')
  or to_regprocedure('kma_internal.partner_billing_report_is_ready(uuid,uuid,date,date)') is not null
  or (select md5(prosrc) from pg_proc where oid='public.get_partner_dashboard_summary_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text)'::regprocedure)<>'7556f4aa4ac1e66e83b3701e1e62463b'
  or (select md5(prosrc) from pg_proc where oid='public.get_partner_dashboard_trends_commercial(uuid,date,date,text,uuid,uuid,uuid,text,text,text,text)'::regprocedure)<>'6b7ddd83a900d07990214868b09c4f7b'
 then raise exception 'Reporting release baseline drift; inspect before retrying'; end if;
end $$;`
const accept = `do $$ declare member uuid; tz text; s record; begin
 select au.user_id,a.reporting_timezone into strict member,tz from public.affiliate_users au
 join public.affiliates a on a.id=au.affiliate_id join auth.users u on u.id=au.user_id
 where au.affiliate_id='1edd76ad-239b-4f06-a7e8-f75cd67f4b19' and au.active and lower(u.email)='nobrainer.ng@gmail.com';
 perform set_config('request.jwt.claim.sub',member::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'role','authenticated')::text,true);
 select * into strict s from public.get_partner_dashboard_summary('fdbabb87-9743-4521-bc8d-11804fe1185f',
  (now() at time zone tz)::date-29,(now() at time zone tz)::date,tz,null,null,null,null,null);
 if s.has_data is distinct from true or s.clicks is distinct from 5 or s.purchases is distinct from 0 or s.earnings_minor is distinct from 0
  or s.active_subscriptions is distinct from 2 or s.currency is distinct from 'USD' or s.reconciliation_stage is distinct from 'preliminary'
  or s.installs is not null or s.leads is not null then raise exception 'Existing-record acceptance drift: %',row_to_json(s); end if;
 if has_function_privilege('authenticated','kma_internal.partner_billing_report_is_ready(uuid,uuid,date,date)','execute')
  or has_function_privilege('anon','public.get_partner_dashboard_summary(uuid,date,date,text,uuid,uuid,uuid,text,text)','execute')
  then raise exception 'Reporting privilege regression'; end if;
end $$;`
try {
 const mode=process.argv[2]
 if (!['--check','--apply'].includes(mode)) throw Error('Use --check or --apply')
 const before=snapshot()
 const result=query("begin; set local lock_timeout='3s'; set local statement_timeout='25s'; select pg_advisory_xact_lock(hashtextextended('partner-billing-reporting-release',0));\n"+
  guard+'\n'+body+'\n'+accept+'\n'+(mode==='--apply'
   ? `insert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','partner_billing_metric_availability',array['${body.replaceAll("'","''")}']);commit;`
   : 'rollback;')+"select 'accepted' as result;")
 const after=snapshot()
 const preserved=JSON.stringify(before.contracts)===JSON.stringify(after.contracts)
  &&before.other_functions===after.other_functions&&JSON.stringify(before.records)===JSON.stringify(after.records)
 const passed=preserved&&(mode==='--apply'?after.migrations===44:JSON.stringify(before)===JSON.stringify(after))
 const evidence={at:new Date().toISOString(),project,mode,passed,preserved,sha256:createHash('sha256').update(sql).digest('hex'),result,before,after}
 writeFileSync(`/tmp/kma-billing-release.0HDOQI/database-${mode.slice(2)}.json`,JSON.stringify(evidence,null,2))
 console.log(JSON.stringify({at:evidence.at,mode,passed,preserved,sha256:evidence.sha256,migrations:after.migrations,definitions:after.definitions}))
 if(!passed)process.exitCode=1
} catch(error) {
 console.error(error.stderr?.toString()||error.message||'Reporting release stopped')
 process.exitCode=1
}
