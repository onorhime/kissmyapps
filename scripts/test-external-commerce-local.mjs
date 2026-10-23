/** Native PostgreSQL regression. No provider credentials/network calls. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pg='/opt/homebrew/opt/postgresql@17/bin';
const qa=mkdtempSync(join('/tmp','kma-external-commerce-db.'));
const env={...process.env,PGHOST:qa,PGDATABASE:'postgres'};
for(const key of['PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGPORT','PGUSER'])delete env[key];
const log=join(qa,'tests.log');let started=false,success=false;
const run=(name,args)=>execFileSync(join(pg,name),args,{cwd:root,env,encoding:'utf8',timeout:120000});
const sql=(text)=>{try{const result=execFileSync(join(pg,'psql'),['-h',qa,'-d','postgres','-Xq','-v','ON_ERROR_STOP=1'],{cwd:root,env,input:text,encoding:'utf8',timeout:120000});appendFileSync(log,result);}catch(error){appendFileSync(log,error.stderr?.toString()||error.message);throw error;}};
try{
 run('initdb',['-D',join(qa,'data'),'-A','trust']);
 run('pg_ctl',['-D',join(qa,'data'),'-l',join(qa,'postgres.log'),'-o',`-k ${qa} -c listen_addresses=''`,'start']);started=true;
 sql(readFileSync(join(root,'supabase/tests/bootstrap/external-commerce-native.sql'),'utf8'));
 const migrations=readdirSync(join(root,'supabase/migrations')).filter(name=>name.endsWith('.sql')).sort();
 for(const file of migrations){appendFileSync(log,`Migration: ${file}\n`);sql(readFileSync(join(root,'supabase/migrations',file),'utf8').replace(/^create extension if not exists pg_net with schema extensions;\s*$/m,''));}
 sql(readFileSync(join(root,'supabase/tests/database/38_external_commerce.sql'),'utf8'));
 sql(readFileSync(join(root,'supabase/tests/database/39_funnel_metrics.sql'),'utf8'));
 if(process.argv.includes('--keep')){sql(readFileSync(join(root,'supabase/tests/fixtures/external-commerce-local.sql'),'utf8'));sql(readFileSync(join(root,'supabase/tests/fixtures/funnel-metrics-local.sql'),'utf8'));}
 success=true;writeFileSync(join(qa,'result.json'),JSON.stringify({passed:true,migrations:migrations.length,pgNet:'disabled HTTP-rejecting fixture',socket:qa}));
 console.log(`PASS ${migrations.length} KMA migrations + commerce and funnel-metrics regressions. Evidence: ${log}`);
 if(process.argv.includes('--keep'))console.log(`Fixture socket: ${qa}`);
}catch(error){console.error(error.stderr?.toString()||error.message);console.error(`Evidence: ${log}`);process.exitCode=1;}
finally{if(started&&!(success&&process.argv.includes('--keep')))run('pg_ctl',['-D',join(qa,'data'),'stop','-m','fast']);}
