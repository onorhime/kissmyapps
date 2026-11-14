import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  applyRelease,
  buildPlan,
  checkEdge,
  checkMigrationList,
  composeImages,
  dashboardScript,
  formatPlan,
  functionGroups,
  gatherSupabase,
  localFunctions,
  localMigrations,
  localVpsFiles,
  packRelease,
  parseArgs,
  parseCaddyBlocks,
  parseFunctionList,
  parseMigrationList,
  parseSecretNames,
  parseStatus,
  recordScript,
  releaseId,
  rollbackScript,
  servicesScript,
  smokeTest,
  statusScript,
  unpackScript,
} from './kma-release.mjs'

const repo = resolve(import.meta.dirname, '..')
const config = JSON.parse(readFileSync(join(repo, 'deploy/release.config.json'), 'utf8'))
const productionCaddyfile = readFileSync(
  join(repo, 'deploy/hostinger/Caddyfile.production'),
  'utf8',
)
const temps = []
const temp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('arguments', () => {
  test('reads commands, flags and values', () => {
    const options = parseArgs([
      'apply',
      '--assume-live',
      'b5f889c',
      '--edge-later',
      '--label',
      'attribution',
    ])
    assert.equal(options.command, 'apply')
    assert.equal(options.assumeLive, 'b5f889c')
    assert.equal(options.label, 'attribution')
    assert.ok(options.flags.has('edge-later'))
    assert.equal(parseArgs(['--help']).command, 'help')
  })
  test('refuses unknown commands, options and missing values', () => {
    assert.throws(() => parseArgs(['deploy']), /Unknown command/)
    assert.throws(() => parseArgs(['apply', '--force']), /Unknown option/)
    assert.throws(() => parseArgs(['apply', '--assume-live']), /needs a value/)
  })
})

describe('edge Caddyfile', () => {
  test('the repo production Caddyfile meets every requirement, through snippet imports', () => {
    assert.deepEqual(checkEdge(productionCaddyfile, config.edge.requires), {
      ok: true,
      missing: [],
    })
  })
  test('finds the global options, snippets and multi-host sites', () => {
    const heads = parseCaddyBlocks(productionCaddyfile).map((block) => block.head)
    assert.equal(heads[0], '')
    assert.ok(heads.includes('(kissmyapps_dashboard)'))
    const bcLearn = parseCaddyBlocks(productionCaddyfile).find((b) =>
      b.addresses.includes('admin.speaksix.com'),
    )
    assert.ok(bcLearn)
  })
  test('names what a live file without attribution still needs', () => {
    const live = productionCaddyfile
      .replace(/\ton_demand_tls \{\n\t\task http:\/\/kissmyapps-links:8789\/check\n\t\}\n/, '')
      .replace(/^https:\/\/ \{[\s\S]*?\n\}\n/m, '')
    const result = checkEdge(live, config.edge.requires)
    assert.equal(result.ok, false)
    assert.deepEqual(
      result.missing.map((m) => m.site),
      ['https://', 'global options'],
    )
  })
  test('a requirement that only appears in a comment does not count', () => {
    const snippet = readFileSync(join(repo, 'deploy/hostinger/Caddyfile.kissmyapps'), 'utf8')
    const result = checkEdge(snippet, [
      { site: '', contains: ['ask http://kissmyapps-links:8789/check'] },
    ])
    assert.equal(result.ok, false)
  })
})

