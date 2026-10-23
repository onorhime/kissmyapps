/** Opt-in local supervisor. It never enables provider transfers or touches a hosted URL. */
import {pathToFileURL} from 'node:url'
export function localWorkerOptions(env=process.env,args=process.argv.slice(2)) {
  if(!args.includes('--run')) return null
  if(args.some(value=>!['--run','--once'].includes(value))) throw Error('Only --run and --once are supported.')
  const url=new URL(env.KMA_CREATOR_WORKER_URL??'http://127.0.0.1:55321/functions/v1/creator-payout-worker')
  if(url.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/creator-payout-worker')) throw Error('The local supervisor accepts a loopback creator worker only.')
  const secret=env.INTERNAL_WORKER_SECRET
  if(!secret || secret.length<24) throw Error('Set a local INTERNAL_WORKER_SECRET with at least 24 characters.')
  const interval=Number(env.KMA_CREATOR_WORKER_INTERVAL_MS??60000)
  if(!Number.isSafeInteger(interval)||interval<60000||interval>3600000) throw Error('Worker cadence must be 60 seconds to one hour.')
  return {url:url.href,secret,interval,once:args.includes('--once')}
}
export async function supervise(options,{fetcher=fetch,signal,log=console.log}={}) {
  while(!signal?.aborted){
    try{
      const response=await fetcher(options.url,{method:'POST',headers:{'x-kma-worker-secret':options.secret},signal:AbortSignal.any([AbortSignal.timeout(120000),...(signal?[signal]:[])])})
      // Provider bodies, onboarding links and secrets never enter logs.
      log(JSON.stringify({worker:'creator-payout',status:response.status,at:new Date().toISOString()}))
    }catch{if(signal?.aborted)break;log(JSON.stringify({worker:'creator-payout',status:'unavailable',at:new Date().toISOString()}))}
    if(options.once)break
    await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve()}
      const timer=setTimeout(finish,options.interval);signal?.addEventListener('abort',finish,{once:true})
      if(signal?.aborted)finish()
    })
  }
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try{
    const options=localWorkerOptions()
    if(!options)console.log('Disabled. Use --run for an explicit local worker loop, or --run --once for one tick.')
    else {const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());await supervise(options,{signal:controller.signal})}
  }catch(error){console.error(error.message);process.exitCode=1}
}
