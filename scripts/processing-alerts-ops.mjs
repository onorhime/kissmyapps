// Explicit, narrowly scoped operations. No credentials printed or persisted.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
const project = 'mmyruzjemjecqyivhrgr'
const recipient = 'onorhimevictory2017@gmail.com'
const mode = process.argv[2] ?? 'status'
if (
  ![
    'status',
    'test',
    'schema-approved',
    'functions-approved',
    'enable-approved',
    'test-email-approved',
  ].includes(mode)
)
  throw Error('Unknown mode')
const stored = execFileSync(
  '/usr/bin/security',
  ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 },
).trim()
const access = stored.startsWith('go-keyring-base64:')
  ? Buffer.from(stored.slice(18), 'base64').toString('utf8')
  : stored
const api = async (path, body) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) {
    if (mode === 'test') console.error((await r.text()).slice(0, 1000))
    throw Error(`Control-plane HTTP ${r.status}`)
  }
  const text = await r.text()
  return text ? JSON.parse(text) : null
}
const query = (sql) => api('database/query', { query: sql })
const versions = ['20260907160000', '20260907170000']
const files = versions.map(
  (v, i) =>
    `supabase/migrations/${v}_${i ? 'processing_alerts' : 'processing_reliability_visibility'}.sql`,
)
const bodies = files.map((f) =>
  readFileSync(f, 'utf8')
    .replace(/(^|\n)begin;\s*/, '$1')
    .replace(/commit;\s*$/, ''),
)
const hash = (s) => createHash('sha256').update(s).digest('hex')
const literal = (s) => "'" + s.replaceAll("'", "''") + "'"
const guards = `set local lock_timeout='3s';set local statement_timeout='20s';select pg_advisory_xact_lock(hashtextextended('kma-processing-scheduler',0));`
const fingerprints = async () =>
  (
    await query(`select jsonb_build_object(
 'attempts',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.checkout_attempts x),
 'events',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.provider_events x),
 'subscriptions',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.subscriptions x),
 'transactions',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.transactions x),
 'commissions',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by id)::text,'')) from public.commission_entries x),
 'core_definitions',(select jsonb_object_agg(proname,md5(prosrc)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
 (n.nspname='public' and proname in ('processing_scheduler_health','begin_processing_stage')) or
 (n.nspname='kma_internal' and proname in ('tick_processing_schedule','finish_processing_stage'))),
 'prior_cron',(select jsonb_agg(jsonb_build_object('id',jobid,'name',jobname,'active',active,'schedule',schedule,'command',command) order by jobid) from cron.job where jobname<>'kma-processing-alerts')
 ) as value`)
  )[0].value
const migrations = async () =>
  (await query('select version from supabase_migrations.schema_migrations order by version')).map(
    (r) => r.version,
  )