describe('Supabase CLI output', () => {
  test('migration list: pending, applied and database-only versions', () => {
    const text = `
   Local          | Remote         | Time (UTC)
  ----------------|----------------|---------------------
   20261030160000 | 20261030160000 | 2026-10-30 16:00:00
   20261103100000 |                | 2026-11-03 10:00:00
                  | 20261104000000 | 2026-11-04 00:00:00
`
    assert.deepEqual(parseMigrationList(text), {
      pending: ['20261103100000'],
      remoteOnly: ['20261104000000'],
      applied: ['20261030160000'],
    })
  })
  // Captured from Supabase CLI 2.115.0 (`migration list --db-url ...` against a test
  // database): piped output is JSON, and --output-format text puts every value in backticks.
  const cli115Json =
    'Connecting to remote database...\n{"migrations":[{"local":"","remote":"20261104000000","time":"2026-11-04 00:00:00"},{"local":"20261030160000","remote":"20261030160000","time":"2026-10-30 16:00:00"},{"local":"20261103100000","remote":"","time":"2026-11-03 10:00:00"}],"message":"Migrations listed"}\n'
  const cli115Text = `

   Local            | Remote           | Time (UTC)
  ------------------|------------------|-----------------------
   \` \`              | \`20261104000000\` | \`2026-11-04 00:00:00\`
   \`20261030160000\` | \`20261030160000\` | \`2026-10-30 16:00:00\`
   \`20261103100000\` | \` \`              | \`2026-11-03 10:00:00\`
`
  test('migration list: the JSON and backtick table of CLI 2.115', () => {
    const expected = {
      pending: ['20261103100000'],
      remoteOnly: ['20261104000000'],
      applied: ['20261030160000'],
    }
    assert.deepEqual(parseMigrationList(cli115Json), expected)
    assert.deepEqual(parseMigrationList(cli115Text), expected)
  })
  test('migration list output that names none of the local migrations never reads as up to date', () => {
    const local = ['20261030160000', '20261103100000']
    assert.throws(
      () => checkMigrationList(parseMigrationList('{"message":"Migrations listed"}'), local),
      /could not read its output: it named 0 of this commit's 2 migrations/,
    )
    assert.throws(
      () => checkMigrationList(parseMigrationList('Local | Remote\n`x` | `y`'), local),
      /named 0 of this commit's 2/,
    )
    assert.doesNotThrow(() => checkMigrationList(parseMigrationList(cli115Json), local))
    const fakeCtx = (output) => ({
      config,
      supabase: (args) => (args[0] === 'migration' ? output : '[]'),
    })
    const unreadable = gatherSupabase(fakeCtx('Migrations listed'), local)
    assert.match(unreadable.error.migrations, /could not read its output/)
    const plan = buildPlan(facts({ supabase: { error: unreadable.error } }))
    assert.ok(plan.blockers.some((b) => /Supabase migration list failed: could not read/.test(b)))
    const read = gatherSupabase(fakeCtx(cli115Json), local)
    assert.deepEqual(read.migrations.pending, ['20261103100000'])
    assert.equal(read.error.migrations, undefined)
  })
  test('local migrations are the versions of supabase/migrations', () => {
    const versions = localMigrations(repo)
    assert.ok(versions.length > 70)
    assert.ok(versions.every((v) => /^\d{14}$/.test(v)))
    assert.deepEqual(versions, [...versions].sort())
  })
  test('functions and secrets lists wrapped in a JSON object', () => {
    assert.deepEqual(
      parseFunctionList('{"functions":[{"slug":"marketplace","version":1,"status":"ACTIVE"}]}').map(
        (f) => f.slug,
      ),
      ['marketplace'],
    )
    assert.deepEqual(parseSecretNames('{"secrets":[{"name":"ANALYTICS_IP_SALT","value":"x"}]}'), [
      'ANALYTICS_IP_SALT',
    ])
  })
  test('functions list as JSON and as a table', () => {
    const json =
      '[{"slug":"analytics-ingest","version":3,"status":"ACTIVE","updated_at":1793400000000}]'
    assert.deepEqual(parseFunctionList(json), [
      { slug: 'analytics-ingest', version: 3, status: 'ACTIVE', updatedAt: 1793400000000 },
    ])
    const table = `
   ID   | NAME             | SLUG             | STATUS | VERSION | UPDATED_AT (UTC)
  ------|------------------|------------------|--------|---------|---------------------
   a1b2 | analytics-ingest | analytics-ingest | ACTIVE | 3       | 2026-10-30 22:10:11
`
    assert.equal(parseFunctionList(table)[0].slug, 'analytics-ingest')
    assert.equal(parseFunctionList(table)[0].updatedAt, '2026-10-30 22:10:11')
  })
  test('secrets list gives names only', () => {
    assert.deepEqual(parseSecretNames('[{"name":"A","value":"digest"},{"name":"B","value":"x"}]'), [
      'A',
      'B',
    ])
    assert.deepEqual(parseSecretNames('  NAME | DIGEST\n  -----|-----\n  A    | abc\n'), ['A'])
  })
})

