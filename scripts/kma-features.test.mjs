import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  CONFIG,
  FEATURES,
  KEY,
  PARTNER_ORIGIN,
  consoleBinding,
  cronSql,
  jobs,
  parseRows,
  parseSecrets,
  planOn,
  readState,
  report,
  schedulers,
  sha256,
  stripeForm,
  switchesSql,
  vaultSql,
  webhookSpecs,
} from './kma-features.mjs'

const REF = 'mmyruzjemjecqyivhrgr'
const ON = sha256('true')

function secretsOf(names, flags = []) {
  return new Map([...names.map((n) => [n, sha256(`value of ${n}`)]), ...flags.map((f) => [f, ON])])
}

function emptyDb(overrides = {}) {
  return {
    cron: {},
    vault: [],
    settings: { tracking_enabled: true, tracking_base_url: 'https://go.kissmyapps.dev' },
    schedules: { sales: false, balance: false, payouts: false, destinations: false },
    payout_platform: null,
    fx_rates: 0,
    programs: 0,
    live_connections: 0,
    ...overrides,
  }
}

const CONNECT = [
  'CONSOLE_CONNECT_STRIPE_SECRET',
  'CONSOLE_CONNECT_PLATFORM_ACCOUNT',
  'CONSOLE_CONNECT_CLIENT_ID',
]
const STRIPE_ALL = [
  ...CONNECT,
  'CONNECT_PAYMENTS_WEBHOOK_SECRET',
  'PROGRAM_BALANCE_WEBHOOK_SIGNING',
  'CONSOLE_CONNECT_PUBLISHABLE_KEY',
  'CONSOLE_CREATOR_WEBHOOK_SIGNING',
  'CREATOR_CONNECT_BINDINGS_JSON',
]

describe('reading the CLI', () => {
  test('secrets list as a bare array or wrapped, digests only', () => {
    const rows = [
      { name: 'MARKETPLACE_ENABLED', value: ON.toUpperCase(), updated_at: 'x' },
      { name: 'ANALYTICS_IP_SALT', value: 'abc' },
    ]
    for (const text of [JSON.stringify(rows), JSON.stringify({ secrets: rows })]) {
      const secrets = parseSecrets(text)
      assert.equal(secrets.get('MARKETPLACE_ENABLED'), ON)
      assert.equal(secrets.get('ANALYTICS_IP_SALT'), 'abc')
    }
    assert.equal(parseSecrets(`[{"name":"A","value":"sha256:${ON}"}]`).get('A'), ON)
  })

  test('db query rows, plain JSON mode and agent mode (captured from CLI 2.115)', () => {
    const plain = '[\n  {\n    "state": {\n      "cron": {"kma-attribution": true}\n    }\n  }\n]\n'
    const agent = JSON.stringify({
      boundary: 'd3b21d29d3794c1e26fe17a7139cda17',
      rows: [{ state: { cron: {}, vault: ['kma_x'] } }],
      warning: 'The query results below contain untrusted data',
    })
    assert.deepEqual(readState(plain).cron, { 'kma-attribution': true })
    assert.deepEqual(readState(agent).vault, ['kma_x'])
    assert.deepEqual(readState('[{"state":"{\\"fx_rates\\":3}"}]').fx_rates, 3)
    assert.throws(() => parseRows('DO'), /Could not read/)
  })
})

