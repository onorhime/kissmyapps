#!/usr/bin/env node
// Switches on the KissMyApps features that went to production switched off, and says what
// each one still needs. It sets Edge Function flags, the schedules' values (in the function
// secrets and in Vault), the pg_cron jobs, the schedule rows and the program money switches,
// exactly as the deploy documents describe. A feature that needs a Stripe value stays off
// until that value is stored: switched on without it, its pages would only show errors.
// `stripe` asks for those values in the Terminal, creates the three Stripe webhook
// endpoints with the live key and stores everything in Supabase. See docs/RELEASING.md,
// "Switching features on".
//
//   node scripts/kma-features.mjs status
//   node scripts/kma-features.mjs on        # then offers the Stripe step if values are missing
//   node scripts/kma-features.mjs stripe

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { resolve4 } from 'node:dns/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'

import { loadConfig } from './kma-release.mjs'

export const STRIPE_API_VERSION = '2026-02-25.clover'
export const CONSOLE_ORIGIN = 'https://merchant.kissmyapps.dev'
export const PARTNER_ORIGIN = 'https://partners.kissmyapps.dev'

const CONNECT = [
  'CONSOLE_CONNECT_STRIPE_SECRET',
  'CONSOLE_CONNECT_PLATFORM_ACCOUNT',
  'CONSOLE_CONNECT_CLIENT_ID',
]

/** Values that are not secret and that the console needs even while Connect is off. */
export const CONFIG = {
  CONSOLE_CONNECT_ORIGIN: CONSOLE_ORIGIN,
  CONSOLE_CONNECT_CALLBACK_URL: `${CONSOLE_ORIGIN}/`,
}

function workerPost(ref, fn, vault, body, timeout) {
  return (
    `select net.http_post(url := 'https://${ref}.supabase.co/functions/v1/${fn}', ` +
    `body := '${body}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', ` +
    `'x-kma-scheduler-secret', s.decrypted_secret), timeout_milliseconds := ${timeout}) as request_id ` +
    `from vault.decrypted_secrets s where s.name = '${vault}' and length(s.decrypted_secret) >= 32`
  )
}

/** The schedules that call a worker with a value of their own (function secret = Vault). */
export function schedulers(ref) {
  return {
    sales: {
      env: 'PROGRAM_SALES_SCHEDULER_SECRET',
      vault: 'kma_program_sales_scheduler',
      job: 'kma-program-sales',
      row: 'kma_internal.program_sales_schedule',
      command: 'select kma_internal.tick_program_sales_schedule();',
    },
    balance: {
      env: 'PROGRAM_BALANCE_SCHEDULER_SECRET',
      vault: 'kma_program_balance_scheduler',
      job: 'kma-program-balance',
      row: 'kma_internal.program_balance_schedule',
      command: 'select kma_internal.tick_program_balance_schedule();',
    },
    payouts: {
      env: 'PROGRAM_PAYOUT_SCHEDULER_SECRET',
      vault: 'kma_program_payout_scheduler',
      job: 'kma-program-payouts',
      row: 'kma_internal.program_payout_schedule',
      command: 'select kma_internal.tick_program_payout_schedule();',
    },
    promo: {
      env: 'PROGRAM_PROMO_SCHEDULER_SECRET',
      vault: 'kma_program_promo_scheduler',
      job: 'kma-program-promo-codes',
      command: workerPost(ref, 'program-promo-worker', 'kma_program_promo_scheduler', '{}', 80000),
    },
    destinations: {
      env: 'ANALYTICS_DESTINATIONS_SCHEDULER_SECRET',
      vault: 'kma_analytics_destinations_scheduler',
      job: 'kma-analytics-destinations',
      row: 'kma_internal.analytics_destination_schedule',
      command: 'select kma_internal.tick_analytics_destination_schedule();',
    },
    fx: {
      env: 'ATTRIBUTION_FX_SCHEDULER_SECRET',
      vault: 'kma_attribution_fx_scheduler',
      job: 'kma-attribution-fx',
      schedule: '30 16 * * *',
      command: workerPost(
        ref,
        'attribution-fx-worker',
        'kma_attribution_fx_scheduler',
        '{}',
        60000,
      ),
    },
  }
}

/** pg_cron jobs: the documented name, schedule and command of each. */
export function jobs(ref) {
  const out = {
    'kma-program-rewards': {
      schedule: '* * * * *',
      command: `select public.program_rewards_tick('{}'::jsonb);`,
    },
    'kma-attribution': {
      schedule: '* * * * *',
      command: `select public.attribution_tick('{}'::jsonb);`,
    },
  }
  for (const s of Object.values(schedulers(ref))) {
    out[s.job] = {
      schedule: s.schedule ?? '* * * * *',
      command: s.command,
    }
  }
  return out
}

