/** Broad isolated SQL audit. Never uses linked/hosted Supabase or providers.
 * All suites use disposable synthetic fixtures; no hosted account/cache assumptions.
 * --without-funnel-metrics repeats the older suites against the pre-change schema.
 */
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), pg='/opt/homebrew/opt/postgresql@17/bin';
const qa=mkdtempSync('/tmp/kma-all-sql-db.'),log=join(qa,'tests.log');
const env={...process.env,PGHOST:qa,PGDATABASE:'postgres'};
for(const key of ['PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGPORT','PGUSER'])delete env[key];
const run=(name,args,input)=>execFileSync(join(pg,name),args,{cwd:root,env,input,encoding:'utf8',timeout:120000,stdio:['pipe','pipe','pipe']});
const sql=input=>run('psql',['-h',qa,'-d','postgres','-XAtq','-v','ON_ERROR_STOP=1'],input);
const read=n=>readFileSync(join(root,'supabase/tests/database',n),'utf8');
const strip=s=>s.replace(/(^|\n)begin;\s*/,'$1').replace(/rollback;\s*$/,'');
const setup24=strip(read('24_agreement_audit_regression.sql').split("set local role service_role;\ninsert into audit_values values('jobs'")[0]);
const wrap=s=>`begin;set local time zone 'UTC';set local statement_timeout='45s';set local kma.test.disposable_database='true';\n${strip(s)}\nreset role;rollback;`;
const results=[];let started=false;
try{
 run('initdb',['-D',join(qa,'data'),'-A','trust']);run('pg_ctl',['-D',join(qa,'data'),'-l',join(qa,'postgres.log'),'-o',`-k ${qa} -c listen_addresses=''`,'start']);started=true;
 sql(readFileSync(join(root,'supabase/tests/bootstrap/external-commerce-native.sql'),'utf8')+`\nalter table auth.users add column created_at timestamptz default now(),add column updated_at timestamptz default now(),add column last_sign_in_at timestamptz;grant usage on schema storage,extensions to anon,authenticated,service_role;grant all on storage.objects to authenticated,service_role;alter table storage.objects enable row level security;`);
 const migrations=readdirSync(join(root,'supabase/migrations')).filter(n=>n.endsWith('.sql')&&!(process.argv.includes('--without-funnel-metrics')&&n.includes('_funnel_metrics.sql'))).sort();
 for(const file of migrations)sql(readFileSync(join(root,'supabase/migrations',file),'utf8').replace(/^create extension if not exists pg_net with schema extensions;\s*$/m,''));
 sql('create extension if not exists pgtap with schema extensions;grant execute on all functions in schema extensions to authenticated,service_role,anon;');
 for(const name of readdirSync(join(root,'supabase/tests/database')).filter(n=>n.endsWith('.sql')).sort()){
  const id=Number(name.slice(0,2));
  if(id===39&&process.argv.includes('--without-funnel-metrics')){results.push({name,status:'skipped',reason:'Baseline excludes new feature'});continue;}
  let source=read(name);
  if(id===25)source=setup24+'\n'+source;
  if(id===26||id===32)source=setup24+'\n'+read('25_funnel_checkout_context.sql')+'\n'+read('26_zero_total_checkout.sql')+(id===32?'\n'+source:'');
  if(id===29){const f=read('25_funnel_checkout_context.sql'),at=f.indexOf('select public.finalize_checkout_attempt(');const [pre,post]=source.split('-- AFTER_NORMALIZATION');source=setup24+'\n'+f.slice(0,at)+pre+'\n'+f.slice(at)+'\n'+read('26_zero_total_checkout.sql')+'\n'+post;}
  if(id===34||id===36||id===37)source=`insert into auth.users(id,email,email_confirmed_at) values('99000000-0000-4000-8000-000000000001','local-admin@example.invalid',now());insert into public.admin_users(user_id,role) values('99000000-0000-4000-8000-000000000001','owner');\n`+source;
  if([25,26,29,32].includes(id))source="insert into public.platform_settings(singleton,tracking_base_url,tracking_enabled) values(true,'https://go.kissmyapps.dev',true);\n"+source;
  appendFileSync(log,`\nTEST ${name}\n`);
  try{const output=sql(wrap(source));appendFileSync(log,output);const failed=output.split('\n').filter(line=>/^\s*not ok\b/.test(line));results.push({name,status:failed.length?'failed':'passed',failures:failed});}
  catch(error){const detail=(error.stderr?.toString()||error.message).trim();appendFileSync(log,detail+'\n');results.push({name,status:'failed',failures:[detail]});}
 }
 const summary={migrations:migrations.length,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,skipped:results.filter(r=>r.status==='skipped').length,results};
 writeFileSync(join(qa,'result.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({migrations:summary.migrations,passed:summary.passed,failed:summary.failed,skipped:summary.skipped,evidence:join(qa,'result.json')}));
 if(summary.failed)process.exitCode=1;
}catch(error){console.error(error.stderr?.toString()||error.message);process.exitCode=1;}
finally{if(started)run('pg_ctl',['-D',join(qa,'data'),'stop','-m','fast']);}