const status = async () => {
  const m = await migrations()
  const hasAlerts = m.includes(versions[1])
  const health = (await query('select public.processing_scheduler_health() as value'))[0].value
  const alert = hasAlerts
    ? (
        await query(`select jsonb_build_object('enabled',c.enabled,'recipient',c.recipient_email,'last_observed_at',c.last_observed_at,
  'cron_active',exists(select 1 from cron.job where jobname='kma-processing-alerts' and active),
  'jobs',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'status',status,'attempts',attempts,'provider_id',provider_id,'last_error',last_error,'accepted_at',accepted_at) order by sequence_number),'[]') from kma_internal.processing_alert_jobs)) as value from kma_internal.processing_alert_config c`)
      )[0].value
    : null
  return {
    at: new Date().toISOString(),
    project,
    migrationCount: m.length,
    health,
    alerts: alert,
    financial: await fingerprints(),
  }
}
let phase = 'preflight'
try {
  if (mode === 'status') {
    console.log(JSON.stringify(await status()))
    process.exit(0)
  }
  const before = await fingerprints()
  const m = await migrations()
  if (mode === 'test') {
    phase = 'rollback tests'
    if (versions.some((v) => m.includes(v)))
      throw Error('Candidate schema already applied; inspect before reusing candidate tests')
    const a = await query(
      'begin;' +
        guards +
        bodies[0] +
        readFileSync('supabase/tests/database/34_processing_reliability_visibility.sql', 'utf8') +
        'rollback;',
    )
    const b = await query(
      'begin;' +
        guards +
        bodies.join('\n') +
        readFileSync('supabase/tests/database/35_processing_alerts.sql', 'utf8') +
        'rollback;',
    )
    console.log(JSON.stringify({ rollback: true, diagnostics: a, alerts: b }))
  } else if (mode === 'schema-approved') {
    phase = 'additive schema'
    if (versions.some((v) => m.includes(v)) || m.length !== 44) throw Error('Migration drift')
    const sql =
      'begin;' +
      guards +
      bodies.join('\n') +
      versions
        .map(
          (v, i) =>
            `insert into supabase_migrations.schema_migrations(version,name,statements) values(${literal(v)},${literal(i ? 'processing_alerts' : 'processing_reliability_visibility')},array[${literal(bodies[i])}]);`,
        )
        .join('\n') +
      'commit;'
    await query(sql)
    console.log(
      JSON.stringify({ applied: versions, sha256: bodies.map(hash), alertsEnabled: false }),
    )
  } else if (mode === 'functions-approved') {
    phase = 'function preflight'
    if (!versions.every((v) => m.includes(v))) throw Error('Schema required')
    const functions = await api('functions')
    const secrets = await api('secrets')
    if (
      functions.some((f) => f.slug === 'processing-alerts') ||
      secrets.some((s) => s.name === 'PROCESSING_ALERT_SECRET')
    )
      throw Error('Existing alert function or secret; inspect partial release')
    if (!secrets.some((s) => s.name === 'RESEND_API_KEY')) throw Error('Resend secret unavailable')
    const vault = (
      await query("select count(*) as n from vault.secrets where name='kma_processing_alerts'")
    )[0].n
    if (Number(vault)) throw Error('Existing Vault alert secret')
    const credential = randomBytes(48).toString('hex')
    phase = 'dedicated credential'
    await api('secrets', [{ name: 'PROCESSING_ALERT_SECRET', value: credential }])
    await query(
      `select vault.create_secret(${literal(credential)},'kma_processing_alerts','Independent processing notification worker')`,
    )
    const afterSecrets = await api('secrets')
    const digest = (
      await query(
        "select encode(extensions.digest(decrypted_secret,'sha256'),'hex') as value from vault.decrypted_secrets where name='kma_processing_alerts'",
      )
    )[0].value
    if (
      digest !== hash(credential) ||
      afterSecrets.find((s) => s.name === 'PROCESSING_ALERT_SECRET')?.value !== hash(credential) ||
      secrets.some((s) => afterSecrets.find((x) => x.name === s.name)?.value !== s.value)
    )
      throw Error('Credential digest drift')
    for (const slug of ['processing-dispatch', 'processing-alerts']) {
      phase = `deploy ${slug}`
      execFileSync(
        './node_modules/.bin/supabase',
        [
          'functions',
          'deploy',
          slug,
          '--project-ref',
          project,
          '--no-verify-jwt',
          '--use-api',
        ],
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        },
      )
    }
    const afterFunctions = await api('functions')
    if (
      functions
        .filter((f) => f.slug !== 'processing-dispatch')
        .some((f) => afterFunctions.find((x) => x.slug === f.slug)?.version !== f.version)
    )
      throw Error('Unrelated function changed')
    const invoke = async (secret, body) => {
      const r = await fetch(`https://${project}.supabase.co/functions/v1/processing-alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-kma-alert-secret': secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      return { status: r.status, data: await r.json() }
    }
    const anonymous = await invoke('', {}),
      arbitrary = await invoke(credential, { to: recipient }),
      disabled = await invoke(credential, {})
    if (
      anonymous.status !== 401 ||
      arbitrary.status !== 400 ||
      disabled.status !== 200 ||
      disabled.data.accepted !== 0 ||
      disabled.data.claimed !== 0
    )
      throw Error('Alert boundary check failed')
    console.log(
      JSON.stringify({
        deployed: ['processing-dispatch', 'processing-alerts'],
        anonymous: anonymous.status,
        arbitrary: arbitrary.status,
        disabled: disabled.data,
        priorSecretsAndFunctionsPreserved: true,
      }),
    )
  } else if (mode === 'enable-approved') {
    phase = 'enable independent alert timer'
    if (!versions.every((v) => m.includes(v))) throw Error('Schema required')
    const functions = await api('functions')
    if (!functions.some((f) => f.slug === 'processing-alerts' && f.status === 'ACTIVE'))
      throw Error('Alert function required')
    await query(`begin;set local lock_timeout='3s';
      do $$ begin
        if exists(select 1 from cron.job where jobname='kma-processing-alerts' or command ilike '%dispatch_processing_alerts%') then raise exception 'Existing alert schedule'; end if;
        if not exists(select 1 from vault.secrets where name='kma_processing_alerts') then raise exception 'Credential required'; end if;
        update kma_internal.processing_alert_config set enabled=true,recipient_email=${literal(recipient)} where singleton and not enabled;
        if not found then raise exception 'Alert config drift'; end if;
        perform cron.schedule('kma-processing-alerts','* * * * *','select kma_internal.dispatch_processing_alerts();');
      end $$;commit;`)
    console.log(JSON.stringify({ enabled: true, recipient, independentCadence: 'every minute' }))
  } else if (mode === 'test-email-approved') {
    phase = 'enqueue one setup test'
    if (!versions.every((v) => m.includes(v))) throw Error('Schema required')
    await query(`insert into kma_internal.processing_alert_jobs(kind,recipient_email)
      select 'test',recipient_email from kma_internal.processing_alert_config where singleton and enabled and recipient_email=${literal(recipient)}
      on conflict(incident_id,kind) do nothing;`)
    console.log(
      JSON.stringify({ setupTestQueued: true, recipient, deliveryRequiresVerification: true }),
    )
  }
  const after = await fingerprints()
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      mode,
      financialAndWorkerDefinitionsUnchanged: unchanged,
      before,
      after,
    }),
  )
  if (!unchanged) throw Error('Application drift; inspect before further work')
} catch {
  console.error(
    `Stopped during ${phase}. Inspect live state before retrying. No raw errors or credentials are printed.`,
  )
  process.exitCode = 1
}
