import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const read = p => readFileSync(p,'utf8')
const query=sql=>JSON.parse(execFileSync('pnpm',['exec','supabase','db','query','--linked','--project-ref','mmyruzjemjecqyivhrgr','--file','/dev/stdin','--output','json'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000,maxBuffer:8e6})).rows
const body=read('supabase/migrations/20260907093000_embedded_checkout_presentation.sql').replace(/^begin;/,'').replace(/commit;\s*$/,'')
const prefix="begin;set local lock_timeout='3s';set local statement_timeout='25s';"
try{
 if(process.argv[2]==='test') {
  const setup=read('supabase/tests/database/24_agreement_audit_regression.sql').split("set local role service_role;\ninsert into audit_values values('jobs'")[0].replace(/(^|\n)begin;\s*/,'$1')
  for(const embedded of [false,true]){
   let funnel=read('supabase/tests/database/25_funnel_checkout_context.sql')
   if(embedded) {
    const start=funnel.indexOf('select public.finalize_checkout_attempt(')
    if(start<0)throw Error('Fixture drift')
    const binding=`select public.bind_checkout_presentation((select (value->>'attempt_id')::uuid from audit_values where key='context-attempt'),'embedded',repeat('a',64));
select pg_temp.expect_error(format('select public.bind_checkout_presentation(%L,%L,%L)',(select value->>'attempt_id' from audit_values where key='context-attempt'),'hosted',repeat('a',64)),'23505','mode is immutable');
select pg_temp.expect_error(format('select public.bind_checkout_presentation(%L,%L,%L)',(select value->>'attempt_id' from audit_values where key='context-attempt'),'embedded',repeat('b',64)),'23505','buyer fingerprint is immutable');\n`
    funnel=funnel.slice(0,start)+binding+funnel.slice(start).replace("'checkout_url','https://checkout.stripe.com/c/pay/rollback9501'","'checkout_url',null")
   }
   console.log({embedded,results:query(prefix+body+setup+funnel+read('supabase/tests/database/26_zero_total_checkout.sql')+'\nreset role;rollback;').filter(r=>Object.keys(r).some(k=>k.startsWith('passed_')))})
  }
 }else if(process.argv[2]==='apply'){
  console.log(query(prefix+body+`insert into supabase_migrations.schema_migrations(version,name,statements) values('20260907093000','embedded_checkout_presentation',array['${body.replaceAll("'","''")}']);commit;select 'applied' result;`))
 }else throw Error('Use test or apply')
}catch(e){console.error(e.stderr?.toString()||e.message);process.exitCode=1}
