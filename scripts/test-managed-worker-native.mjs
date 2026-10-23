/** Disposable PostgreSQL scheduler/lease audit. No hosted database or HTTP. */
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pg='/opt/homebrew/opt/postgresql@17/bin',qa=mkdtempSync('/tmp/kma-managed-schedule.');
const env={...process.env,PGHOST:qa,PGDATABASE:'postgres'};
for(const k of ['PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGPORT','PGUSER'])delete env[k];
const run=(name,args,input)=>execFileSync(join(pg,name),args,{cwd:root,env,input,encoding:'utf8',timeout:120000,stdio:['pipe','pipe','pipe']});
const args=['-h',qa,'-d','postgres','-XAtq','-v','ON_ERROR_STOP=1'];
const sql=input=>run('psql',args,input);
const asyncSql=input=>new Promise((resolve,reject)=>{const p=spawn(join(pg,'psql'),args,{cwd:root,env,stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',s=>out+=s);p.stderr.on('data',s=>err+=s);p.on('error',reject);p.on('exit',code=>code?reject(Error(err)):resolve(out.trim()));p.stdin.end(input);});
let started=false;
try{
 run('initdb',['-D',join(qa,'data'),'-A','trust']);run('pg_ctl',['-D',join(qa,'data'),'-l',join(qa,'postgres.log'),'-o',`-k ${qa} -c listen_addresses=''`,'start']);started=true;
 sql(readFileSync(join(root,'supabase/tests/bootstrap/external-commerce-native.sql'),'utf8'));
 for(const file of readdirSync(join(root,'supabase/migrations')).filter(n=>n.endsWith('.sql')).sort())sql(readFileSync(join(root,'supabase/migrations',file),'utf8').replace(/^create extension if not exists pg_net with schema extensions;\s*$/m,''));
 const suites=[];
 for(const name of ['50_managed_checkout.sql','53_managed_checkout_schedule.sql']){
  const output=sql(readFileSync(join(root,'supabase/tests/database',name),'utf8'));writeFileSync(join(qa,name+'.log'),output);suites.push({name,passed:true});
 }
 // Separate connections race for a durable singleton owner. One winning RPC
 // does not disappear at transaction end; later invocations remain excluded.
 const owners=await Promise.all(Array.from({length:6},()=>asyncSql("select public.begin_managed_checkout_worker()->>'run_id';")));
 const winners=owners.filter(Boolean);if(winners.length!==1)throw Error('Expected exactly one durable worker owner');
 if(sql("select count(*) from kma_internal.managed_checkout_worker_runs where outcome='running';").trim()!=='1')throw Error('Duplicate running workers');
 // Independent sessions contend on the actual tick advisory lock. The winner
 // holds it while the losing tick is required to return locked without HTTP.
 let lockedResolve;const lockAcquired=new Promise(r=>lockedResolve=r);
 const holder=spawn(join(pg,'psql'),args,{cwd:root,env,stdio:['pipe','pipe','pipe']});let holderOut='',holderErr='';
 holder.stdout.on('data',s=>{holderOut+=s;if(holderOut.includes('held'))lockedResolve();});holder.stderr.on('data',s=>holderErr+=s);
 const holderDone=new Promise((r,j)=>{holder.on('error',j);holder.on('exit',code=>code?j(Error(holderErr)):r());});
 holder.stdin.write("begin;select pg_advisory_xact_lock(hashtextextended('kma-managed-checkout-scheduler',0));select 'held';\n");
 await lockAcquired;
 const competing=sql("select kma_internal.tick_managed_checkout_schedule()->>'status';").trim();
 holder.stdin.end('rollback;\n');await holderDone;
 if(competing!=='locked')throw Error('Competing scheduler was not excluded');
 const result={passed:true,suites,concurrentOwnerInvocations:6,owners:winners.length,competingTick:competing,providersCalled:0,hostedMutation:false,transport:'stubbed pg_net; real local PostgreSQL transactions',evidenceDirectory:qa};
 writeFileSync(join(qa,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error(e.stderr?.toString()||e.message);process.exitCode=1;}
finally{if(started)run('pg_ctl',['-D',join(qa,'data'),'stop','-m','fast']);}
