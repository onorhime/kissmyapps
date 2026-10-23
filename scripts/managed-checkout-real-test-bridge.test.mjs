import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {kmaRoot} from './managed-checkout-crossapp-fixture.mjs'
test('real test bridge installs forwarding secret privately and verifies raw events before any provider access',async()=>{
 const control='local-control-fixture-only-'.repeat(2),base=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/STRIPE|SUPABASE|KMA|CROSSAPP/.test(k)))
 const child=spawn('deno',['run','--cached-only','--config','supabase/functions/deno.json','--allow-env','--allow-net=127.0.0.1','scripts/managed-checkout-real-test-bridge.ts'],{cwd:kmaRoot,env:{...base,KMA_REAL_TEST_ENABLED:'true',KMA_REAL_TEST_STRIPE_SECRET_KEY:'sk_test_fixture123456789',KMA_REAL_TEST_STRIPE_ACCOUNT_ID:'acct_fixture',KMA_REAL_TEST_STRIPE_PRICE_ID:'price_fixture123456789',CROSSAPP_CONTROL_ORIGIN:'http://127.0.0.1:12345',CROSSAPP_CONTROL_SECRET:control,CROSSAPP_INBOUND_SECRET:control,CROSSAPP_OUTBOUND_SECRET:control},stdio:['ignore','pipe','pipe']})
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk});let output=''
 try{
 const started=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Local bridge readiness timeout')),10000);child.stdout.on('data',chunk=>{output+=chunk;const line=output.split('\n').find(v=>v.startsWith('{'));if(line){clearTimeout(timeout);resolve(JSON.parse(line))}});child.once('exit',()=>{clearTimeout(timeout);reject(Error('Local bridge stopped: '+stderr))})})
 const origin='http://127.0.0.1:'+started.port,headers={'content-type':'application/json','x-local-control':control}
 assert.deepEqual(Object.keys(JSON.parse(output.trim())),['port'])
 assert.equal((await fetch(origin+'/functions/v1/managed-checkout-webhook?binding_id=real-stripe-test',{method:'POST',body:'{}'})).status,503)
 assert.equal((await fetch(origin+'/__local/webhook-secret',{method:'POST',headers,body:JSON.stringify({secret:'whsec_localfixture123456'})})).status,200)
 const rejected=await fetch(origin+'/functions/v1/managed-checkout-webhook?binding_id=real-stripe-test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(rejected.status,400)
 const state=await(await fetch(origin+'/__local/state',{method:'POST',headers})).json();assert.equal(state.webhookReady,true);assert.equal(state.webhookRejected,1);assert.equal(state.webhookProcessed,0)
 assert(!output.includes(control));assert(!output.includes('whsec_'))
 }finally{child.kill('SIGTERM');await once(child,'exit')}
})