/**
 * Every feature this tool switches on. `needs`: function secrets that must already be stored
 * (Stripe values). `after`: a feature that must be on first.
 */
export const FEATURES = [
  { id: 'marketplace', name: 'Public marketplace', flags: ['MARKETPLACE_ENABLED'] },
  { id: 'attribution', name: 'App install matching (attribution)', jobs: ['kma-attribution'] },
  {
    id: 'fx',
    name: 'Attribution ROI exchange rates',
    flags: ['ATTRIBUTION_FX_ENABLED'],
    scheduler: 'fx',
  },
  {
    id: 'rewards',
    name: 'Event and app-install rewards',
    jobs: ['kma-program-rewards'],
    note: 'pays out only once program balances are on',
  },
  {
    id: 'store',
    name: 'RevenueCat and Adapty sales',
    flags: ['PROGRAM_STORE_WEBHOOK_ENABLED'],
  },
  {
    id: 'amplitude',
    name: 'Amplitude install export',
    flags: ['ANALYTICS_DESTINATIONS_ENABLED'],
    scheduler: 'destinations',
  },
  {
    id: 'connections',
    name: 'Stripe Connections page',
    flags: ['CONSOLE_CONNECT_ENABLED'],
    needs: CONNECT,
  },
  {
    id: 'receipts',
    name: 'Payment receipts from connected Stripe accounts',
    flags: ['CONNECT_PAYMENTS_WEBHOOK_ENABLED'],
    needs: [...CONNECT, 'CONNECT_PAYMENTS_WEBHOOK_SECRET'],
  },
  {
    id: 'sales',
    name: 'Sale tracking',
    flags: ['PROGRAM_SALES_ENABLED'],
    scheduler: 'sales',
    needs: CONNECT,
  },
  {
    id: 'balance',
    name: 'Program balances and commissions',
    flags: ['PROGRAM_BALANCE_ENABLED'],
    scheduler: 'balance',
    setting: 'program_money_enabled',
    needs: [...CONNECT, 'PROGRAM_BALANCE_WEBHOOK_SIGNING'],
  },
  {
    id: 'promo',
    name: 'Creator promo codes',
    flags: ['PROGRAM_PROMO_CODES_ENABLED'],
    scheduler: 'promo',
    needs: CONNECT,
  },
  {
    id: 'checkout',
    name: 'Checkout links',
    flags: ['PROGRAM_CHECKOUT_ENABLED'],
    needs: CONNECT,
  },
  {
    id: 'payouts',
    name: 'Creator payouts',
    flags: ['PROGRAM_PAYOUTS_ENABLED', 'CREATOR_CONNECT_ENABLED'],
    scheduler: 'payouts',
    setting: 'program_payouts_enabled',
    after: 'balance',
    needs: [
      ...CONNECT,
      'CONSOLE_CONNECT_PUBLISHABLE_KEY',
      'CONSOLE_CREATOR_WEBHOOK_SIGNING',
      'CREATOR_CONNECT_BINDINGS_JSON',
    ],
  },
]

const TRUE_DIGEST = sha256('true')

/** Secret digests as Supabase lists them: SHA-256 of the value, in hex. */
export function normalDigest(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/^sha256:/, '') : null
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** The first JSON value in CLI output (it can start with a status line). */
export function parseJson(text) {
  for (const opener of ['[', '{']) {
    let index = text.indexOf(opener)
    while (index >= 0) {
      try {
        return JSON.parse(text.slice(index).trim())
      } catch {
        index = text.indexOf(opener, index + 1)
      }
    }
  }
  return null
}

/** Rows of `--output-format json`: a bare array, or `rows` in agent mode. */
export function parseRows(text) {
  const value = parseJson(text)
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.rows)) return value.rows
  throw new Error('Could not read the database answer.')
}

/** `supabase secrets list -o json`: name to digest. Values are never seen. */
export function parseSecrets(text) {
  const value = parseJson(text)
  const rows = Array.isArray(value) ? value : (value?.secrets ?? [])
  return new Map(rows.filter((r) => r?.name).map((r) => [r.name, normalDigest(r.value)]))
}

export function flagOn(secrets, name) {
  return secrets.get(name) === TRUE_DIGEST
}

