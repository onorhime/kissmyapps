// Acceptance: reads scheduler/cron state and reuses the existing BC Learn click
// for one offer-only lookup. Never calls checkout or inserts synthetic events.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { priorFunctionBundlesUnchanged, sameFunctionBundle } from './processing-release-guards.mjs'
const project = 'mmyruzjemjecqyivhrgr'
const directory = '.cache/release-backups/20260906-processing-scheduler'
const cli = (args, input) =>
  JSON.parse(
    execFileSync('pnpm', ['exec', 'supabase', ...args], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  )
const query = (sql) =>
  cli(
    [
      'db',
      'query',
      '--linked',
      '--project-ref',
      project,
      '--file',
      '/dev/stdin',
      '--output',
      'json',
    ],
    sql,
  ).rows
try {
  const released = JSON.parse(readFileSync(`${directory}/function-release.json`, 'utf8'))
  const preDeploy = JSON.parse(readFileSync(`${directory}/pre-deploy.json`, 'utf8'))
  const functions = cli(['functions', 'list', '--project-ref', project, '--output', 'json'])
  const priorFunctionsUnchanged = priorFunctionBundlesUnchanged(preDeploy.functions, functions)
  const dispatcherHashMatched = sameFunctionBundle(
    released.function,
    functions.find((f) => f.slug === 'processing-dispatch'),
  )
  const health = query('select public.processing_scheduler_health() as health')[0].health
  const completedStages = ['stripe-worker', 'commercial-worker', 'metrics-worker'].every((w) =>
    health.recent_runs.some(
      (r) => r.worker === w && r.outcome === 'succeeded' && r.http_status === 200,
    ),
  )
  const facts = query(`select jsonb_build_object(
    'products',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.products t),
    'offers',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.billing_offers t),
    'agreements',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.agreements t),
    'documents',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.documents t),
    'checkout_attempts',(select count(*) from public.checkout_attempts),
    'provider_events',(select count(*) from public.provider_events),
    'subscriptions',(select count(*) from public.subscriptions),
    'transactions',(select count(*) from public.transactions),
    'commissions',(select count(*) from public.commission_entries),
    'agreement_cron',(select md5(to_jsonb(j)::text) from cron.job j where jobname='kma-agreement-maintenance')
    ) as facts`)[0].facts
  const applicationUnchanged = Object.entries(facts).every(
    ([key, value]) => released.before[key] === value,
  )
  const cron = query(`select j.jobname,j.schedule,j.active,d.status,d.start_time,d.end_time
    from cron.job j left join lateral (select status,start_time,end_time from cron.job_run_details
      where jobid=j.jobid order by start_time desc limit 4) d on true
    where j.jobname='kma-processing-chain' order by d.start_time desc`)
  const click = query(
    "select public_click_id from public.clicks where id='fad029a8-6e02-42fb-9235-73965bfb4efd' and product_id='fdbabb87-9743-4521-bc8d-11804fe1185f'",
  )[0]?.public_click_id
  if (!click) throw Error('Existing acceptance click not available')
  const response = await fetch('https://bc-learn-partner-funnel.vercel.app/api/partner/offer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://bc-learn-partner-funnel.vercel.app',
    },
    body: JSON.stringify({ click_id: click }),
    signal: AbortSignal.timeout(30000),
  })
  const quote = await response.json()
  const offerCheck = {
    httpStatus: response.status,
    checkoutEnabled: quote.checkout_enabled,
    offer: quote.offer,
  }
  const accepted =
    priorFunctionsUnchanged &&
    dispatcherHashMatched &&
    completedStages &&
    applicationUnchanged &&
    health.schedule.enabled &&
    health.schedule.paused_reason === null &&
    !health.attention_required &&
    response.status === 200 &&
    quote.checkout_enabled === false &&
    cron.length >= 3 &&
    cron.every((c) => c.active && c.schedule === '* * * * *' && c.status === 'succeeded')
  const report = {
    at: new Date().toISOString(),
    project,
    accepted,
    priorFunctionsUnchanged,
    dispatcherHashMatched,
    applicationUnchanged,
    completedStages,
    health,
    cron,
    facts,
    offerCheck,
    realStripeDeliveryVerified: false,
    checkoutCalled: false,
    externalTransferEnabled: false,
  }
  writeFileSync(`${directory}/live-acceptance.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  if (!accepted) process.exitCode = 1
} catch {
  console.error(
    'Acceptance could not complete. Inspect scoped scheduler health; no checkout was attempted.',
  )
  process.exitCode = 1
}
