// Narrow, approved production scheduler release. No Stripe calls, payments,
// checkout configuration changes, or credential values in files/console output.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { priorFunctionBundlesUnchanged, sameFunctionBundle } from './processing-release-guards.mjs'

const project = 'mmyruzjemjecqyivhrgr'
const version = '20260906130000'
const migration = `${version}_processing_scheduler.sql`
const directory = '.cache/release-backups/20260906-processing-scheduler'
const sql = readFileSync(`supabase/migrations/${migration}`, 'utf8')
const hash = (v) => createHash('sha256').update(v).digest('hex')
const sha256 = hash(sql)
const literal = (v) => "'" + v.replaceAll("'", "''") + "'"
const run = (args, input, timeout = 60000) =>
  execFileSync('pnpm', ['exec', 'supabase', ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
const query = (queryText) =>
  JSON.parse(
    run(
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
      queryText,
    ),
  ).rows
const save = (name, data) =>
  writeFileSync(`${directory}/${name}.json`, JSON.stringify(data, null, 2))
const load = (name) => JSON.parse(readFileSync(`${directory}/${name}.json`, 'utf8'))
const begin =
  "begin; set local lock_timeout='3s'; set local statement_timeout='25s'; select pg_advisory_xact_lock(hashtextextended('kma-processing-release',0));\n"
const body = sql.replace(/(^|\n)begin;\s*/, '$1').replace(/commit;\s*$/, '')
const state = () =>
  query(`select jsonb_build_object(
 'migrations',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
 'products',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.products t),
 'offers',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.billing_offers t),
 'agreements',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.agreements t),
 'documents',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.documents t),
 'checkout_attempts',(select count(*) from public.checkout_attempts),
 'provider_events',(select count(*) from public.provider_events),
 'subscriptions',(select count(*) from public.subscriptions),
 'transactions',(select count(*) from public.transactions),
 'commissions',(select count(*) from public.commission_entries),
 'agreement_cron',(select md5(to_jsonb(j)::text) from cron.job j where jobname='kma-agreement-maintenance'),
 'schedules',(select coalesce(jsonb_agg(jsonb_build_object('name',jobname,'schedule',schedule,'active',active)),'[]'::jsonb) from cron.job)
 ) as state`)[0].state

let phase = 'preflight'
try {
  mkdirSync(directory, { recursive: true })
  const mode = process.argv[2]
  if (mode === 'health') {
    console.log(JSON.stringify(query('select public.processing_scheduler_health() as health')[0]))
    process.exit(0)
  }
  const before = state()
  const requireNoPayments = () => {
    if (
      ['checkout_attempts', 'provider_events', 'subscriptions', 'transactions', 'commissions'].some(
        (k) => before[k] !== 0,
      )
    )
      throw Error('Real commercial work exists; inspect before this initial scheduler release')
  }
  if (mode === 'test') {
    if (before.migrations.includes(version)) throw Error('Migration already applied')
    phase = 'rollback-only database tests'
    const result = query(
      begin +
        body +
        readFileSync('supabase/tests/database/30_processing_scheduler.sql', 'utf8') +
        '\nrollback;',
    )
    const after = state()
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error('State changed during rollback test')
    save('database-test', { sha256, before, after, result })
    console.log(
      JSON.stringify({
        rollbackComplete: true,
        applicationUnchanged: true,
        result: result.filter((r) => r.passed_scheduler_assertions),
      }),
    )
    process.exit(0)
  }
  if (mode === 'apply-approved') {
    requireNoPayments()
    const test = load('database-test')
    if (test.sha256 !== sha256 || JSON.stringify(before) !== JSON.stringify(test.after))
      throw Error('Test/hash/state drift')
    phase = 'apply tested disabled scheduler schema'
    query(
      begin +
        body +
        `insert into supabase_migrations.schema_migrations(version,name,statements)
      values(${literal(version)},'processing_scheduler',array[${literal(sql)}]); commit;`,
    )
    const after = state()
    if (JSON.stringify(before) !== JSON.stringify({ ...after, migrations: before.migrations }))
      throw Error('Application drift')
    save('database-release', {
      at: new Date().toISOString(),
      project,
      migration,
      sha256,
      before,
      after,
    })
    console.log(JSON.stringify({ migration, sha256, enabled: false, applicationUnchanged: true }))
    process.exit(0)
  }
  if (mode === 'pause-approved') {
    // Preserve in-flight identity; pausing never clears leases or financial data.
    query('update kma_internal.processing_schedule set enabled=false where singleton;')
    console.log('Processing schedule paused; in-flight identity retained.')
    process.exit(0)
  }
  if (mode !== 'deploy-approved' && mode !== 'enable-approved') throw Error('Unknown mode')
  requireNoPayments()
  if (!before.migrations.includes(version) || load('database-release').sha256 !== sha256)
    throw Error('Schema release required')
  const control = query(
    'select enabled,run_id,paused_reason from kma_internal.processing_schedule',
  )[0]
  if (control.enabled || control.run_id || control.paused_reason)
    throw Error('Require clean disabled schedule')

  phase = 'load scoped existing control-plane credential'
  const stored =
    process.env.SUPABASE_ACCESS_TOKEN ||
    execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 },
    ).trim()
  const access = stored.startsWith('go-keyring-base64:')
    ? Buffer.from(stored.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
    : stored
  const api = async (path, payload) => {
    const response = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw Error('Control-plane request failed')
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }
  const funcsBefore = await api('functions')
  if (mode === 'deploy-approved') {
    if (funcsBefore.some((f) => f.slug === 'processing-dispatch'))
      throw Error('Existing dispatch function; inspect before replacement')
    const secretsBefore = await api('secrets')
    if (secretsBefore.some((s) => s.name === 'PROCESSING_SCHEDULER_SECRET'))
      throw Error('Existing scheduler credential; do not rotate blindly')
    if (!secretsBefore.some((s) => s.name === 'INTERNAL_WORKER_SECRET'))
      throw Error('Internal worker credential missing')
    const vaultState =
      query(`select (select count(*) from vault.secrets where name='kma_processing_scheduler') as existing,
      has_table_privilege('anon','vault.decrypted_secrets','select') as anon_access,
      has_table_privilege('authenticated','vault.decrypted_secrets','select') as user_access`)[0]
    if (vaultState.existing !== 0 || vaultState.anon_access || vaultState.user_access)
      throw Error('Vault preflight failed')
    save('pre-deploy', {
      at: new Date().toISOString(),
      functions: funcsBefore,
      secrets: secretsBefore,
      before,
    })
    const credential = randomBytes(48).toString('hex')
    phase = 'provision dedicated scheduler credential without rotating existing workers'
    await api('secrets', [{ name: 'PROCESSING_SCHEDULER_SECRET', value: credential }])
    await api('database/query', {
      query: `select vault.create_secret(${literal(credential)},'kma_processing_scheduler','Dedicated sequential processing scheduler');`,
    })
    const secretsAfter = await api('secrets')
    if (
      secretsAfter.find((s) => s.name === 'PROCESSING_SCHEDULER_SECRET')?.value !==
        hash(credential) ||
      secretsBefore.some((s) => secretsAfter.find((x) => x.name === s.name)?.value !== s.value)
    )
      throw Error('Secret digest/preservation mismatch')
    const digest = query(
      "select encode(extensions.digest(decrypted_secret,'sha256'),'hex') as digest from vault.decrypted_secrets where name='kma_processing_scheduler'",
    )[0]?.digest
    if (digest !== hash(credential)) throw Error('Vault digest mismatch')
    phase = 'deploy only new dispatch function'
    run(
      [
        'functions',
        'deploy',
        'processing-dispatch',
        '--project-ref',
        project,
        '--no-verify-jwt',
        '--use-api',
      ],
      undefined,
      120000,
    )
    const funcsAfter = await api('functions')
    if (!priorFunctionBundlesUnchanged(funcsBefore, funcsAfter))
      throw Error('Existing function source changed')
    phase = 'verify live protected boundaries without starting workers'
    const invoke = async (name, token, body) => {
      const r = await fetch(`https://${project}.supabase.co/functions/v1/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-kma-scheduler-secret': token } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      await r.arrayBuffer()
      return r.status
    }
    const unauthorized = {}
    for (const worker of [
      'stripe-worker',
      'commercial-worker',
      'metrics-worker',
      'processing-dispatch',
    ])
      unauthorized[worker] = await invoke(worker, null, {})
    const unissued = await invoke('processing-dispatch', credential, {
      run_id: '12345678-1234-4234-8234-123456789012',
      worker: 'stripe-worker',
    })
    if (Object.values(unauthorized).some((s) => s !== 401) || unissued !== 409)
      throw Error('Authentication/issuance boundary mismatch')
    const after = state()
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error('Application drift after deploy')
    save('function-release', {
      at: new Date().toISOString(),
      project,
      function: funcsAfter.find((f) => f.slug === 'processing-dispatch'),
      credentialDigestMatched: true,
      priorSecretsPreserved: true,
      priorFunctionsPreserved: true,
      unauthorized,
      unissued,
      before,
      after,
    })
    console.log(
      JSON.stringify({
        deployed: 'processing-dispatch',
        credentialDigestMatched: true,
        priorSecretsPreserved: true,
        priorFunctionsPreserved: true,
        unauthorized,
        unissued,
        schedulerEnabled: false,
      }),
    )
  } else {
    phase = 'enable approved minute cadence after protected boundary verification'
    const release = load('function-release')
    if (
      !sameFunctionBundle(
        release.function,
        funcsBefore.find((f) => f.slug === 'processing-dispatch'),
      )
    )
      throw Error('Dispatch source drift')
    query(
      begin +
        `
      do $$ begin
        if exists(select 1 from cron.job where jobname='kma-processing-chain'
          or command ilike '%tick_processing_schedule%') then raise exception 'Scheduler already exists'; end if;
        perform cron.schedule('kma-processing-chain','* * * * *','select kma_internal.tick_processing_schedule();');
        update kma_internal.processing_schedule set enabled=true where singleton and not enabled
          and run_id is null and paused_reason is null;
        if not found then raise exception 'Schedule state changed'; end if;
      end $$;
      commit;`,
    )
    const after = state()
    if (before.agreement_cron !== after.agreement_cron) throw Error('Agreement schedule drift')
    save('schedule-release', {
      at: new Date().toISOString(),
      project,
      cadence: '* * * * *',
      before,
      after,
    })
    console.log(
      JSON.stringify({
        enabled: true,
        cadence: 'every minute; each stage awaits prior response',
        agreementScheduleUnchanged: true,
      }),
    )
  }
} catch (error) {
  console.error(
    `Stopped during ${phase}. Inspect saved state before retrying; no automatic rotation or duplicate creation.`,
  )
  // Static SQL tests have no credentials. Never include raw control-plane or
  // secret-provisioning errors (which can echo request content).
  if (phase === 'rollback-only database tests')
    console.error(String(error.stderr || error.message).slice(0, 2200))
  process.exitCode = 1
}