/** What `on` changes, worked out from the stored secret names and the database state. */
export function planOn(ref, secrets, db) {
  const all = schedulers(ref)
  const allJobs = jobs(ref)
  const plan = {
    flags: [],
    config: [],
    generate: [],
    jobs: [],
    rows: [],
    settings: [],
    waiting: [],
  }
  for (const [name, value] of Object.entries(CONFIG)) {
    if (!secrets.has(name)) plan.config.push([name, value])
  }
  const ready = new Set()
  for (const feature of FEATURES) {
    const missing = (feature.needs ?? []).filter((name) => !secrets.has(name))
    if (missing.length) {
      plan.waiting.push({ id: feature.id, missing })
      continue
    }
    if (feature.after && !ready.has(feature.after)) {
      plan.waiting.push({ id: feature.id, after: feature.after })
      continue
    }
    ready.add(feature.id)
    for (const flag of feature.flags ?? []) {
      if (!flagOn(secrets, flag)) plan.flags.push(flag)
    }
    for (const job of feature.jobs ?? []) {
      if (!(job in db.cron)) plan.jobs.push(job)
    }
    if (feature.scheduler) {
      const s = all[feature.scheduler]
      if (!secrets.has(s.env) || !db.vault.includes(s.vault)) plan.generate.push(feature.scheduler)
      if (!(s.job in db.cron)) plan.jobs.push(s.job)
      if (s.row && db.schedules[feature.scheduler] !== true) plan.rows.push(s.row)
    }
    if (feature.setting && db.settings[feature.setting] !== true)
      plan.settings.push(feature.setting)
  }
  for (const job of plan.jobs) if (!allJobs[job]) throw new Error(`No job named ${job}`)
  return plan
}

export function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Stores each schedule value in Vault, replacing one of the same name. */
export function vaultSql(entries) {
  const lines = entries.map(
    ({ vault, value }) =>
      `  perform vault.update_secret(s.id, ${literal(value)}) from vault.secrets s where s.name = ${literal(vault)};\n` +
      `  if not found then perform vault.create_secret(${literal(value)}, ${literal(vault)}); end if;`,
  )
  return `do $kma$\nbegin\n${lines.join('\n')}\nend\n$kma$;`
}

/** Installs each named pg_cron job that is not there yet. */
export function cronSql(ref, names) {
  const all = jobs(ref)
  const lines = names.map((name) => {
    const { schedule, command } = all[name]
    return (
      `  if not exists (select 1 from cron.job where jobname = ${literal(name)}) then\n` +
      `    perform cron.schedule(${literal(name)}, ${literal(schedule)}, ${literal(command)});\n` +
      `  end if;`
    )
  })
  return `do $kma$\nbegin\n${lines.join('\n')}\nend\n$kma$;`
}

const AUDIT = (action) =>
  `insert into public.audit_logs(actor_user_id, actor_type, action, target_table, before_data, after_data, metadata) ` +
  `values (null, 'system', '${action}', 'platform_settings', jsonb_build_object('enabled', false), ` +
  `jsonb_build_object('enabled', true), jsonb_build_object('via', 'scripts/kma-features.mjs'));`

/**
 * Enables schedule rows and the two program money switches, as the admin app's owner-only
 * switches do: program money first; payouts only once a program has a balance, registering
 * that platform as configure_admin_program_payouts does.
 */
export function switchesSql(rows, settings) {
  const lines = rows.map(
    (row) => `  update ${row} set enabled = true where singleton and not enabled;`,
  )
  if (settings.includes('program_money_enabled')) {
    lines.push(
      `  if exists (select 1 from public.platform_settings where singleton and not program_money_enabled) then`,
      `    update public.platform_settings set program_money_enabled = true where singleton;`,
      `    ${AUDIT('program_money_configured')}`,
      `  end if;`,
    )
  }
  if (settings.includes('program_payouts_enabled')) {
    lines.push(
      `  if exists (select 1 from public.platform_settings where singleton and program_money_enabled and not program_payouts_enabled) then`,
      `    v_platform := kma_internal.program_payout_platform();`,
      `    if v_platform is not null then`,
      `      insert into public.external_settlement_platforms(platform_account_id, livemode, enabled)`,
      `        values (v_platform, true, true) on conflict do nothing;`,
      `      update public.platform_settings set program_payouts_enabled = true where singleton;`,
      `      ${AUDIT('program_payouts_configured')}`,
      `    end if;`,
      `  end if;`,
    )
  }
  return `do $kma$\ndeclare v_platform text;\nbegin\n${lines.join('\n')}\nend\n$kma$;`
}