describe('repo facts', () => {
  test('every Edge Function says how its JWT check is set, so a full deploy changes nothing', () => {
    const groups = functionGroups(
      readFileSync(join(repo, 'supabase/config.toml'), 'utf8'),
      localFunctions(repo),
    )
    assert.deepEqual(groups.unset, [])
    assert.ok(groups.noVerify.includes('agreement-notify'))
    assert.ok(groups.noVerify.includes('attribution-links'))
  })
  test('functionGroups notices a missing section', () => {
    const groups = functionGroups(
      '[functions.a]\nverify_jwt = false\n[functions.b]\nverify_jwt = true\n',
      ['a', 'b', 'c'],
    )
    assert.deepEqual(groups, { noVerify: ['a'], verify: ['b'], unset: ['c'] })
  })
  test('VPS files and images come from the repo', () => {
    const files = localVpsFiles(repo, config)
    assert.ok(
      files['compose.yaml'] && files['dashboard.Caddyfile'] && files['link-service/server.mjs'],
    )
    assert.ok(!Object.keys(files).some((path) => path.endsWith('README.md')))
    const images = composeImages(readFileSync(join(repo, 'deploy/hostinger/compose.yaml'), 'utf8'))
    assert.equal(images.length, new Set(images).size)
  })
  test('release ids sort by time and name the build', () => {
    const id = releaseId(
      new Date('2026-11-13T08:05:09.123Z'),
      'Attribution & checkout!',
      'abcdef0123456789',
    )
    assert.equal(id, '20261113T080509Z-attribution-checkout-abcdef012345')
  })
})

function facts(overrides = {}) {
  const head = 'c'.repeat(40)
  const local = {
    head,
    branch: 'main',
    originMain: head,
    dirty: [],
    migrations: ['20261030160000', '20261103100000'],
    functions: ['analytics-ingest', 'attribution-links'],
    functionGroups: { noVerify: ['analytics-ingest', 'attribution-links'], verify: [], unset: [] },
    vpsFiles: { 'compose.yaml': { sha: '1'.repeat(64), service: 'compose' } },
    liveKnown: true,
    liveIsAncestor: true,
    ahead: ['ccccccc Merge pull request #23'],
    ...overrides.local,
  }
  const remote = {
    current: '/srv/kissmyapps/releases/old',
    record: { commit: 'b'.repeat(40), deployedAt: '2026-11-01T11:04:00Z' },
    build: null,
    containers: {
      'kissmyapps-dashboard': 'healthy',
      'kissmyapps-geo': 'healthy',
      'kissmyapps-links': 'missing',
    },
    composeFile: '/srv/kissmyapps/deploy/compose.yaml',
    files: { 'compose.yaml': '1'.repeat(64) },
    env: { 'geo-relay.env': true, 'link-service.env': true },
    images: { 'node:22': true },
    edgePath: '/srv/dramapal/Caddyfile',
    edgeText: productionCaddyfile,
    releases: [],
    diskKb: 27 * 1024 * 1024,
    ...overrides.remote,
  }
  const supabase = {
    migrations: { pending: ['20261103100000'], remoteOnly: [], applied: ['20261030160000'] },
    functions: [{ slug: 'analytics-ingest', updatedAt: '2026-10-30 22:10:11' }],
    secrets: ['ANALYTICS_IP_SALT', 'ANALYTICS_PROXY_SECRET', 'ATTRIBUTION_LINK_SECRET'],
    error: {},
    ...overrides.supabase,
  }
  return { local, remote, supabase, config, options: { flags: new Set(), ...overrides.options } }
}