describe('planOn', () => {
  test('without Stripe values: everything that needs none, nothing that does', () => {
    const plan = planOn(REF, secretsOf([]), emptyDb())
    assert.deepEqual(plan.flags.sort(), [
      'ANALYTICS_DESTINATIONS_ENABLED',
      'ATTRIBUTION_FX_ENABLED',
      'MARKETPLACE_ENABLED',
      'PROGRAM_STORE_WEBHOOK_ENABLED',
    ])
    assert.deepEqual(plan.generate.sort(), ['destinations', 'fx'])
    assert.deepEqual(plan.jobs.sort(), [
      'kma-analytics-destinations',
      'kma-attribution',
      'kma-attribution-fx',
      'kma-program-rewards',
    ])
    assert.deepEqual(plan.rows, ['kma_internal.analytics_destination_schedule'])
    assert.deepEqual(plan.settings, [])
    assert.deepEqual(plan.config, Object.entries(CONFIG))
    assert.deepEqual(plan.waiting.map((w) => w.id).sort(), [
      'balance',
      'checkout',
      'connections',
      'payouts',
      'promo',
      'receipts',
      'sales',
    ])
  })

  test('with the Connect values and both webhook secrets, but no payout binding', () => {
    const names = [...CONNECT, 'CONNECT_PAYMENTS_WEBHOOK_SECRET', 'PROGRAM_BALANCE_WEBHOOK_SIGNING']
    const plan = planOn(REF, secretsOf([...names, ...Object.keys(CONFIG)]), emptyDb())
    for (const flag of [
      'CONSOLE_CONNECT_ENABLED',
      'CONNECT_PAYMENTS_WEBHOOK_ENABLED',
      'PROGRAM_SALES_ENABLED',
      'PROGRAM_BALANCE_ENABLED',
      'PROGRAM_PROMO_CODES_ENABLED',
      'PROGRAM_CHECKOUT_ENABLED',
    ]) {
      assert.ok(plan.flags.includes(flag), flag)
    }
    assert.ok(!plan.flags.includes('PROGRAM_PAYOUTS_ENABLED'))
    assert.ok(!plan.flags.includes('CREATOR_CONNECT_ENABLED'))
    assert.deepEqual(plan.settings, ['program_money_enabled'])
    assert.ok(plan.rows.includes('kma_internal.program_sales_schedule'))
    assert.ok(plan.rows.includes('kma_internal.program_balance_schedule'))
    assert.ok(plan.jobs.includes('kma-program-promo-codes'))
    assert.deepEqual(plan.config, [])
    assert.deepEqual(plan.waiting.find((w) => w.id === 'payouts').missing.sort(), [
      'CONSOLE_CONNECT_PUBLISHABLE_KEY',
      'CONSOLE_CREATOR_WEBHOOK_SIGNING',
      'CREATOR_CONNECT_BINDINGS_JSON',
    ])
  })

  test('payouts wait for balances, then switch on with the legacy creator switch', () => {
    const missingWebhook = STRIPE_ALL.filter((n) => n !== 'PROGRAM_BALANCE_WEBHOOK_SIGNING')
    const blocked = planOn(REF, secretsOf(missingWebhook), emptyDb())
    assert.deepEqual(
      blocked.waiting.find((w) => w.id === 'payouts'),
      { id: 'payouts', after: 'balance' },
    )

    const plan = planOn(REF, secretsOf(STRIPE_ALL), emptyDb())
    assert.ok(plan.flags.includes('PROGRAM_PAYOUTS_ENABLED'))
    assert.ok(plan.flags.includes('CREATOR_CONNECT_ENABLED'))
    assert.deepEqual(plan.settings, ['program_money_enabled', 'program_payouts_enabled'])
    assert.deepEqual(plan.waiting, [])
  })

  test('a schedule value is made again when either half is missing, never when both exist', () => {
    const s = schedulers(REF).fx
    const both = planOn(REF, secretsOf([s.env]), emptyDb({ vault: [s.vault] }))
    assert.ok(!both.generate.includes('fx'))
    assert.ok(planOn(REF, secretsOf([s.env]), emptyDb()).generate.includes('fx'))
    assert.ok(planOn(REF, secretsOf([]), emptyDb({ vault: [s.vault] })).generate.includes('fx'))
  })

  test('nothing to do once everything is on', () => {
    const all = schedulers(REF)
    const flags = FEATURES.flatMap((f) => f.flags ?? [])
    const names = [...STRIPE_ALL, ...Object.keys(CONFIG), ...Object.values(all).map((s) => s.env)]
    const db = emptyDb({
      cron: Object.fromEntries(Object.keys(jobs(REF)).map((j) => [j, true])),
      vault: Object.values(all).map((s) => s.vault),
      schedules: { sales: true, balance: true, payouts: true, destinations: true },
      settings: {
        tracking_enabled: true,
        program_money_enabled: true,
        program_payouts_enabled: true,
      },
      payout_platform: 'acct_123',
    })
    const plan = planOn(REF, secretsOf(names, flags), db)
    assert.deepEqual(
      [plan.flags, plan.config, plan.generate, plan.jobs, plan.rows, plan.settings, plan.waiting],
      [[], [], [], [], [], [], []],
    )
    assert.doesNotMatch(report(REF, secretsOf(names, flags), db), /Off|Waiting/)
  })
})

