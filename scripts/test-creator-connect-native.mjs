/** Fresh socket-only PostgreSQL + actual edge handlers + fake Stripe transport.
 * No hosted database, Stripe key, real email or external money movement. */
import {execFileSync} from 'node:child_process'
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), pg='/opt/homebrew/opt/postgresql@17/bin'
const supplied=process.argv[2]
if(supplied&&!/^\/(?:private\/)?tmp\/kma-all-sql-db\.[A-Za-z0-9]+$/.test(supplied))throw Error('Only a retained isolated SQL fixture is accepted.')
const qa=supplied??mkdtempSync('/tmp/kma-creator-e2e.'),env={PATH:process.env.PATH,USER:process.env.USER,PGHOST:qa,PGDATABASE:'postgres',LC_ALL:'C',LANG:'C'}
const run=(name,args,input)=>execFileSync(join(pg,name),args,{cwd:root,env,input,encoding:'utf8',timeout:120000,stdio:['pipe','pipe','pipe']})
const sql=input=>run('psql',['-h',qa,'-d','postgres','-XAtq','-v','ON_ERROR_STOP=1'],input)
let started=false
try{
 if(!supplied){
 run('initdb',['-D',join(qa,'data'),'-A','trust','--locale=C'])
 run('pg_ctl',['-D',join(qa,'data'),'-l',join(qa,'postgres.log'),'-o',`-k ${qa} -c listen_addresses=''`,'start']);started=true
 sql(readFileSync(join(root,'supabase/tests/bootstrap/external-commerce-native.sql'),'utf8')+`\nalter table auth.users add column created_at timestamptz default now(),add column updated_at timestamptz default now(),add column last_sign_in_at timestamptz;grant usage on schema storage,extensions to anon,authenticated,service_role;grant all on storage.objects to authenticated,service_role;alter table storage.objects enable row level security;`)
 for(const name of readdirSync(join(root,'supabase/migrations')).filter(n=>n.endsWith('.sql')).sort())sql(readFileSync(join(root,'supabase/migrations',name),'utf8').replace(/^create extension if not exists pg_net with schema extensions;\s*$/m,''))
 }
 if(supplied&&process.argv.includes('--reset-fixture')){
   const unexpected=sql("select (select count(*) from public.products where id::text not like 'ac570000-%')+(select count(*) from public.affiliates where id::text not like 'ac570000-%')+(select count(*) from auth.users where id::text not like 'ac570000-%')+(select count(*) from public.external_settlement_platforms where platform_account_id<>'acct_fixture')+(select count(*) from public.creator_connect_events where platform_account_id<>'acct_fixture')").trim()
   if(unexpected!=='0')throw Error('Refusing reset: shared fixture contains non-acceptance rows.')
   sql('truncate public.products,public.affiliates,auth.users,public.external_settlement_platforms,public.creator_connect_events cascade;')
 }
 const fixture=readFileSync(join(root,'supabase/tests/fixtures/external-canonical.sql'),'utf8')
 sql('begin;\n'+fixture+`\nselect pg_temp.make_order(2);select public.process_external_commissions();
 set local role authenticated;select pg_temp.admin();
 select public.perform_admin_external_settlement_action(current_setting('qa.scope')::jsonb||jsonb_build_object('request_id',gen_random_uuid(),'action','prepare_batch','reason','Native edge fixture batch'));
 select public.perform_admin_external_settlement_action(jsonb_build_object('request_id',gen_random_uuid(),'action','set_platform_enabled','platform_account_id','acct_fixture','livemode',false,'enabled',true,'expected_revision',1,'reason','Enable isolated fake provider fixture'));
 reset role;commit;`)
 const result=execFileSync('deno',['run','--config','supabase/functions/deno.json','--allow-env=KMA_CREATOR_TEST_SOCKET,USER',`--allow-run=${pg}/psql`,'supabase/functions/creator-connect/native-integration.ts'],{cwd:root,env:{...env,KMA_CREATOR_TEST_SOCKET:qa},encoding:'utf8',timeout:120000,stdio:['pipe','pipe','pipe']})
 writeFileSync(join(qa,'edge-sql-evidence.log'),result);console.log(JSON.stringify({status:'passed',evidence:join(qa,'edge-sql-evidence.log')}))
}catch(error){const detail=(error.stderr?.toString()||'')+'\n'+(error.stdout?.toString()||'')+'\n'+error.message;writeFileSync(join(qa,'failure.log'),detail);console.error(detail);console.error(`Evidence: ${qa}`);process.exitCode=1}
finally{if(started)run('pg_ctl',['-D',join(qa,'data'),'stop','-m','fast'])}