describe('plan', () => {
  test('a clean main with everything in place is ready, and says what will change', () => {
    const plan = buildPlan(facts())
    assert.deepEqual(plan.blockers, [])
    const text = formatPlan(plan, facts().local)
    assert.match(text, /Database\s+1 migration\(s\) to apply: 20261103100000/)
    assert.match(text, /Functions\s+all 2 redeployed from this commit; new: attribution-links/)
    assert.match(text, /Dashboard\s+bbbbbbb -> ccccccc \(1 commit\(s\)\)/)
    assert.match(text, /Ready:/)
  })
  test('blocks dirty trees, branches and an unknown live commit', () => {
    const plan = buildPlan(
      facts({
        local: { dirty: ['src/App.tsx'], originMain: 'd'.repeat(40) },
        remote: { record: null, build: null },
      }),
    )
    assert.equal(plan.blockers.length, 3)
    assert.match(plan.blockers.join('\n'), /Uncommitted changes.*src\/App.tsx/)
    assert.match(plan.blockers.join('\n'), /not origin\/main/)
    assert.match(plan.blockers.join('\n'), /--assume-live/)
    const assumed = buildPlan(
      facts({ remote: { record: null }, options: { assumeLive: 'b5f889c' } }),
    )
    assert.deepEqual(assumed.blockers, [])
    assert.equal(assumed.live.source, '--assume-live')
  })
  test('refuses to drop live work unless told it is a rollback', () => {
    assert.match(
      buildPlan(facts({ local: { liveIsAncestor: false } })).blockers[0],
      /drop live work/,
    )
    const rollback = facts({
      local: { liveIsAncestor: false },
      options: { flags: new Set(['allow-older']) },
    })
    assert.deepEqual(buildPlan(rollback).blockers, [])
  })
  test('blocks on the database, secrets, env files, images and disk', () => {
    const plan = buildPlan(
      facts({
        supabase: {
          migrations: { pending: [], remoteOnly: ['20261104000000'], applied: [] },
          secrets: ['ANALYTICS_IP_SALT', 'ANALYTICS_PROXY_SECRET'],
        },
        remote: {
          env: { 'geo-relay.env': true },
          images: { 'node:22': false },
          diskKb: 500 * 1024,
        },
      }),
    )
    const text = plan.blockers.join('\n')
    assert.match(text, /migrations this commit does not: 20261104000000/)
    assert.match(text, /secrets not set: ATTRIBUTION_LINK_SECRET/)
    assert.match(text, /link-service.env is missing/)
    assert.match(text, /image not on the VPS/)
    assert.match(text, /Less than 1 GB/)
  })
  test('an edge without the attribution blocks blocks, unless --edge-later', () => {
    const live = productionCaddyfile.replace(/^https:\/\/ \{[\s\S]*?\n\}\n/m, '')
    const plan = buildPlan(facts({ remote: { edgeText: live } }))
    assert.match(plan.blockers.join('\n'), /hand merge/)
    assert.match(
      formatPlan(plan, facts().local),
      /https:\/\/: kissmyapps-links:8788, X-Kma-Client-Ip/,
    )
    const later = buildPlan(
      facts({ remote: { edgeText: live }, options: { flags: new Set(['edge-later']) } }),
    )
    assert.deepEqual(later.blockers, [])
  })
  test('warns about functions that are not in the repo or were deployed outside a release', () => {
    const plan = buildPlan(
      facts({
        supabase: {
          functions: [
            { slug: 'analytics-ingest', updatedAt: '2026-11-05 10:00:00' },
            { slug: 'old-thing', updatedAt: 1 },
          ],
        },
      }),
    )
    assert.match(plan.warnings.join('\n'), /not in the repo \(left alone\): old-thing/)
    assert.match(plan.warnings.join('\n'), /outside it: analytics-ingest/)
  })
})