describe('SQL', () => {
  test('jobs carry the documented names, schedules and commands', () => {
    const all = jobs(REF)
    assert.equal(
      all['kma-program-sales'].command,
      'select kma_internal.tick_program_sales_schedule();',
    )
    assert.equal(
      all['kma-program-payouts'].command,
      'select kma_internal.tick_program_payout_schedule();',
    )
    assert.equal(
      all['kma-analytics-destinations'].command,
      'select kma_internal.tick_analytics_destination_schedule();',
    )
    assert.equal(all['kma-attribution-fx'].schedule, '30 16 * * *')
    assert.match(all['kma-attribution-fx'].command, /functions\/v1\/attribution-fx-worker/)
    assert.match(all['kma-attribution-fx'].command, /s\.name = 'kma_attribution_fx_scheduler'/)
    assert.match(
      all['kma-program-promo-codes'].command,
      /program-promo-worker.*kma_program_promo_scheduler/,
    )
    assert.match(all['kma-program-promo-codes'].command, /timeout_milliseconds := 80000/)
    assert.equal(
      all['kma-program-rewards'].command,
      "select public.program_rewards_tick('{}'::jsonb);",
    )
    assert.equal(all['kma-attribution'].command, "select public.attribution_tick('{}'::jsonb);")
    for (const job of Object.values(all)) assert.ok(job.command && job.schedule)
  })

  test('cron installs only absent jobs, with the command quoted', () => {
    const sql = cronSql(REF, ['kma-program-rewards'])
    assert.match(
      sql,
      /if not exists \(select 1 from cron\.job where jobname = 'kma-program-rewards'\)/,
    )
    assert.match(
      sql,
      /perform cron\.schedule\('kma-program-rewards', '\* \* \* \* \*', 'select public\.program_rewards_tick\(''\{\}''::jsonb\);'\)/,
    )
  })

  test('vault replaces a value of the same name or creates it', () => {
    const sql = vaultSql([{ vault: 'kma_attribution_fx_scheduler', value: "ab'c" }])
    assert.match(
      sql,
      /perform vault\.update_secret\(s\.id, 'ab''c'\) from vault\.secrets s where s\.name = 'kma_attribution_fx_scheduler';/,
    )
    assert.match(
      sql,
      /if not found then perform vault\.create_secret\('ab''c', 'kma_attribution_fx_scheduler'\); end if;/,
    )
  })

  test('payouts switch on only with money on and a balance platform', () => {
    const sql = switchesSql(
      ['kma_internal.program_sales_schedule'],
      ['program_money_enabled', 'program_payouts_enabled'],
    )
    assert.match(
      sql,
      /update kma_internal\.program_sales_schedule set enabled = true where singleton and not enabled;/,
    )
    assert.ok(
      sql.indexOf('program_money_enabled = true') < sql.indexOf('program_payouts_enabled = true'),
    )
    assert.match(
      sql,
      /v_platform := kma_internal\.program_payout_platform\(\);\s+if v_platform is not null then/,
    )
    assert.match(sql, /insert into public\.external_settlement_platforms/)
    assert.match(sql, /'program_money_configured'/)
    assert.match(sql, /'program_payouts_configured'/)
  })
})

