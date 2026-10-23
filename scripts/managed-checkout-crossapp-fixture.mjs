/** Local-only database fixture for KMA -> SpeakSix payment acceptance.
 * Builds two fresh databases. Never reads .env, contacts a provider, or uses an
 * existing app/database. The returned rpc ports execute the real SQL functions.
 */
import { execFile as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
const exec = promisify(execCallback)
export const kmaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const speaksixRoot = resolve(kmaRoot, '../Bclearn-Pilot')
const pg = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin'].find((p) =>
  existsSync(join(p, 'initdb')),
)
if (!pg) throw Error('Native PostgreSQL 17 is required for this isolated acceptance test.')
export const fixtureIds = Object.freeze({
  product: 'ac570000-0000-4000-8000-000000000001',
  funnel: 'ac570000-0000-4000-8000-000000000002',
  creator: 'ac570000-0000-4000-8000-000000000003',
  click: 'opaque_fixture_click_123456',
  price: 'price_ManagedCrossappFixture',
  account: 'acct_fixture',
  offer: 'marathon',
})
export const literal = (value) =>
  value === null
    ? 'null'
    : typeof value === 'boolean' || typeof value === 'number'
      ? String(value)
      : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`
const identifier = (value) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid fixture identifier')
  return `"${value}"`
}
async function expandIncludes(file) {
  const source = await readFile(file, 'utf8')
  const rows = []
  for (const row of source.split('\n')) {
    const m = row.match(/^\\i(r)?\s+(.+)$/)
    rows.push(m ? await expandIncludes(resolve(m[1] ? dirname(file) : kmaRoot, m[2])) : row)
  }
  return rows.join('\n')
}
export async function createCrossAppFixture(options = {}) {
  const ids = {
    ...fixtureIds,
    account: options.accountId ?? fixtureIds.account,
    price: options.priceId ?? fixtureIds.price,
  }
  if (!/^acct_[A-Za-z0-9]+$/.test(ids.account) || !/^price_[A-Za-z0-9_]{8,128}$/.test(ids.price))
    throw Error('Invalid test fixture merchant/Price identity')
  const directory = await mkdtemp('/tmp/kma-managed-crossapp.')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('PG') && !/SUPABASE|STRIPE|RESEND|OPENAI|ZOOM|KMA|MARATHON/.test(key),
    ),
  )
  const log = join(directory, 'database.log')
  let started = false
  const command = (tool, args, extra = {}) =>
    exec(join(pg, tool), args, { cwd: kmaRoot, env, maxBuffer: 32 * 1024 * 1024, ...extra })
  async function sql(database, statement) {
    if (!['kma', 'speaksix'].includes(database)) throw Error('Unknown local fixture database')
    const file = join(directory, `${database}-${crypto.randomUUID()}.sql`)
    await writeFile(file, statement, { mode: 0o600 })
    try {
      const result = await command('psql', [
        '-h',
        directory,
        '-d',
        database,
        '-XAtq',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=verbose',
        '-f',
        file,
      ])
      if (!options.privateStatements) await writeFile(log, result.stderr, { flag: 'a' })
      return result.stdout.trim()
    } catch (error) {
      if (options.privateStatements) {
        const code = (error.stderr || '').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1] ?? 'XX000'
        throw Error(
          `${database} local SQL failed: ERROR: ${code}: details withheld for private rehearsal`,
        )
      }
      await writeFile(log, `${file}\n${error.stdout || ''}\n${error.stderr || ''}`, { flag: 'a' })
      throw Error(`${database} fixture SQL failed: ${error.stderr || error.message}`, {
        cause: error,
      })
    } finally {
      if (options.privateStatements) await unlink(file).catch(() => {})
    }
  }
  const rpcDefinitions = new Map()
  async function rpc(database, name, args = {}, fixtureAdmin = false) {
    try {
      identifier(name)
      const key = database + ':' + name
      if (!rpcDefinitions.has(key)) {
        const raw = await sql(
          database,
          `select jsonb_build_object('types',coalesce(jsonb_object_agg(a.name,format_type(a.type,null)) filter(where a.type is not null),'{}'::jsonb),'set',p.proretset) from pg_proc p join pg_namespace n on n.oid=p.pronamespace left join lateral unnest(p.proargnames,p.proargtypes::oid[]) a(name,type) on true where n.nspname='public' and p.proname=${literal(name)} group by p.oid`,
        )
        if (!raw) throw Error(`Unknown RPC ${name}`)
        rpcDefinitions.set(key, JSON.parse(raw))
      }
      const definition = rpcDefinitions.get(key),
        pairs = Object.entries(args).map(([key, value]) => {
          if (!definition.types[key]) throw Error(`Unknown ${name} parameter ${key}`)
          const type = definition.types[key]
          const encoded =
            type.endsWith('[]') && Array.isArray(value)
              ? `array[${value.map(literal).join(',')}]`
              : literal(value)
          return `${identifier(key)}=>${encoded}::${type}`
        })
      const call = `public.${identifier(name)}(${pairs.join(',')})`,
        query = definition.set
          ? `select coalesce(jsonb_agg(to_jsonb(r)),'[]') from ${call} r`
          : `select coalesce(to_jsonb(${call}),'null'::jsonb)`
      const raw = await sql(
        database,
        `begin;set local role ${fixtureAdmin ? 'authenticated' : 'service_role'};do $$begin perform set_config('request.jwt.claims',${literal(fixtureAdmin ? { sub: 'ac570000-0000-4000-8000-000000000011', role: 'authenticated', amr: [{ method: 'password' }] } : { role: 'service_role' })},true);perform set_config('request.jwt.claim.role','${fixtureAdmin ? 'authenticated' : 'service_role'}',true);end $$;${query};commit;`,
      )
      return { data: JSON.parse(raw.split('\n').at(-1) || 'null'), error: null }
    } catch (error) {
      await writeFile(log, `RPC ${name}: ${error.stack}\n`, { flag: 'a' })
      const code = error.message.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]
      return { data: null, error: { code: code || 'XX000', message: error.message } }
    }
  }
  async function stop() {
    if (started) {
      started = false
      await command('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', 'stop'])
    }
  }
  try {
    await command('initdb', ['-D', join(directory, 'data'), '-A', 'trust'])
    await command('pg_ctl', [
      '-D',
      join(directory, 'data'),
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-k ${directory} -c listen_addresses=''`,
      'start',
    ])
    started = true
    for (const db of ['kma', 'speaksix']) await command('createdb', ['-h', directory, db])
    await sql(
      'kma',
      (await readFile(
        join(kmaRoot, 'supabase/tests/bootstrap/external-commerce-native.sql'),
        'utf8',
      )) +
        `\nalter table auth.users add column created_at timestamptz default now(),add column updated_at timestamptz default now(),add column last_sign_in_at timestamptz;grant usage on schema storage,extensions to anon,authenticated,service_role;grant all on storage.objects to authenticated,service_role;alter table storage.objects enable row level security;`,
    )
    await sql(
      'speaksix',
      (await readFile(join(speaksixRoot, 'scripts/ci/postgres-bootstrap.sql'), 'utf8')).replace(
        /^create role .+;\s*$/gm,
        '',
      ),
    )
    const migrations = {}
    for (const [db, root] of [
      ['kma', kmaRoot],
      ['speaksix', speaksixRoot],
    ]) {
      const names = (await readdir(join(root, 'supabase/migrations')))
        .filter((n) => n.endsWith('.sql'))
        .sort()
      migrations[db] = names.length
      for (const name of names) {
        let source = await readFile(join(root, 'supabase/migrations', name), 'utf8')
        if (db === 'kma')
          source = source.replace(
            /^create extension if not exists pg_net with schema extensions;\s*$/m,
            '',
          )
        await sql(db, source)
      }
    }
    // Seed the existing signed policy through its actual signing/configuration RPCs.
    // 25% is a synthetic existing agreement, not a new production commission default.
    await sql(
      'kma',
      `begin;select set_config('qa.policy.cutoff','30',true);${options.merchantDirect ? "select set_config('qa.funding','acct_platformFixture',true);" : ''}\n${(await expandIncludes(join(kmaRoot, 'supabase/tests/fixtures/external-canonical.sql'))).replaceAll("'acct_fixture'", literal(ids.account))}\n${options.merchantDirect ? await expandIncludes(join(kmaRoot, 'supabase/tests/fixtures/merchant-connection-crossapp.sql')) : ''}\nreset role;commit;`,
    )
    await sql(
      'kma',
      `insert into public.managed_payment_products(product_id,enabled) values(${literal(fixtureIds.product)},true);insert into public.billing_offers(product_id,key,name,billing_mode,stripe_price_id,currency,unit_amount_minor,success_url_template,cancel_url,status,verified_stripe_price_id,verified_currency,verified_unit_amount_minor,verified_billing_mode,stripe_livemode_verified_at) values(${literal(fixtureIds.product)},'marathon','Synthetic managed Marathon','payment',${literal(ids.price)},'USD',16900,'https://marathon.speaksix.com/complete?session_id={CHECKOUT_SESSION_ID}','https://marathon.speaksix.com/enrollment',${literal(options.unverifiedManagedOffer ? 'draft' : 'active')},null,null,null,null,null);`,
    )
    if (!options.unverifiedManagedOffer)
      await sql(
        'kma',
        `insert into public.managed_payment_offer_prices(offer_id,account_id,livemode,stripe_price_id,currency,unit_amount_minor,offer_version,configured_price_id) select id,${literal(ids.account)},false,${literal(ids.price)},currency,unit_amount_minor,version,stripe_price_id from public.billing_offers where product_id=${literal(fixtureIds.product)} and key='marathon'`,
      )
    // Use the same matching/calendar/teaching-plan prerequisites as financial SQL
    // regression, stopping before any capture. No entitlement is seeded directly.
    let seed = await readFile(
      join(speaksixRoot, 'supabase/tests/marathon_checkout_attempts.sql'),
      'utf8',
    )
    seed = seed.split('reset role;\nupdate public.lesson_programs set revision=revision+1')[0]
    const plan = await expandIncludes(
      join(speaksixRoot, 'supabase/tests/fixtures/marathon-checkout-plan.sql'),
    )
    seed = seed
      .replace('\\ir fixtures/marathon-checkout-plan.sql', () => plan)
      .replaceAll('17900', '16900')
      .replace("'fixture-click-'||i", "'opaque_fixture_click_123456'")
    await sql('speaksix', seed + '\nreset role;commit;')
    const orders = JSON.parse(
      await sql(
        'speaksix',
        `select jsonb_agg(jsonb_build_object('id',o.id,'userId',r.user_id) order by r.user_id) from public.marathon_orders o join public.webinar_registrations r on r.id=o.registration_id`,
      ),
    )
    return {
      directory,
      ids,
      log,
      migrations,
      sql,
      rpc,
      stop,
      orders,
      client: (database) => ({ rpc: (name, args) => rpc(database, name, args) }),
    }
  } catch (error) {
    await stop()
    throw error
  }
}