// A fake VPS: the remote scripts run with bash against a temporary /srv/kissmyapps, and a
// fake `docker` records what it was asked to do.
function fakeServer() {
  const base = temp('kma-release-vps-')
  const root = join(base, 'srv')
  const bin = join(base, 'bin')
  const log = join(base, 'docker.log')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect)
    name="\${@: -1}"
    case " \${FAKE_MISSING:-} " in *" $name "*) exit 1 ;; esac
    case "\${3:-}" in
      *Health*) case " \${FAKE_UNHEALTHY:-} " in *" $name "*) echo unhealthy ;; *) echo healthy ;; esac ;;
      *config_files*) echo "$FAKE_ROOT/deploy/compose.yaml" ;;
      *Mounts*) echo "\${FAKE_EDGE:-}" ;;
      *) echo '{}' ;;
    esac ;;
  exec) cat "$FAKE_ROOT/current/dist/release.json" ;;
  compose) case "$*" in *"config --services"*) grep -E '^  [a-z]+:$' "$FAKE_ROOT/deploy/compose.yaml" | tr -d ' :' ;; esac ;;
esac
exit 0
`,
  )
  chmodSync(join(bin, 'docker'), 0o755)
  // What production looks like before the first release with this tool: a release with no
  // record, the deploy dir with an older compose file, and no link service files.
  const old = join(root, 'releases', '20261101T110342Z-sdk-installs-a933a7cf6518')
  mkdirSync(join(old, 'dist'), { recursive: true })
  writeFileSync(join(old, 'dist', 'index.html'), '<html>old</html>')
  mkdirSync(join(root, 'deploy', 'geo-relay'), { recursive: true })
  writeFileSync(join(root, 'deploy', 'compose.yaml'), 'services:\n  dashboard:\n  geo:\n')
  writeFileSync(join(root, 'deploy', 'dashboard.Caddyfile'), 'old caddyfile\n')
  writeFileSync(
    join(root, 'deploy', 'geo-relay', 'server.mjs'),
    readFileSync(join(repo, 'deploy/geo-relay/server.mjs')),
  )
  writeFileSync(join(root, 'geo-relay.env'), 'KMA_ANALYTICS_PROXY_SECRET=x\n')
  writeFileSync(join(root, 'link-service.env'), 'KMA_ATTRIBUTION_LINK_SECRET=x\n')
  const edge = join(base, 'Caddyfile')
  writeFileSync(edge, productionCaddyfile)
  symlinkSync(old, join(root, 'current'))
  const serverConfig = { ...config, vps: { ...config.vps, root } }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
    FAKE_ROOT: root,
    FAKE_EDGE: edge,
    KMA_WAIT_SECONDS: '4',
  }
  const run = (script, extra = {}) =>
    spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: { ...env, ...extra } })
  const docker = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
  return { base, root, old, config: serverConfig, run, docker }
}

function packForServer(server, head) {
  // A copy of the repo's deploy files and a stand-in build, so packRelease runs for real.
  const work = temp('kma-release-repo-')
  for (const entry of config.vps.files)
    cpSync(join(repo, entry.from), join(work, entry.from), { recursive: true })
  const ctx = {
    repo: work,
    config: server.config,
    run: (command, args, extraEnv = {}) => {
      const result = spawnSync(command, args, {
        cwd: work,
        stdio: 'pipe',
        env: { ...process.env, ...extraEnv },
      })
      if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
    },
  }
  process.env.KMA_RELEASE_BUILD_CMD =
    "mkdir -p dist/assets && echo '<html>new</html>' > dist/index.html && echo 'createClient(\"https://mmyruzjemjecqyivhrgr.supabase.co\")' > dist/assets/app.js"
  try {
    return packRelease(ctx, { head, label: 'test', now: new Date('2026-11-13T08:00:00Z') })
  } finally {
    delete process.env.KMA_RELEASE_BUILD_CMD
  }
}

function upload(server, pack) {
  mkdirSync(join(server.root, 'incoming'), { recursive: true })
  cpSync(pack.archive, join(server.root, 'incoming', `${pack.id}.tar.gz`))
}

describe('remote steps on a fake VPS', () => {
  const head = 'e'.repeat(40)

  test('status reads the pointer, files, env files and edge without changing anything', () => {
    const server = fakeServer()
    const result = server.run(statusScript(server.config, ['node:22']))
    assert.equal(result.status, 0, result.stderr)
    const status = parseStatus(result.stdout)
    assert.equal(status.current, realpathSync(server.old))
    assert.equal(status.record, null)
    assert.equal(status.containers['kissmyapps-dashboard'], 'healthy')
    assert.equal(status.env['link-service.env'], true)
    assert.equal(status.images['node:22'], true)
    assert.ok(status.files['compose.yaml'])
    assert.equal(status.edgeText.trim(), productionCaddyfile.trim())
    assert.ok(status.diskKb > 0)
    const calls = server.docker().trim().split('\n')
    assert.ok(
      calls.every((call) => /^(inspect|image inspect) /.test(call)),
      calls.join('\n'),
    )
  })

  test('a full release: unpack, services, dashboard, record, then rollback', () => {
    const server = fakeServer()
    const pack = packForServer(server, head)
    assert.match(pack.id, /^20261113T080000Z-test-[0-9a-f]{12}$/)
    upload(server, pack)

    let result = server.run(
      unpackScript(server.config, { id: pack.id, archiveSha: pack.archiveSha }),
    )
    assert.equal(result.status, 0, result.stderr)
    const rel = join(server.root, 'releases', pack.id)
    assert.equal(readFileSync(join(rel, 'dist', 'index.html'), 'utf8').trim(), '<html>new</html>')
    assert.equal(JSON.parse(readFileSync(join(rel, 'dist', 'release.json'), 'utf8')).commit, head)
    assert.ok(!existsSync(join(server.root, 'incoming', `${pack.id}.tar.gz`)))
    assert.equal(
      realpathSync(join(server.root, 'current')),
      realpathSync(server.old),
      'unpack switches nothing',
    )

    result = server.run(servicesScript(server.config, { id: pack.id, files: pack.files }))
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /::changed compose compose.yaml/)
    assert.match(result.stdout, /::changed links link-service\/server.mjs/)
    assert.doesNotMatch(result.stdout, /::changed geo geo-relay\/server.mjs/)
    assert.equal(
      readFileSync(join(server.root, 'deploy', 'compose.yaml'), 'utf8'),
      readFileSync(join(repo, 'deploy/hostinger/compose.yaml'), 'utf8'),
    )
    assert.equal(
      readFileSync(join(rel, 'rollback', 'deploy', 'dashboard.Caddyfile'), 'utf8'),
      'old caddyfile\n',
    )
    const docker = server.docker()
    assert.match(
      docker,
      /up -d --no-deps --force-recreate geo/,
      'geo got new files (mmdb.mjs and others)',
    )
    assert.match(docker, /up -d --no-deps --force-recreate links/)

    result = server.run(dashboardScript(server.config, { id: pack.id, commit: head }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(realpathSync(join(server.root, 'current')), realpathSync(rel))
    assert.match(server.docker(), /up -d --no-deps --force-recreate dashboard/)

    const record = { release: pack.id, commit: head, previousRelease: realpathSync(server.old) }
    result = server.run(recordScript(server.config, { id: pack.id, record }))
    assert.equal(result.status, 0, result.stderr)
    const status = parseStatus(server.run(statusScript(server.config, [])).stdout)
    assert.equal(status.record.commit, head)
    assert.equal(status.build.commit, head)
    assert.equal(
      readFileSync(join(server.root, 'releases.log.jsonl'), 'utf8').trim().split('\n').length,
      1,
    )

    result = server.run(
      rollbackScript(server.config, {
        previous: record.previousRelease,
        entry: { rollback: pack.id },
      }),
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(realpathSync(join(server.root, 'current')), realpathSync(server.old))
    assert.equal(
      readFileSync(join(server.root, 'deploy', 'dashboard.Caddyfile'), 'utf8'),
      'old caddyfile\n',
    )
    assert.equal(
      readFileSync(join(server.root, 'deploy', 'compose.yaml'), 'utf8'),
      'services:\n  dashboard:\n  geo:\n',
    )
    assert.match(result.stdout, /::service geo restored/)
    assert.match(
      result.stdout,
      /::service links stopped/,
      'the old compose file has no links service',
    )
    assert.equal(
      readFileSync(join(server.root, 'releases.log.jsonl'), 'utf8').trim().split('\n').length,
      2,
    )
  })

  test('a dashboard that does not come up is switched back at once', () => {
    const server = fakeServer()
    const pack = packForServer(server, head)
    upload(server, pack)
    assert.equal(
      server.run(unpackScript(server.config, { id: pack.id, archiveSha: pack.archiveSha })).status,
      0,
    )
    assert.equal(
      server.run(servicesScript(server.config, { id: pack.id, files: pack.files })).status,
      0,
    )
    const result = server.run(dashboardScript(server.config, { id: pack.id, commit: head }), {
      FAKE_UNHEALTHY: 'kissmyapps-dashboard',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /going back to/)
    assert.equal(realpathSync(join(server.root, 'current')), realpathSync(server.old))
    assert.equal(
      readFileSync(join(server.root, 'deploy', 'dashboard.Caddyfile'), 'utf8'),
      'old caddyfile\n',
    )
  })

  test('a dashboard serving another commit counts as not up', () => {
    const server = fakeServer()
    const pack = packForServer(server, head)
    upload(server, pack)
    server.run(unpackScript(server.config, { id: pack.id, archiveSha: pack.archiveSha }))
    const result = server.run(
      dashboardScript(server.config, { id: pack.id, commit: 'f'.repeat(40) }),
    )
    assert.equal(result.status, 1)
    assert.equal(readlinkSync(join(server.root, 'current')), realpathSync(server.old))
  })

  test('a damaged upload is refused before anything is unpacked', () => {
    const server = fakeServer()
    const pack = packForServer(server, head)
    upload(server, pack)
    writeFileSync(join(server.root, 'incoming', `${pack.id}.tar.gz`), 'not the archive')
    const result = server.run(
      unpackScript(server.config, { id: pack.id, archiveSha: pack.archiveSha }),
    )
    assert.notEqual(result.status, 0)
    assert.ok(!existsSync(join(server.root, 'releases', pack.id)))
  })

  test('the build must point at the production project', () => {
    const server = fakeServer()
    const work = temp('kma-release-repo-')
    for (const entry of config.vps.files)
      cpSync(join(repo, entry.from), join(work, entry.from), { recursive: true })
    process.env.KMA_RELEASE_BUILD_CMD =
      "mkdir -p dist/assets && echo x > dist/index.html && echo 'http://localhost:54321' > dist/assets/app.js"
    try {
      const ctx = {
        repo: work,
        config: server.config,
        run: (command, args) => spawnSync(command, args, { cwd: work, stdio: 'pipe' }),
      }
      assert.throws(() => packRelease(ctx, { head }), /does not use https:\/\/mmyruzjemjecqyivhrgr/)
    } finally {
      delete process.env.KMA_RELEASE_BUILD_CMD
    }
  })
})

describe('apply', () => {
  const cli115Pending =
    '{"migrations":[{"local":"20261030160000","remote":"20261030160000"},{"local":"20261103100000","remote":""}]}'
  const allApplied =
    '{"migrations":[{"local":"20261030160000","remote":"20261030160000"},{"local":"20261103100000","remote":"20261103100000"}]}'
  function fakeContext({ failOn, afterPush = allApplied } = {}) {
    const calls = []
    const ctx = {
      config,
      upload: (file, target) => calls.push(`upload ${target}`),
      remote: (script) => {
        const kind = script.includes('sha256sum -c')
          ? 'unpack'
          : script.includes('KMA_FILES')
            ? 'services'
            : script.includes('switch_current "$rel"')
              ? 'dashboard'
              : 'record'
        calls.push(`remote ${kind}`)
        if (failOn === kind) throw new Error(`${kind} broke`)
        return ''
      },
      supabase: (args) => {
        calls.push(`supabase ${args.slice(0, 2).join(' ')}`)
        if (failOn === args[0]) throw new Error(`${args[0]} broke`)
        return args[0] === 'migration' ? afterPush : ''
      },
    }
    return { ctx, calls }
  }
  const hooks = {
    pack: () => ({
      id: 'rel',
      archive: '/tmp/rel.tar.gz',
      archiveSha: 'a',
      files: {},
      builtAt: 'now',
    }),
    smoke: async () => [{ name: 'partners serves it', ok: true }],
  }

  test('runs every part in order: upload, database, functions, services, dashboard, record', async () => {
    const { ctx, calls } = fakeContext()
    const gathered = facts()
    const plan = buildPlan(gathered)
    const result = await applyRelease(ctx, { label: null }, { ...gathered, plan }, hooks)
    assert.deepEqual(calls, [
      `upload ${config.vps.root}/incoming/rel.tar.gz`,
      'remote unpack',
      'supabase db push',
      'supabase migration list',
      'supabase functions deploy',
      'remote services',
      'remote dashboard',
      'remote record',
    ])
    assert.equal(result.record.commit, gathered.local.head)
    assert.equal(result.record.previousCommit, 'b'.repeat(40))
    assert.deepEqual(result.record.migrations, ['20261103100000'])
  })

  test('stops when migrations are still pending after db push', async () => {
    const { ctx, calls } = fakeContext({ afterPush: cli115Pending })
    const gathered = facts()
    await assert.rejects(
      applyRelease(ctx, {}, { ...gathered, plan: buildPlan(gathered) }, hooks),
      /Migrations still pending after db push: 20261103100000/,
    )
    assert.ok(!calls.includes('supabase functions deploy'))
  })

  test('stops at the first failure and says what already happened', async () => {
    const { ctx, calls } = fakeContext({ failOn: 'functions' })
    const gathered = facts()
    await assert.rejects(
      applyRelease(ctx, {}, { ...gathered, plan: buildPlan(gathered) }, hooks),
      /functions broke\nFinished before that: release uploaded, migrations applied\./,
    )
    assert.ok(!calls.includes('remote dashboard'))
  })
})

test('smoke test checks every dashboard host serves the commit and the events endpoint', async () => {
  const commit = 'a'.repeat(40)
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method ?? 'GET'} ${url}`)
    if (url.endsWith('/release.json'))
      return new Response(JSON.stringify({ commit }), { status: 200 })
    if (url.endsWith('/v1/events')) return new Response('{"error":"invalid_key"}', { status: 401 })
    return new Response('Not found', { status: 404 })
  }
  const results = await smokeTest(config, commit, fetchImpl)
  assert.ok(
    results.every((r) => r.ok),
    JSON.stringify(results),
  )
  assert.equal(results.length, 5)
  assert.ok(seen.includes('POST https://events.kissmyapps.dev/v1/events'))
})