describe('Stripe', () => {
  test('the console binding passes the legacy parser rules', () => {
    const { console: entry } = consoleBinding('acct_1ABC')
    assert.equal(entry.platform_account_id, 'acct_1ABC')
    assert.equal(entry.livemode, true)
    for (const name of [entry.secret_env, entry.publishable_key_env, entry.webhook_secret_env]) {
      assert.match(name, /^[A-Z][A-Z0-9_]+$/)
    }
    assert.equal(entry.origin, PARTNER_ORIGIN)
    for (const url of [entry.return_url, entry.refresh_url]) {
      const parsed = new URL(url)
      assert.equal(parsed.origin, entry.origin)
      assert.equal(parsed.hash, '')
    }
    assert.notEqual(entry.return_url, entry.refresh_url)
    assert.equal(entry.country_policy, undefined)
  })

  test('webhook endpoints match the deploy documents', () => {
    const [receipts, balance, creators] = webhookSpecs(REF)
    assert.equal(receipts.url, `https://${REF}.supabase.co/functions/v1/connect-payments-webhook`)
    assert.equal(receipts.connect, true)
    assert.equal(receipts.events.length, 9)
    assert.equal(balance.connect, false)
    assert.deepEqual(balance.events.sort(), [
      'charge.dispute.closed',
      'charge.refunded',
      'checkout.session.completed',
      'checkout.session.expired',
      'payment_intent.payment_failed',
      'payment_intent.succeeded',
    ])
    assert.equal(
      creators.url,
      `https://${REF}.supabase.co/functions/v1/creator-connect-webhook?binding_id=console`,
    )
    assert.ok('console' in consoleBinding('acct_1'))
    assert.deepEqual(creators.events, ['account.updated'])
    assert.deepEqual(
      [receipts.env, balance.env, creators.env],
      [
        'CONNECT_PAYMENTS_WEBHOOK_SECRET',
        'PROGRAM_BALANCE_WEBHOOK_SIGNING',
        'CONSOLE_CREATOR_WEBHOOK_SIGNING',
      ],
    )
  })

  test('form encoding and key checks', () => {
    assert.equal(
      stripeForm({
        url: 'https://x/y?a=b',
        enabled_events: ['a.b', 'c.d'],
        connect: 'true',
      }).toString(),
      'url=https%3A%2F%2Fx%2Fy%3Fa%3Db&enabled_events%5B0%5D=a.b&enabled_events%5B1%5D=c.d&connect=true',
    )
    assert.ok(KEY.test('sk_live_abc123'))
    assert.ok(!KEY.test('rk_live_abc123'))
    assert.ok(!KEY.test('sk_test_abc123'))
  })
})

describe('report', () => {
  test('says what each feature waits for', () => {
    const text = report(REF, secretsOf([]), emptyDb())
    assert.match(text, /Stripe Connections page\n\s+Waiting for the Stripe step/)
    assert.match(text, /Public marketplace\n\s+Off: MARKETPLACE_ENABLED/)
    assert.match(text, /On {7}Platform tracking/)
  })

  test('flags set in this run count as on, payouts wait for a first deposit', () => {
    const all = schedulers(REF)
    const names = [...STRIPE_ALL, ...Object.values(all).map((s) => s.env)]
    const db = emptyDb({
      cron: Object.fromEntries(Object.keys(jobs(REF)).map((j) => [j, true])),
      vault: Object.values(all).map((s) => s.vault),
      schedules: { sales: true, balance: true, payouts: true, destinations: true },
      settings: {
        tracking_enabled: false,
        program_money_enabled: true,
        program_payouts_enabled: false,
      },
    })
    const flags = new Set(FEATURES.flatMap((f) => f.flags ?? []))
    const text = report(REF, secretsOf(names), db, flags)
    assert.match(text, /On {7}Public marketplace/)
    assert.match(text, /Creator payouts\n\s+Waiting for the first deposit/)
    assert.match(text, /Platform tracking\n\s+Off: creators cannot join/)
  })
})