export const STATE_SQL = `select jsonb_build_object(
  'cron', coalesce((select jsonb_object_agg(jobname, active) from cron.job where jobname like 'kma-%'), '{}'::jsonb),
  'vault', coalesce((select jsonb_agg(name order by name) from vault.secrets where name like 'kma\\_%'), '[]'::jsonb),
  'settings', coalesce((select jsonb_build_object(
      'tracking_enabled', tracking_enabled, 'tracking_base_url', tracking_base_url,
      'program_money_enabled', program_money_enabled, 'program_payouts_enabled', program_payouts_enabled)
    from public.platform_settings where singleton), '{}'::jsonb),
  'schedules', jsonb_build_object(
    'sales', (select enabled from kma_internal.program_sales_schedule where singleton),
    'balance', (select enabled from kma_internal.program_balance_schedule where singleton),
    'payouts', (select enabled from kma_internal.program_payout_schedule where singleton),
    'destinations', (select enabled from kma_internal.analytics_destination_schedule where singleton)),
  'payout_platform', kma_internal.program_payout_platform(),
  'fx_rates', (select count(*) from public.attribution_fx_rates),
  'programs', (select count(*) from public.affiliate_programs),
  'live_connections', (select count(*) from public.merchant_connections where livemode and status = 'active')
) as state`

export function readState(text) {
  const [row] = parseRows(text)
  const state = typeof row?.state === 'string' ? JSON.parse(row.state) : row?.state
  if (!state || typeof state !== 'object') throw new Error('Could not read the database state.')
  return {
    cron: state.cron ?? {},
    vault: state.vault ?? [],
    settings: state.settings ?? {},
    schedules: state.schedules ?? {},
    payout_platform: state.payout_platform ?? null,
    fx_rates: Number(state.fx_rates ?? 0),
    programs: Number(state.programs ?? 0),
    live_connections: Number(state.live_connections ?? 0),
  }
}

/** One line per feature: on, partly on, or what it is waiting for. */
export function report(ref, secrets, db, justSet = new Set()) {
  const all = schedulers(ref)
  const lines = []
  const on = new Set()
  for (const feature of FEATURES) {
    const missing = (feature.needs ?? []).filter((name) => !secrets.has(name))
    const off = []
    for (const flag of feature.flags ?? [])
      if (!flagOn(secrets, flag) && !justSet.has(flag)) off.push(flag)
    for (const job of feature.jobs ?? []) if (!db.cron[job]) off.push(`job ${job}`)
    if (feature.scheduler) {
      const s = all[feature.scheduler]
      if (!secrets.has(s.env) || !db.vault.includes(s.vault)) off.push(s.env)
      if (!db.cron[s.job]) off.push(`job ${s.job}`)
      if (s.row && db.schedules[feature.scheduler] !== true) off.push('schedule row')
    }
    if (feature.setting && db.settings[feature.setting] !== true) off.push(feature.setting)
    let state
    if (!off.length) {
      state = 'On     '
      on.add(feature.id)
    } else if (missing.length) {
      const extra = missing.filter((name) => !CONNECT.includes(name))
      state = missing.some((name) => CONNECT.includes(name))
        ? 'Waiting for the Stripe step (node scripts/kma-features.mjs stripe)'
        : `Waiting for Stripe: ${extra.join(', ')}`
    } else if (feature.after && !on.has(feature.after)) {
      state = `Waiting for ${FEATURES.find((f) => f.id === feature.after).name.toLowerCase()}`
    } else if (
      feature.id === 'payouts' &&
      !db.payout_platform &&
      off.every((x) => x === feature.setting)
    ) {
      state = 'Waiting for the first deposit into a program balance (then run this again)'
    } else {
      state = `Off: ${off.join(', ')}`
    }
    lines.push(
      state.startsWith('On')
        ? `  On       ${feature.name}`
        : `  ${feature.name}\n           ${state}`,
    )
    if (state.startsWith('On') && feature.note) lines.push(`           (${feature.note})`)
  }
  const tracking = db.settings.tracking_enabled === true
  lines.push(
    tracking
      ? `  On       Platform tracking (${db.settings.tracking_base_url})`
      : `  Platform tracking\n           Off: creators cannot join programs until it is on (admin app, Settings, Tracking)`,
  )
  return lines.join('\n')
}

