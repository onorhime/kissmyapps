// Explicit narrow production release helper. Never reads/logs credentials.
// SQL fixtures are transaction-only; no provider calls or committed test facts.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const project = 'mmyruzjemjecqyivhrgr'
const file = '20260906110000_stripe_webhook_ownership.sql'
const version = file.split('_')[0]
const out = '.cache/release-backups/20260906-stripe-webhook-ownership'
const sql = readFileSync(`supabase/migrations/${file}`, 'utf8')
const digest = createHash('sha256').update(sql).digest('hex')
const query = (input) =>
  JSON.parse(
    execFileSync(
      'pnpm',
      [
        'exec',
        'supabase',
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
      {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
  ).rows
const literal = (value) => "'" + value.replaceAll("'", "''") + "'"
const state = () =>
  query(`select jsonb_build_object(
 'migrations',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
 'products',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.products t),
 'agreements',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.agreements t),
 'documents',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.documents t),
 'offers',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.billing_offers t),
 'links',(select count(*) from public.affiliate_links),'clicks',(select count(*) from public.clicks),
 'events',(select count(*) from public.events),'checkout',(select count(*) from public.checkout_attempts),
 'provider',(select count(*) from public.provider_events),'subscriptions',(select count(*) from public.subscriptions),
 'transactions',(select count(*) from public.transactions),'commissions',(select count(*) from public.commission_entries),
 'fixtures',(select count(*) from auth.users where id::text like '10000000-0000-4000-8000-0000000095%')) state`)[0]
    .state
const save = (name, value) => writeFileSync(`${out}/${name}.json`, JSON.stringify(value, null, 2))
let phase = 'read-only preflight'
try {
  mkdirSync(out, { recursive: true })
  const before = state()
  const mode = process.argv[2]
  if (mode === 'state') {
    console.log(JSON.stringify(before))
    process.exit(0)
  }
  if (before.fixtures !== 0 || before.migrations.includes(version))
    throw Error('Require unused namespace and unapplied migration')
  const prefix =
    "begin; set local lock_timeout='3s'; set local statement_timeout='25s'; select pg_advisory_xact_lock(hashtext('kma-webhook-release-20260906'));\n"
  const body = sql.replace(/(^|\n)begin;\s*/, '$1').replace(/commit;\s*$/, '')
  if (mode === 'test') {
    phase = 'rollback-only regression'
    // Keep the existing audit runner's empty-catalog gate. Reuse ONLY scoped
    // fixtures, stopping before its global email leases/deletion operations.
    const setup = readFileSync('supabase/tests/database/24_agreement_audit_regression.sql', 'utf8')
      .split("set local role service_role;\ninsert into audit_values values('jobs'")[0]
      .replace(/(^|\n)begin;\s*/, '$1')
    if (
      !setup.includes('signing requests target the one partner Owner') ||
      setup.includes('claim_agreement_email_jobs()')
    )
      throw Error('Fixture boundary changed')
    const funnel = readFileSync('supabase/tests/database/25_funnel_checkout_context.sql', 'utf8')
    const splitAt = funnel.indexOf('select public.finalize_checkout_attempt(')
    if (splitAt < 0) throw Error('Missing finalization boundary')
    const [pre, post] = readFileSync(
      'supabase/tests/database/29_stripe_webhook_ownership.sql',
      'utf8',
    ).split('-- AFTER_NORMALIZATION')
    const free = readFileSync('supabase/tests/database/26_zero_total_checkout.sql', 'utf8')
    const result = query(
      prefix +
        body +
        setup +
        funnel.slice(0, splitAt) +
        pre +
        '\n' +
        funnel.slice(splitAt) +
        free +
        post +
        '\nreset role; rollback;',
    )
    const after = state()
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error('State changed after rollback; inspect concurrency')
    save('database-test', { sha256: digest, before, after, result })
    console.log(
      JSON.stringify({
        rollbackComplete: true,
        applicationUnchanged: true,
        results: result.filter((r) => Object.keys(r).some((k) => k.startsWith('passed_'))),
      }),
    )
  } else if (mode === 'apply-approved') {
    phase = 'apply tested migration'
    const test = JSON.parse(readFileSync(`${out}/database-test.json`, 'utf8'))
    if (test.sha256 !== digest || JSON.stringify(test.after) !== JSON.stringify(before))
      throw Error('Regression/hash/state drift')
    query(
      prefix +
        body +
        `\ninsert into supabase_migrations.schema_migrations(version,name,statements) values(${literal(version)},'stripe_webhook_ownership',array[${literal(sql)}]);\ncommit;`,
    )
    const after = state()
    if (
      JSON.stringify(before) !== JSON.stringify({ ...after, migrations: before.migrations }) ||
      after.migrations.length !== before.migrations.length + 1 ||
      !after.migrations.includes(version)
    )
      throw Error('Post-release mismatch')
    save('database-release', {
      project,
      file,
      sha256: digest,
      releasedAt: new Date().toISOString(),
      before,
      after,
    })
    console.log(
      JSON.stringify({
        project,
        migration: file,
        sha256: digest,
        applicationUnchanged: true,
        migrations: after.migrations.length,
      }),
    )
  } else throw Error('Use state, test or apply-approved')
} catch (error) {
  console.error(`Stopped during ${phase}; inspect state before retrying.`)
  console.error(
    String(error.stderr || error.message)
      .replace(/(access_token|password|secret)\s*[:=]\s*\S+/gi, '[REDACTED]')
      .slice(0, 1800),
  )
  process.exitCode = 1
}
