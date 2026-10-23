// Scoped compatibility release. Test data always rolls back; no Stripe writes.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const read = (p) => readFileSync(p, 'utf8')
const query = (sql) => JSON.parse(execFileSync('pnpm', ['exec','supabase','db','query','--linked',
  '--project-ref','mmyruzjemjecqyivhrgr','--file','/dev/stdin','--output','json'],
  {input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000,maxBuffer:8e6})).rows
const file='supabase/migrations/20260907090000_stripe_clover_event_compatibility.sql'
const body=read(file).replace(/^begin;/,'').replace(/commit;\s*$/,'')
const prefix="begin;set local lock_timeout='3s';set local statement_timeout='25s';"
try {
  if(process.argv[2]==='test') {
    const setup=read('supabase/tests/database/24_agreement_audit_regression.sql')
      .split("set local role service_role;\ninsert into audit_values values('jobs'")[0].replace(/(^|\n)begin;\s*/,'$1')
    const results=query(prefix+body+setup+read('supabase/tests/database/25_funnel_checkout_context.sql')+
      read('supabase/tests/database/26_zero_total_checkout.sql')+read('supabase/tests/database/32_stripe_clover_compatibility.sql')+'\nreset role;rollback;')
    console.log(results.filter(r=>Object.keys(r).some(k=>k.startsWith('passed_'))))
  } else if(process.argv[2]==='apply') {
    const statement=body.replaceAll("'","''")
    console.log(query(prefix+body+`insert into supabase_migrations.schema_migrations(version,name,statements) values
      ('20260907090000','stripe_clover_event_compatibility',array['${statement}']);commit;select 'applied' result;`))
  } else throw Error('Use test or apply')
} catch(e) {console.error(e.stderr?.toString() || e.message);process.exitCode=1}