/** The console platform's entry for CREATOR_CONNECT_BINDINGS_JSON (names only, no values). */
export function consoleBinding(platformAccountId) {
  return {
    console: {
      platform_account_id: platformAccountId,
      livemode: true,
      secret_env: 'CONSOLE_CONNECT_STRIPE_SECRET',
      publishable_key_env: 'CONSOLE_CONNECT_PUBLISHABLE_KEY',
      webhook_secret_env: 'CONSOLE_CREATOR_WEBHOOK_SIGNING',
      origin: PARTNER_ORIGIN,
      return_url: `${PARTNER_ORIGIN}/?connect=return`,
      refresh_url: `${PARTNER_ORIGIN}/?connect=refresh`,
    },
  }
}

/** The three Stripe webhook endpoints the money features listen on. */
export function webhookSpecs(ref) {
  const base = `https://${ref}.supabase.co/functions/v1`
  return [
    {
      env: 'CONNECT_PAYMENTS_WEBHOOK_SECRET',
      url: `${base}/connect-payments-webhook`,
      connect: true,
      description: 'KissMyApps: payments on connected merchant accounts',
      events: [
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'payment_intent.succeeded',
        'invoice.paid',
        'charge.refunded',
        'refund.created',
        'refund.updated',
        'charge.dispute.created',
        'charge.dispute.closed',
      ],
    },
    {
      env: 'PROGRAM_BALANCE_WEBHOOK_SIGNING',
      url: `${base}/program-balance-webhook`,
      connect: false,
      description: 'KissMyApps: program balance top-ups',
      events: [
        'checkout.session.completed',
        'checkout.session.expired',
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'charge.refunded',
        'charge.dispute.closed',
      ],
    },
    {
      env: 'CONSOLE_CREATOR_WEBHOOK_SIGNING',
      url: `${base}/creator-connect-webhook?binding_id=console`,
      connect: true,
      description: 'KissMyApps: creator payout accounts',
      events: ['account.updated'],
    },
  ]
}

/** Form fields for Stripe's API (arrays as name[0], name[1], ...). */
export function stripeForm(params) {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((item, i) => form.append(`${key}[${i}]`, item))
    else form.append(key, String(value))
  }
  return form
}

export const KEY = /^sk_live_[A-Za-z0-9]+$/
export const CLIENT_ID = /^ca_[A-Za-z0-9]{3,128}$/
export const PUBLISHABLE = /^pk_live_[A-Za-z0-9]+$/
export const SIGNING = /^whsec_[A-Za-z0-9]+$/

// ---------------------------------------------------------------------------------------------
// Talking to Supabase, Stripe and the person at the Terminal.

