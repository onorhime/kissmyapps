import {test} from 'node:test'
import assert from 'node:assert/strict'
import {localWorkerOptions,supervise} from './creator-payout-loop.mjs'
const env={INTERNAL_WORKER_SECRET:'local-fixture-secret-00000000'}
test('supervisor defaults off and accepts only explicitly chosen local endpoints',()=>{
 assert.equal(localWorkerOptions({},[]),null)
 assert.equal(localWorkerOptions(env,['--run','--once']).once,true)
 for(const url of ['https://example.com/creator-payout-worker','http://example.com/creator-payout-worker','http://user:pass@localhost/creator-payout-worker'])assert.throws(()=>localWorkerOptions({...env,KMA_CREATOR_WORKER_URL:url},['--run']))
 assert.throws(()=>localWorkerOptions({...env,KMA_CREATOR_WORKER_INTERVAL_MS:'1'},['--run']))
})
test('one tick authenticates worker but logs no response content or secret',async()=>{
 const options=localWorkerOptions(env,['--run','--once']),logs=[]
 await supervise(options,{fetcher:async(url,init)=>{assert.equal(url,options.url);assert.equal(init.headers['x-kma-worker-secret'],env.INTERNAL_WORKER_SECRET);return new Response('private provider result',{status:200})},log:v=>logs.push(v)})
 assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0]).status,200);assert.equal(logs.join('').includes(env.INTERNAL_WORKER_SECRET),false);assert.equal(logs.join('').includes('private'),false)
})