function makeContext(repo, config) {
  const ref = config.supabase.projectRef
  const bin = process.env.SUPABASE_BIN ?? join(repo, 'node_modules', '.bin', 'supabase')
  const supabase = (args) => {
    const result = spawnSync(bin, args, {
      cwd: repo,
      env: { ...process.env, SUPABASE_PROFILE: process.env.SUPABASE_PROFILE || 'supabase' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
        .trim()
        .split('\n')
        .filter(Boolean)
      throw new Error(detail.slice(-2).join(' ') || `supabase ${args[0]} exited ${result.status}`)
    }
    return result.stdout
  }
  /** Runs one statement; secret-bearing SQL goes through a private file, never the command line. */
  const query = (sql, { private: hidden = false } = {}) => {
    const base = ['db', 'query', '--linked', '--agent', 'no', '--output-format', 'json']
    if (!hidden) return supabase([...base, sql])
    return withPrivateFile(sql, (file) => supabase([...base, '--file', file]))
  }
  const secrets = () =>
    parseSecrets(supabase(['secrets', 'list', '--project-ref', ref, '-o', 'json']))
  /** Stores values: secret ones through a private env file, the rest as arguments. */
  const setSecrets = (values, { private: hidden = false } = {}) => {
    const entries = Object.entries(values)
    if (!entries.length) return
    for (const [name, value] of entries) {
      if (!/^[A-Z][A-Z0-9_]+$/.test(name) || /[\r\n]/.test(value))
        throw new Error(`Refusing to store ${name}`)
    }
    if (hidden) {
      for (const [name, value] of entries) {
        if (!/^[A-Za-z0-9_]+$/.test(value))
          throw new Error(`Refusing to store ${name}: unexpected characters`)
      }
      const text = entries.map(([name, value]) => `${name}=${value}`).join('\n') + '\n'
      withPrivateFile(text, (file) =>
        supabase(['secrets', 'set', '--project-ref', ref, '--env-file', file]),
      )
    } else {
      supabase(['secrets', 'set', '--project-ref', ref, ...entries.map(([n, v]) => `${n}=${v}`)])
    }
  }
  return { repo, config, ref, supabase, query, secrets, setSecrets }
}

function withPrivateFile(text, run) {
  const dir = mkdtempSync(join(tmpdir(), 'kma-features-'))
  const file = join(dir, 'input')
  try {
    writeFileSync(file, text, { mode: 0o600 })
    return run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function stripeApi(key, method, path, params) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_API_VERSION,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? stripeForm(params) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      `Stripe answered ${response.status} to ${method} /v1/${path.split('?')[0]}: ${json?.error?.message ?? 'no message'}`,
    )
  }
  return json
}

async function askLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** Reads a line without showing it. */
function askHidden(question) {
  const { stdin, stdout } = process
  if (!stdin.isTTY) return Promise.reject(new Error('This step needs a Terminal to type into.'))
  stdout.write(question)
  return new Promise((resolveValue, reject) => {
    let value = ''
    const finish = (error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
      if (error) reject(error)
      else resolveValue(value.replace(/\x1b\[20[01]~/g, '').trim())
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003') return finish(new Error('Stopped.'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function yes(question) {
  return /^y(es)?$/i.test(await askLine(`${question} [y/N] `))
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function gather(ctx) {
  return { secrets: ctx.secrets(), db: readState(ctx.query(STATE_SQL)) }
}

async function checks(ctx) {
  const base = `https://${ctx.ref}.supabase.co/functions/v1`
  const code = async (url, init) => {
    try {
      const r = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        ...init,
      })
      return r.status
    } catch (error) {
      return `no answer (${error.cause?.code ?? error.name})`
    }
  }
  const vps = ctx.config.vps.ssh.split('@').pop()
  let apex = []
  try {
    apex = await resolve4('kissmyapps.dev')
  } catch {
    // reported below as not resolving
  }
  const fn = await code(`${base}/marketplace`)
  const partners = await code(`${PARTNER_ORIGIN}/marketplace`)
  const main = await code('https://kissmyapps.dev/marketplace')
  console.log('\nChecks')
  console.log(`  marketplace function                 ${fn} (200 when on)`)
  console.log(`  partners.kissmyapps.dev/marketplace  ${partners}`)
  console.log(`  kissmyapps.dev/marketplace           ${main}`)
  if (!apex.includes(vps)) {
    console.log(
      `  kissmyapps.dev points at ${apex.join(', ') || 'nothing'}, not the VPS (${vps}): invite links\n` +
        `  (kissmyapps.dev/marketplace/...) and checkout links (kissmyapps.dev/checkout/...) do not\n` +
        `  open until the main domain is routed there.` +
        (partners === 200 ? ` The marketplace opens at ${PARTNER_ORIGIN}/marketplace.` : ''),
    )
  }
}

async function loadRates(ctx) {
  const sql = workerPost(
    ctx.ref,
    'attribution-fx-worker',
    'kma_attribution_fx_scheduler',
    '{"range":"all"}',
    120000,
  )
  const [row] = parseRows(ctx.query(sql))
  const id = Number(row?.request_id)
  if (!Number.isInteger(id))
    return console.log(
      '  Exchange rates: the full history load could not be started; the daily run fills the last 90 days.',
    )
  for (let i = 0; i < 30; i += 1) {
    await wait(5000)
    const [answer] = parseRows(
      ctx.query(
        `select status_code, left(content, 200) as content, error_msg from net._http_response where id = ${id}`,
      ),
    )
    if (answer) {
      const off = /"enabled"\s*:\s*false/.test(answer.content ?? '')
      const ok = answer.status_code === 200 && !off
      const why = off
        ? 'the worker had not seen the new switch yet'
        : (answer.status_code ?? answer.error_msg)
      console.log(
        ok
          ? `  Exchange rates: full history loaded${answer.content ? `: ${answer.content}` : ''}`
          : `  Exchange rates: full history not loaded (${why}). Run this again to retry; the daily run fills the last 90 days.`,
      )
      return
    }
  }
  console.log(
    '  Exchange rates: the history load is still running; the daily run at 16:30 UTC also fills them.',
  )
}

async function on(ctx, { offerStripe = true } = {}) {
  const { secrets, db } = gather(ctx)
  const plan = planOn(ctx.ref, secrets, db)
  const all = schedulers(ctx.ref)
  const generated = Object.fromEntries(
    plan.generate.map((key) => [key, randomBytes(32).toString('hex')]),
  )

  console.log('Switching on')
  if (plan.generate.length) {
    ctx.setSecrets(Object.fromEntries(plan.generate.map((k) => [all[k].env, generated[k]])), {
      private: true,
    })
    ctx.query(vaultSql(plan.generate.map((k) => ({ vault: all[k].vault, value: generated[k] }))), {
      private: true,
    })
    console.log(`  schedule values stored: ${plan.generate.map((k) => all[k].env).join(', ')}`)
  }
  const plain = Object.fromEntries([...plan.config, ...plan.flags.map((f) => [f, 'true'])])
  if (Object.keys(plain).length) {
    ctx.setSecrets(plain)
    console.log(`  set: ${Object.keys(plain).join(', ')}`)
  }
  if (plan.jobs.length) {
    ctx.query(cronSql(ctx.ref, plan.jobs))
    console.log(`  schedules installed: ${plan.jobs.join(', ')}`)
  }
  if (plan.rows.length || plan.settings.length) {
    ctx.query(switchesSql(plan.rows, plan.settings))
    console.log(`  switched on: ${[...plan.rows, ...plan.settings].join(', ')}`)
  }
  if (
    !plan.generate.length &&
    !Object.keys(plain).length &&
    !plan.jobs.length &&
    !plan.rows.length &&
    !plan.settings.length
  ) {
    console.log('  nothing to change')
  }
  const fxOn = !plan.waiting.some((w) => w.id === 'fx')
  if (fxOn && db.fx_rates === 0) {
    if (plan.flags.includes('ATTRIBUTION_FX_ENABLED')) await wait(20000)
    await loadRates(ctx)
  }

  const after = gather(ctx)
  console.log(`\nFeatures\n${report(ctx.ref, after.secrets, after.db, new Set(plan.flags))}`)
  await checks(ctx)

  const stripeMissing = CONNECT.some((name) => !after.secrets.has(name))
  if (stripeMissing && offerStripe && process.stdin.isTTY) {
    console.log('\nThe money features need your live Stripe values. This takes about five minutes.')
    if (await yes('Set up Stripe now?')) {
      await stripe(ctx)
      return
    }
    console.log('Run `node scripts/kma-features.mjs stripe` when you have them.')
  }
}

async function stripe(ctx) {
  const stored = ctx.secrets()
  console.log(`
Stripe, live mode. First, in the Stripe dashboard of the KissMyApps account:
  1. Settings > Connect > Onboarding options > OAuth: turn on OAuth for Standard accounts,
     add this redirect URI exactly:  ${CONSOLE_ORIGIN}/
     and copy the live client ID shown on that page (it starts with ca_).
  2. Developers > API keys: the live secret key (sk_live_..., not a restricted rk_ key)
     and the publishable key (pk_live_...).
The secret key is not shown while you paste it and is stored only in Supabase.
`)
  const key = await askHidden('Live secret key (sk_live_...): ')
  if (!KEY.test(key))
    throw new Error(
      'That is not a live secret key (sk_live_ followed by letters and digits). Nothing was changed.',
    )
  const account = await stripeApi(key, 'GET', 'account')
  const name =
    account.settings?.dashboard?.display_name || account.business_profile?.name || '(no name)'
  console.log(
    `Stripe account: ${name}, ${account.id}, ${account.country ?? '?'}, ${account.default_currency ?? '?'}`,
  )
  if (
    stored.has('CONSOLE_CONNECT_PLATFORM_ACCOUNT') &&
    stored.get('CONSOLE_CONNECT_PLATFORM_ACCOUNT') !== sha256(account.id)
  ) {
    console.log('Supabase already names a platform account that may be a different one.')
    if (!(await yes(`Use ${account.id} from now on?`)))
      throw new Error('Stopped. Nothing was changed.')
  } else if (!(await yes('Is this the KissMyApps platform account?'))) {
    throw new Error('Stopped. Nothing was changed.')
  }

  const values = {
    CONSOLE_CONNECT_STRIPE_SECRET: key,
    CONSOLE_CONNECT_PLATFORM_ACCOUNT: account.id,
  }
  const keep = (n) => (stored.has(n) ? ' (Enter keeps the stored one)' : '')
  const clientId = await askLine(`Connect client ID (ca_...)${keep('CONSOLE_CONNECT_CLIENT_ID')}: `)
  if (clientId) {
    if (!CLIENT_ID.test(clientId))
      throw new Error('That is not a client ID (ca_...). Nothing was changed.')
    values.CONSOLE_CONNECT_CLIENT_ID = clientId
  } else if (!stored.has('CONSOLE_CONNECT_CLIENT_ID'))
    throw new Error('The client ID is needed. Nothing was changed.')
  const publishable = await askLine(
    `Publishable key (pk_live_...)${keep('CONSOLE_CONNECT_PUBLISHABLE_KEY')}: `,
  )
  if (publishable) {
    if (!PUBLISHABLE.test(publishable))
      throw new Error('That is not a live publishable key (pk_live_...). Nothing was changed.')
    values.CONSOLE_CONNECT_PUBLISHABLE_KEY = publishable
  }

  console.log('\nWebhook endpoints')
  const existing = (await stripeApi(key, 'GET', 'webhook_endpoints?limit=100')).data ?? []
  for (const spec of webhookSpecs(ctx.ref)) {
    const found = existing.find((e) => e.url === spec.url)
    if (found && stored.has(spec.env)) {
      const events = [...new Set([...(found.enabled_events ?? []), ...spec.events])]
      const needsEvents =
        !(found.enabled_events ?? []).includes('*') &&
        events.length !== (found.enabled_events ?? []).length
      if (needsEvents || found.status === 'disabled') {
        await stripeApi(key, 'POST', `webhook_endpoints/${found.id}`, {
          enabled_events: events,
          disabled: false,
        })
        console.log(`  updated  ${spec.url}`)
      } else console.log(`  kept     ${spec.url}`)
      continue
    }
    if (found) {
      const pasted = await askHidden(
        `  ${spec.url} exists in Stripe but its signing secret is not in Supabase.\n` +
          `  Paste its signing secret (whsec_...), or press Enter to replace it with a new endpoint: `,
      )
      if (pasted) {
        if (!SIGNING.test(pasted))
          throw new Error(
            'That is not a signing secret (whsec_...). Nothing was changed in Supabase.',
          )
        values[spec.env] = pasted
        continue
      }
      await stripeApi(key, 'DELETE', `webhook_endpoints/${found.id}`)
    }
    const made = await stripeApi(key, 'POST', 'webhook_endpoints', {
      url: spec.url,
      enabled_events: spec.events,
      api_version: STRIPE_API_VERSION,
      description: spec.description,
      ...(spec.connect ? { connect: 'true' } : {}),
    })
    if (!SIGNING.test(made.secret ?? ''))
      throw new Error(`Stripe did not return a signing secret for ${spec.url}`)
    values[spec.env] = made.secret
    console.log(`  created  ${spec.url}`)
  }
  const legacy = existing.filter((e) => e.url.includes('/functions/v1/merchant-connect-webhook'))
  const legacyOk = legacy.some((e) =>
    ['account.updated', 'account.application.deauthorized'].every(
      (ev) => e.enabled_events?.includes(ev) || e.enabled_events?.includes('*'),
    ),
  )
  if (!legacyOk) {
    console.log(
      '  Note: no merchant-connect-webhook endpoint here listens to account.updated and\n' +
        '  account.application.deauthorized. Connections still work; the console just will not\n' +
        "  notice changes a merchant makes on Stripe's side until they reconnect.",
    )
  }

  const plain = {}
  if (!stored.has('CREATOR_CONNECT_BINDINGS_JSON')) {
    plain.CREATOR_CONNECT_BINDINGS_JSON = JSON.stringify(consoleBinding(account.id))
  } else if (
    stored.get('CREATOR_CONNECT_BINDINGS_JSON') !==
    sha256(JSON.stringify(consoleBinding(account.id)))
  ) {
    console.log(
      '\nCREATOR_CONNECT_BINDINGS_JSON already holds a value this tool did not write, so it was\n' +
        'left alone. Creator payouts need it to contain this entry (see\n' +
        'docs/affiliate-self-serve-phase4-payouts.md, "The console binding"):\n' +
        JSON.stringify(consoleBinding(account.id)),
    )
  }
  ctx.setSecrets(values, { private: true })
  ctx.setSecrets(plain)
  console.log(
    `\nStored in Supabase: ${[...Object.keys(values), ...Object.keys(plain)].join(', ')}\n`,
  )
  await on(ctx, { offerStripe: false })
}

async function main() {
  const command = process.argv[2] ?? 'help'
  const repo = resolve(import.meta.dirname, '..')
  const config = loadConfig(resolve(repo, 'deploy/release.config.json'))
  const ctx = makeContext(repo, config)
  if (command === 'status') {
    const { secrets, db } = gather(ctx)
    console.log(`Features\n${report(ctx.ref, secrets, db)}`)
    await checks(ctx)
  } else if (command === 'on') {
    await on(ctx)
  } else if (command === 'stripe') {
    await stripe(ctx)
  } else {
    console.log('Usage: node scripts/kma-features.mjs status | on | stripe')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
