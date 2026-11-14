#!/usr/bin/env node
// One release for all of KissMyApps. It takes one commit of this repo and sends every part
// of it to production in a fixed order: database migrations, every Edge Function, the VPS
// services (events relay, link service), then the dashboard (partner, admin and merchant
// console in one build). It records which commit went out, and `status` compares what is
// live with main. The shared edge Caddy (DramaPal and BC Learn live there too) is only
// read, never written. See docs/RELEASING.md.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const USAGE = `Usage: node scripts/kma-release.mjs <command> [options]

Commands
  status     Read-only. Shows what is live next to main and what a release would change.
  apply      Releases this commit everywhere, in order. Refuses while status lists blockers.
  rollback   Puts the previous dashboard release and VPS files back.

Options
  --assume-live <commit>  The commit the live dashboard was built from, for releases made
                          before release records existed (the first run).
  --edge-later            Release even though the edge Caddy still needs a hand merge.
  --allow-branch          Release a commit that is not origin/main.
  --allow-older           Release a commit the live one already contains (a rollback).
  --label <words>         A few words for the release folder name.
  --config <file>         Defaults to deploy/release.config.json.
`

// ---------------------------------------------------------------- arguments and config

export function parseArgs(argv) {
  const options = { command: null, flags: new Set(), assumeLive: null, label: null, config: null }
  const valued = { '--assume-live': 'assumeLive', '--label': 'label', '--config': 'config' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg in valued) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      options[valued[arg]] = value
      index += 1
    } else if (arg.startsWith('--')) {
      if (!['--edge-later', '--allow-branch', '--allow-older', '--help'].includes(arg)) {
        throw new Error(`Unknown option ${arg}`)
      }
      options.flags.add(arg.slice(2))
    } else if (!options.command) {
      options.command = arg
    } else {
      throw new Error(`Unexpected argument ${arg}`)
    }
  }
  if (options.flags.has('help')) options.command = 'help'
  if (!['status', 'apply', 'rollback', 'help', null].includes(options.command)) {
    throw new Error(`Unknown command ${options.command}`)
  }
  return options
}

export function loadConfig(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of ['supabase', 'vps', 'edge']) {
    if (!config[key]) throw new Error(`${file} has no "${key}" section`)
  }
  return config
}

/** Shell-quotes one value for the remote scripts. */
export function sq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

// ---------------------------------------------------------------- edge Caddyfile

export function stripCaddyComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
}

/** Top-level blocks of a Caddyfile: the global options (head ""), snippets and sites. */
export function parseCaddyBlocks(text) {
  const blocks = []
  let depth = 0
  let current = null
  for (const raw of stripCaddyComments(text).split('\n')) {
    const line = raw.trim()
    if (depth === 0) {
      if (line.endsWith('{')) {
        current = { head: line.slice(0, -1).trim(), lines: [] }
        depth = 1
      }
      continue
    }
    const opens = (line.match(/{/g) ?? []).length
    const closes = (line.match(/}/g) ?? []).length
    depth += opens - closes
    if (depth <= 0) {
      const head = current.head
      const snippet = /^\(([^)]+)\)$/.exec(head)?.[1] ?? null
      blocks.push({
        head,
        snippet,
        addresses: snippet ? [] : head.split(/[\s,]+/).filter(Boolean),
        body: current.lines.join('\n'),
      })
      depth = 0
      current = null
    } else {
      current.lines.push(line)
    }
  }
  return blocks
}

function expandImports(body, snippets, depth = 0) {
  if (depth > 5) return body
  return body
    .split('\n')
    .map((line) => {
      const name = /^import\s+(\S+)$/.exec(line.trim())?.[1]
      return name && snippets.has(name)
        ? expandImports(snippets.get(name), snippets, depth + 1)
        : line
    })
    .join('\n')
}

/** Which of the release's edge requirements the live Caddyfile does not meet yet. */
export function checkEdge(text, requires) {
  const blocks = parseCaddyBlocks(text)
  const snippets = new Map(blocks.filter((b) => b.snippet).map((b) => [b.snippet, b.body]))
  const missing = []
  for (const requirement of requires) {
    const block =
      requirement.site === ''
        ? blocks.find((b) => b.head === '')
        : blocks.find((b) => b.addresses.includes(requirement.site))
    const where = requirement.site === '' ? 'global options' : requirement.site
    if (!block) {
      missing.push({
        site: where,
        need: requirement.contains.length ? requirement.contains : ['the block'],
      })
      continue
    }
    const body = expandImports(block.body, snippets)
    const need = requirement.contains.filter((text) => !body.includes(text))
    if (need.length) missing.push({ site: where, need })
  }
  return { ok: missing.length === 0, missing }
}

// ---------------------------------------------------------------- Supabase CLI output

/**
 * `supabase migration list`. CLI 2.115 prints JSON ({"migrations":[{local, remote, time}]})
 * when its output is piped, and a table with each value in backticks with
 * `--output-format text`; older versions print a bare table. All three are read here, and
 * `checkMigrationList` makes sure the result covers this commit's migrations, so a format
 * this does not know can never read as "up to date".
 */
export function parseMigrationList(text) {
  const pending = []
  const remoteOnly = []
  const applied = []
  const isVersion = (value) => /^\d{14}$/.test(value)
  const add = (local, remote) => {
    if (!isVersion(local) && !isVersion(remote)) return
    if (isVersion(local) && isVersion(remote)) applied.push(local)
    else if (isVersion(local)) pending.push(local)
    else remoteOnly.push(remote)
  }
  const rows = jsonRows(text, 'migrations')
  if (rows) {
    for (const row of rows) add(String(row?.local ?? '').trim(), String(row?.remote ?? '').trim())
    return { pending, remoteOnly, applied }
  }
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((cell) => cell.replace(/`/g, '').trim())
    if (cells.length < 2) continue
    add(cells[0], cells[1])
  }
  return { pending, remoteOnly, applied }
}

/** Throws unless the list names every migration file of this commit, and nothing else local. */
export function checkMigrationList(list, localVersions) {
  const listed = new Set([...list.pending, ...list.applied])
  const missing = localVersions.filter((version) => !listed.has(version))
  const unknown = [...listed].filter((version) => !localVersions.includes(version))
  if (missing.length || unknown.length) {
    throw new Error(
      `could not read its output: it named ${listed.size} of this commit's ${localVersions.length} migrations` +
        (unknown.length ? ` and ${unknown.length} that are not in supabase/migrations` : '') +
        '. Check the Supabase CLI version (node_modules/.bin/supabase --version).',
    )
  }
  return list
}

function parseTable(text) {
  const rows = text
    .split('\n')
    .filter((line) => line.includes('|') && !/^[\s|-]+$/.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim()))
  if (!rows.length) return []
  const header = rows[0].map((cell) => cell.toLowerCase())
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((key, i) => [key, cells[i]])))
}

/** The first JSON value in the text (CLI output can start with a status line). */
function parseJsonValue(text) {
  const starts = ['{', '[']
    .map((opener) => text.indexOf(opener))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
  for (const start of starts) {
    try {
      return JSON.parse(text.slice(start).trim())
    } catch {
      // try the next opener
    }
  }
  return null
}

/** Rows from JSON output: a bare array, or the array under `key` in an object. */
function jsonRows(text, key) {
  const value = parseJsonValue(text)
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    if (Array.isArray(value[key])) return value[key]
    return Object.values(value).find(Array.isArray) ?? null
  }
  return null
}

/** `supabase functions list`, as JSON or as its table. */
export function parseFunctionList(text) {
  const json = jsonRows(text, 'functions')
  const rows = json ?? parseTable(text)
  return rows
    .map((row) => ({
      slug: row.slug ?? row.name ?? null,
      version: row.version ?? null,
      status: row.status ?? null,
      updatedAt: row.updated_at ?? row['updated_at (utc)'] ?? row.updatedAt ?? null,
    }))
    .filter((row) => row.slug)
}

/** `supabase secrets list`: names only. Values are digests and are never printed. */
export function parseSecretNames(text) {
  const json = jsonRows(text, 'secrets')
  const rows = json ?? parseTable(text)
  return rows.map((row) => row.name).filter(Boolean)
}

export function toTime(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return toTime(Number(text))
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed) ? null : parsed
}

// ---------------------------------------------------------------- repo facts

/** Versions of supabase/migrations/<version>_<name>.sql, the files `supabase db push` reads. */
export function localMigrations(repo) {
  return readdirSync(join(repo, 'supabase', 'migrations'))
    .map((name) => /^(\d{14})_.*\.sql$/.exec(name)?.[1])
    .filter(Boolean)
    .sort()
}

export function localFunctions(repo) {
  const dir = join(repo, 'supabase', 'functions')
  return readdirSync(dir)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter((name) => existsSync(join(dir, name, 'index.ts')))
    .sort()
}

/** Splits functions by their `verify_jwt` in supabase/config.toml. */
export function functionGroups(configToml, names) {
  const settings = new Map()
  let section = null
  for (const line of configToml.split('\n')) {
    const header = /^\s*\[functions\.([^\]]+)\]\s*$/.exec(line)
    if (header) {
      section = header[1].replace(/^"|"$/g, '')
      continue
    }
    if (/^\s*\[/.test(line)) section = null
    const setting = /^\s*verify_jwt\s*=\s*(true|false)\s*$/.exec(line)
    if (section && setting) settings.set(section, setting[1] === 'true')
  }
  const groups = { noVerify: [], verify: [], unset: [] }
  for (const name of names) {
    if (!settings.has(name)) groups.unset.push(name)
    else if (settings.get(name)) groups.verify.push(name)
    else groups.noVerify.push(name)
  }
  return groups
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** The VPS files this commit ships, as { path under the host's deploy dir: { from, service, sha } }. */
export function localVpsFiles(repo, config) {
  const files = {}
  for (const entry of config.vps.files) {
    const source = join(repo, entry.from)
    if (statSync(source).isDirectory()) {
      for (const name of readdirSync(source).sort()) {
        if (entry.glob && !name.endsWith(entry.glob)) continue
        const path = join(source, name)
        if (!statSync(path).isFile()) continue
        files[`${entry.to}/${name}`] = {
          from: relative(repo, path),
          service: entry.service,
          sha: sha256(readFileSync(path)),
        }
      }
    } else {
      files[entry.to] = {
        from: entry.from,
        service: entry.service,
        sha: sha256(readFileSync(source)),
      }
    }
  }
  return files
}

export function composeImages(composeYaml) {
  const images = [...composeYaml.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) =>
    m[1].replace(/^['"]|['"]$/g, ''),
  )
  return [...new Set(images)]
}

// ---------------------------------------------------------------- remote scripts

const WAIT_HEALTHY = `wait_healthy() {
  c="$1"; tries=$(( \${KMA_WAIT_SECONDS:-120} / 2 )); s=missing
  while [ "$tries" -gt 0 ]; do
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null) || s=missing
    case "$s" in healthy|running) return 0 ;; unhealthy|exited|dead|missing) break ;; esac
    tries=$((tries - 1)); sleep 2
  done
  echo "::unhealthy $c $s" >&2
  return 1
}`

function header(config, extra = {}) {
  const vars = {
    ROOT: config.vps.root,
    PROJECT: config.vps.composeProject,
    ...extra,
  }
  return [
    'set -euo pipefail',
    ...Object.entries(vars).map(([key, value]) => `${key}=${sq(value)}`),
    'dep="$ROOT/deploy"',
    'compose() { docker compose -p "$PROJECT" -f "$dep/compose.yaml" "$@"; }',
    'switch_current() { ln -sfn "$1" "$ROOT/current.next"; mv -T "$ROOT/current.next" "$ROOT/current"; }',
    WAIT_HEALTHY,
  ].join('\n')
}

/** Read-only: the release pointer, records, containers, deploy files, env files, edge. */
export function statusScript(config, images) {
  const containers = [
    config.vps.dashboard.container,
    ...config.vps.services.map((s) => s.container),
  ]
  const envFiles = config.vps.services.map((s) => s.envFile).filter(Boolean)
  return `set -u
ROOT=${sq(config.vps.root)}
cur=$(readlink -f "$ROOT/current" 2>/dev/null || true)
echo "::current $cur"
if [ -n "$cur" ] && [ -f "$cur/kma-release.json" ]; then echo "::begin record"; cat "$cur/kma-release.json"; echo; echo "::end"; fi
if [ -n "$cur" ] && [ -f "$cur/dist/release.json" ]; then echo "::begin build"; cat "$cur/dist/release.json"; echo; echo "::end"; fi
for c in ${containers.map(sq).join(' ')}; do
  s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null) || s=missing
  echo "::container $c $s"
done
echo "::compose $(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' ${sq(config.vps.dashboard.container)} 2>/dev/null || true)"
echo "::begin files"
if [ -d "$ROOT/deploy" ]; then (cd "$ROOT/deploy" && find . -type f -print0 | xargs -0 -r sha256sum); fi
echo "::end"
for f in ${envFiles.map(sq).join(' ')}; do if [ -s "$ROOT/$f" ]; then echo "::env $f present"; else echo "::env $f missing"; fi; done
for img in ${images.map(sq).join(' ')}; do if docker image inspect "$img" >/dev/null 2>&1; then echo "::image present $img"; else echo "::image missing $img"; fi; done
edge=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination ${JSON.stringify(config.edge.caddyfile)}}}{{.Source}}{{end}}{{end}}' ${sq(config.edge.container)} 2>/dev/null || true)
echo "::edgepath $edge"
if [ -n "$edge" ] && [ -r "$edge" ]; then echo "::begin edge"; cat "$edge"; echo; echo "::end"; fi
echo "::begin releases"; ls -1 "$ROOT/releases" 2>/dev/null | tail -n 5; echo "::end"
echo "::disk $(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')"
`
}

export function parseStatus(text) {
  const status = {
    current: null,
    record: null,
    build: null,
    containers: {},
    composeFile: null,
    files: {},
    env: {},
    images: {},
    edgePath: null,
    edgeText: null,
    releases: [],
    diskKb: null,
  }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const begin = /^::begin (\S+)$/.exec(line)
    if (begin) {
      const body = []
      index += 1
      while (index < lines.length && lines[index] !== '::end') body.push(lines[index++])
      const content = body.join('\n')
      const name = begin[1]
      if (name === 'record' || name === 'build') {
        try {
          status[name] = JSON.parse(content)
        } catch {
          status[name] = null
        }
      } else if (name === 'files') {
        for (const row of body) {
          const match = /^([0-9a-f]{64})\s+\.\/(.+)$/.exec(row)
          if (match) status.files[match[2]] = match[1]
        }
      } else if (name === 'edge') status.edgeText = content
      else if (name === 'releases') status.releases = body.filter(Boolean)
      continue
    }
    const [tag, ...rest] = line.split(' ')
    const value = rest.join(' ').trim()
    if (tag === '::current') status.current = value || null
    else if (tag === '::compose') status.composeFile = value || null
    else if (tag === '::edgepath') status.edgePath = value || null
    else if (tag === '::disk') status.diskKb = value ? Number(value) : null
    else if (tag === '::container') status.containers[rest[0]] = rest[1] ?? 'missing'
    else if (tag === '::env') status.env[rest[0]] = rest[1] === 'present'
    else if (tag === '::image') status.images[rest.slice(1).join(' ')] = rest[0] === 'present'
  }
  return status
}

/** Checks and unpacks an uploaded release archive. Switches nothing. */
export function unpackScript(config, { id, archiveSha }) {
  return `${header(config, { ID: id, SHA: archiveSha })}
archive="$ROOT/incoming/$ID.tar.gz"
rel="$ROOT/releases/$ID"
tmp="$ROOT/releases/.$ID.tmp"
[ ! -e "$rel" ] || { echo "release $ID already exists" >&2; exit 1; }
echo "$SHA  $archive" | sha256sum -c --quiet -
rm -rf "$tmp"; install -d -m 755 "$tmp"
tar -xzf "$archive" -C "$tmp" --no-same-owner
(cd "$tmp" && sha256sum -c --quiet SHA256SUMS)
chmod -R a+rX "$tmp"
mv "$tmp" "$rel"
rm -f "$archive"
echo "::unpacked $rel"
`
}

/** Copies the release's VPS files into the host's deploy dir and (re)starts geo and links. */
export function servicesScript(config, { id, files }) {
  const list = Object.entries(files)
    .map(([path, file]) => `${file.service} ${path}`)
    .join('\n')
  const services = config.vps.services
    .map((s) => `compose_service ${sq(s.name)} ${sq(s.container)}`)
    .join('\n')
  return `${header(config, { ID: id })}
rel="$ROOT/releases/$ID"
[ -d "$rel/deploy" ] || { echo "release $ID has no deploy files" >&2; exit 1; }
install -d -m 755 "$dep"
if [ ! -e "$rel/rollback/deploy" ]; then install -d -m 755 "$rel/rollback"; cp -a "$dep" "$rel/rollback/deploy"; fi
changed=" "
while read -r svc path; do
  [ -n "$path" ] || continue
  if ! cmp -s "$rel/deploy/$path" "$dep/$path"; then
    install -D -m 644 "$rel/deploy/$path" "$dep/$path"
    echo "::changed $svc $path"
    changed="$changed$svc "
  fi
done <<'KMA_FILES'
${list}
KMA_FILES
compose_service() {
  svc="$1"; c="$2"
  case "$changed" in
    *" $svc "*) compose up -d --no-deps --force-recreate "$svc" ;;
    *) compose up -d --no-deps "$svc" ;;
  esac
  wait_healthy "$c"
  echo "::service $svc up"
}
${services}
`
}

/** Points `current` at the release, recreates the dashboard and checks it serves this commit. */
export function dashboardScript(config, { id, commit }) {
  const { name, container } = config.vps.dashboard
  return `${header(config, { ID: id, COMMIT: commit, SERVICE: name, CONTAINER: container })}
rel="$ROOT/releases/$ID"
[ -f "$rel/dist/index.html" ] || { echo "release $ID has no dashboard build" >&2; exit 1; }
prev=$(readlink -f "$ROOT/current" 2>/dev/null || true)
switch_current "$rel"
compose up -d --no-deps --force-recreate "$SERVICE"
ok=0
if wait_healthy "$CONTAINER"; then
  served=$(docker exec "$CONTAINER" wget -qO- http://127.0.0.1:8080/release.json 2>/dev/null) || served=""
  case "$served" in *"$COMMIT"*) ok=1 ;; esac
fi
if [ "$ok" = 1 ]; then
  echo "::live $rel"
else
  echo "::failed the new dashboard did not come up; going back to $prev" >&2
  if [ -n "$prev" ]; then switch_current "$prev"; fi
  if [ -f "$rel/rollback/deploy/dashboard.Caddyfile" ]; then install -m 644 "$rel/rollback/deploy/dashboard.Caddyfile" "$dep/dashboard.Caddyfile"; fi
  compose up -d --no-deps --force-recreate "$SERVICE" || true
  exit 1
fi
`
}

export function recordScript(config, { id, record }) {
  const encoded = Buffer.from(`${JSON.stringify(record, null, 2)}\n`).toString('base64')
  const line = Buffer.from(`${JSON.stringify(record)}\n`).toString('base64')
  return `${header(config, { ID: id })}
rel="$ROOT/releases/$ID"
printf '%s' ${sq(encoded)} | base64 -d > "$rel/kma-release.json"
printf '%s' ${sq(line)} | base64 -d >> "$ROOT/releases.log.jsonl"
echo "::recorded $rel/kma-release.json"
`
}

/** Back to the previous dashboard release and the VPS files it ran with. */
export function rollbackScript(config, { previous, entry }) {
  const { name, container } = config.vps.dashboard
  const line = Buffer.from(`${JSON.stringify(entry)}\n`).toString('base64')
  const services = config.vps.services
    .map((s) => `restore_service ${sq(s.name)} ${sq(s.container)}`)
    .join('\n')
  return `${header(config, { PREV: previous, SERVICE: name, CONTAINER: container })}
cur=$(readlink -f "$ROOT/current")
[ -f "$PREV/dist/index.html" ] || { echo "previous release $PREV is gone" >&2; exit 1; }
[ "$cur" != "$(readlink -f "$PREV")" ] || { echo "$PREV is already live" >&2; exit 1; }
if [ -d "$cur/rollback/deploy" ]; then cp -a "$cur/rollback/deploy/." "$dep/"; fi
switch_current "$PREV"
compose up -d --no-deps --force-recreate "$SERVICE"
wait_healthy "$CONTAINER"
restore_service() {
  svc="$1"; c="$2"
  # Read the restored compose file itself: \`compose config\` also fails for unrelated
  # reasons (a missing env file), and that must never stop a running service.
  if grep -E "^  $svc:[[:space:]]*$" "$dep/compose.yaml" >/dev/null 2>&1; then
    compose up -d --no-deps --force-recreate "$svc"; wait_healthy "$c"; echo "::service $svc restored"
  elif docker inspect "$c" >/dev/null 2>&1; then
    docker stop "$c" >/dev/null; echo "::service $svc stopped"
  fi
}
${services}
printf '%s' ${sq(line)} | base64 -d >> "$ROOT/releases.log.jsonl"
echo "::live $PREV"
`
}

// ---------------------------------------------------------------- the plan

export function releaseId(date, label, sumsSha) {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const words =
    String(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'release'
  return `${stamp}-${words}-${sumsSha.slice(0, 12)}`
}

/**
 * Everything `status` prints and `apply` checks, from facts gathered elsewhere, so it can
 * be tested without a server: { blockers, warnings, changes, live, edge }.
 */
export function buildPlan({ local, remote, supabase, config, options }) {
  const blockers = []
  const warnings = []
  const changes = []
  const flags = options.flags ?? new Set()

  if (local.dirty.length)
    blockers.push(`Uncommitted changes to tracked files: ${local.dirty.join(', ')}`)
  if (!local.originMain) blockers.push('Could not read origin/main (git fetch failed).')
  else if (local.head !== local.originMain && !flags.has('allow-branch')) {
    blockers.push(
      `This commit (${short(local.head)}) is not origin/main (${short(local.originMain)}). Release main, or pass --allow-branch.`,
    )
  }

  const liveCommit = remote.record?.commit ?? remote.build?.commit ?? options.assumeLive ?? null
  const liveSource = remote.record?.commit
    ? 'release record'
    : remote.build?.commit
      ? 'dashboard build'
      : options.assumeLive
        ? '--assume-live'
        : null
  const live = {
    release: remote.current,
    commit: liveCommit,
    source: liveSource,
    ahead: local.ahead,
  }
  if (!liveCommit) {
    blockers.push(
      `The live dashboard (${remote.current ?? 'no release'}) has no release record, so its commit is unknown. Pass --assume-live <commit> once you have checked which commit it was built from.`,
    )
  } else if (local.liveKnown === false) {
    blockers.push(
      `The live commit ${short(liveCommit)} is not in this clone. Run git fetch origin.`,
    )
  } else if (local.liveIsAncestor === false && !flags.has('allow-older')) {
    blockers.push(
      `The live commit ${short(liveCommit)} is not part of this commit's history, so releasing would drop live work. Merge it first, or pass --allow-older for a deliberate rollback.`,
    )
  }

  // Database
  if (supabase.error.migrations)
    blockers.push(`Supabase migration list failed: ${supabase.error.migrations}`)
  else {
    if (supabase.migrations.remoteOnly.length) {
      blockers.push(
        `The database has migrations this commit does not: ${supabase.migrations.remoteOnly.join(', ')}.`,
      )
    }
    changes.push({
      part: 'Database',
      detail: supabase.migrations.pending.length
        ? `${supabase.migrations.pending.length} migration(s) to apply: ${supabase.migrations.pending.join(', ')}`
        : 'up to date',
    })
  }

  // Functions
  const groups = local.functionGroups
  if (groups.unset.length) {
    blockers.push(
      `supabase/config.toml has no verify_jwt for: ${groups.unset.join(', ')}. Add a [functions.<name>] section for each.`,
    )
  }
  if (supabase.error.functions)
    blockers.push(`Supabase functions list failed: ${supabase.error.functions}`)
  else {
    const deployed = new Map(supabase.functions.map((f) => [f.slug, f]))
    const notDeployed = local.functions.filter((name) => !deployed.has(name))
    const extra = [...deployed.keys()].filter((slug) => !local.functions.includes(slug))
    changes.push({
      part: 'Functions',
      detail: `all ${local.functions.length} redeployed from this commit${notDeployed.length ? `; new: ${notDeployed.join(', ')}` : ''}`,
    })
    if (extra.length)
      warnings.push(`Deployed functions that are not in the repo (left alone): ${extra.join(', ')}`)
    const since = toTime(remote.record?.deployedAt)
    if (since) {
      const outside = supabase.functions
        .filter((f) => (toTime(f.updatedAt) ?? 0) > since + 60_000)
        .map((f) => f.slug)
      if (outside.length) {
        warnings.push(`Deployed after the last release, outside it: ${outside.join(', ')}`)
      }
    }
  }
  if (supabase.error.secrets)
    blockers.push(`Supabase secrets list failed: ${supabase.error.secrets}`)
  else {
    const missing = config.supabase.requiredSecrets.filter(
      (name) => !supabase.secrets.includes(name),
    )
    if (missing.length) blockers.push(`Edge Function secrets not set: ${missing.join(', ')}`)
  }

  // VPS files and services
  const changedFiles = Object.entries(local.vpsFiles)
    .filter(([path, file]) => remote.files[path] !== file.sha)
    .map(([path]) => path)
  changes.push({
    part: 'VPS files',
    detail: changedFiles.length
      ? `${changedFiles.length} to update: ${changedFiles.join(', ')}`
      : 'same as this commit',
  })
  const expectedCompose = `${config.vps.root}/deploy/compose.yaml`
  if (remote.composeFile && remote.composeFile !== expectedCompose) {
    warnings.push(
      `The dashboard was started from ${remote.composeFile}; releases use ${expectedCompose} from now on.`,
    )
  }
  for (const service of config.vps.services) {
    if (service.envFile && !remote.env[service.envFile]) {
      blockers.push(
        `${config.vps.root}/${service.envFile} is missing on the VPS (the ${service.name} service's secret).`,
      )
    }
  }
  for (const [image, present] of Object.entries(remote.images)) {
    if (!present) blockers.push(`Docker image not on the VPS (compose never pulls): ${image}`)
  }
  const states = [config.vps.dashboard, ...config.vps.services]
    .map((s) => `${s.name} ${remote.containers[s.container] ?? 'missing'}`)
    .join(', ')
  changes.push({ part: 'Services', detail: states })
  if (remote.diskKb !== null && remote.diskKb < 1024 * 1024) {
    blockers.push(`Less than 1 GB free on the VPS (${Math.round(remote.diskKb / 1024)} MB).`)
  }
  changes.push({
    part: 'Dashboard',
    detail: liveCommit
      ? `${short(liveCommit)} -> ${short(local.head)}${local.ahead ? ` (${local.ahead.length} commit(s))` : ''}`
      : `unknown -> ${short(local.head)}`,
  })

  // Edge
  let edge
  if (!remote.edgeText) {
    edge = { ok: false, missing: [], unreadable: true }
    if (!flags.has('edge-later')) {
      blockers.push(
        `Could not read the edge Caddyfile (${remote.edgePath || 'not found'}). Check it by hand, then pass --edge-later.`,
      )
    }
  } else {
    edge = checkEdge(remote.edgeText, config.edge.requires)
    if (!edge.ok && !flags.has('edge-later')) {
      blockers.push(
        'The edge Caddy needs a hand merge first (see "Edge" above and deploy/hostinger/README.md), or pass --edge-later to release without it.',
      )
    }
  }

  return { blockers, warnings, changes, live, edge, changedFiles }
}

function short(commit) {
  return commit ? commit.slice(0, 7) : 'unknown'
}

export function formatPlan(plan, local) {
  const out = []
  out.push('KissMyApps release status', '')
  out.push(
    `Repo       ${local.branch} at ${short(local.head)} (origin/main ${short(local.originMain)})`,
  )
  out.push(
    `Live       ${plan.live.release ?? 'no release'}${plan.live.commit ? `, commit ${short(plan.live.commit)} (from ${plan.live.source})` : ''}`,
  )
  if (plan.live.ahead?.length) {
    out.push(`           This commit is ${plan.live.ahead.length} commit(s) ahead of live:`)
    for (const line of plan.live.ahead.slice(0, 15)) out.push(`             ${line}`)
    if (plan.live.ahead.length > 15)
      out.push(`             ...and ${plan.live.ahead.length - 15} more`)
  }
  for (const change of plan.changes) out.push(`${change.part.padEnd(10)} ${change.detail}`)
  if (plan.edge.unreadable) out.push('Edge       could not be read')
  else if (plan.edge.ok) out.push('Edge       has every block this release needs')
  else {
    out.push('Edge       needs a hand merge:')
    for (const item of plan.edge.missing)
      out.push(`             ${item.site}: ${item.need.join(', ')}`)
  }
  if (plan.warnings.length) {
    out.push('', 'Worth a look:')
    for (const warning of plan.warnings) out.push(`  - ${warning}`)
  }
  out.push('')
  if (plan.blockers.length) {
    out.push('Before a release can run:')
    for (const blocker of plan.blockers) out.push(`  - ${blocker}`)
  } else out.push('Ready: `node scripts/kma-release.mjs apply` releases this commit everywhere.')
  return out.join('\n')
}

// ---------------------------------------------------------------- effects

function makeContext(repo, config) {
  const remoteMode = process.env.KMA_RELEASE_REMOTE ?? 'ssh'
  const ssh = process.env.KMA_RELEASE_SSH ?? config.vps.ssh
  const supabaseBin = process.env.SUPABASE_BIN ?? join(repo, 'node_modules', '.bin', 'supabase')
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', ssh]

  const gitRaw = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const git = (...args) => gitRaw(...args).trim()
  const gitOk = (...args) => spawnSync('git', args, { cwd: repo, stdio: 'ignore' }).status === 0

  /** Runs a bash script on the VPS (or locally, for tests). Returns its stdout. */
  const remote = (script, { quiet = false } = {}) => {
    const [command, args] =
      remoteMode === 'local' ? ['bash', ['-s']] : ['ssh', [...sshArgs, 'bash', '-s']]
    const result = spawnSync(command, args, {
      input: script,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', quiet ? 'pipe' : 'inherit'],
      maxBuffer: 32 * 1024 * 1024,
    })
    if (result.status !== 0) {
      const detail = quiet ? (result.stderr ?? '').trim().split('\n').slice(-3).join(' ') : ''
      throw new Error(`Remote step failed (exit ${result.status})${detail ? `: ${detail}` : ''}`)
    }
    if (!quiet && result.stdout) process.stdout.write(result.stdout)
    return result.stdout
  }

  const upload = (file, target) => {
    const fd = openSync(file, 'r')
    try {
      // Runs in the login shell, which may not be bash: keep it POSIX.
      const script = `set -eu; install -d -m 700 ${sq(`${config.vps.root}/incoming`)}; cat > ${sq(target)}`
      const [command, args] =
        remoteMode === 'local' ? ['bash', ['-c', script]] : ['ssh', [...sshArgs, script]]
      const result = spawnSync(command, args, { stdio: [fd, 'inherit', 'inherit'] })
      if (result.status !== 0) throw new Error(`Upload failed (exit ${result.status})`)
    } finally {
      closeSync(fd)
    }
  }

  const supabase = (args, { quiet = true } = {}) => {
    const result = spawnSync(supabaseBin, args, {
      cwd: repo,
      // A stale ~/.supabase/profile can name a profile the CLI cannot load ("Unsupported
      // Config Type"); the default profile is the one this release talks to.
      env: { ...process.env, SUPABASE_PROFILE: process.env.SUPABASE_PROFILE || 'supabase' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'],
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

  const run = (command, args, env = {}) => {
    const result = spawnSync(command, args, {
      cwd: repo,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    })
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
  }

  return { repo, config, git, gitRaw, gitOk, remote, upload, supabase, run }
}

export function gatherLocal(ctx, liveCommit) {
  const { repo, git, gitRaw, gitOk } = ctx
  let originMain = null
  if (gitOk('fetch', '--quiet', 'origin', 'main')) originMain = git('rev-parse', 'origin/main')
  const head = git('rev-parse', 'HEAD')
  const local = {
    head,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    originMain,
    dirty: gitRaw('status', '--porcelain', '--untracked-files=no')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3)),
    migrations: localMigrations(repo),
    functions: localFunctions(repo),
    vpsFiles: localVpsFiles(repo, ctx.config),
    liveKnown: null,
    liveIsAncestor: null,
    ahead: null,
  }
  local.functionGroups = functionGroups(
    readFileSync(join(repo, 'supabase', 'config.toml'), 'utf8'),
    local.functions,
  )
  if (liveCommit) {
    local.liveKnown = gitOk('cat-file', '-e', `${liveCommit}^{commit}`)
    if (local.liveKnown) {
      local.liveIsAncestor = gitOk('merge-base', '--is-ancestor', liveCommit, head)
      if (local.liveIsAncestor) {
        local.ahead = git('log', '--oneline', '--first-parent', `${liveCommit}..${head}`)
          .split('\n')
          .filter(Boolean)
      }
    }
  }
  return local
}

export function gatherSupabase(ctx, localVersions) {
  const ref = ctx.config.supabase.projectRef
  const facts = {
    migrations: { pending: [], remoteOnly: [], applied: [] },
    functions: [],
    secrets: [],
    error: {},
  }
  const attempt = (key, fn) => {
    try {
      fn()
    } catch (error) {
      facts.error[key] = error.message
    }
  }
  attempt('migrations', () => {
    const list = parseMigrationList(ctx.supabase(['migration', 'list', '--linked']))
    facts.migrations = checkMigrationList(list, localVersions)
  })
  attempt('functions', () => {
    facts.functions = parseFunctionList(
      ctx.supabase(['functions', 'list', '--project-ref', ref, '-o', 'json']),
    )
  })
  attempt('secrets', () => {
    facts.secrets = parseSecretNames(
      ctx.supabase(['secrets', 'list', '--project-ref', ref, '-o', 'json']),
    )
  })
  return facts
}

export function gatherRemote(ctx) {
  const images = composeImages(
    readFileSync(join(ctx.repo, 'deploy', 'hostinger', 'compose.yaml'), 'utf8'),
  )
  return parseStatus(ctx.remote(statusScript(ctx.config, images), { quiet: true }))
}

function gatherAll(ctx, options) {
  const remote = gatherRemote(ctx)
  const liveCommit = remote.record?.commit ?? remote.build?.commit ?? options.assumeLive ?? null
  const local = gatherLocal(ctx, liveCommit)
  const supabase = gatherSupabase(ctx, local.migrations)
  const plan = buildPlan({ local, remote, supabase, config: ctx.config, options })
  return { remote, local, supabase, plan }
}

/** Builds the dashboard and packs it with the VPS files into one checked archive. */
export function packRelease(ctx, { head, label, now = new Date() }) {
  const { repo, config } = ctx
  const buildCommand = process.env.KMA_RELEASE_BUILD_CMD
  if (buildCommand) ctx.run('sh', ['-c', buildCommand])
  else ctx.run('npm', ['run', 'build'])
  const dist = join(repo, 'dist')
  if (!existsSync(join(dist, 'index.html'))) throw new Error('The build wrote no dist/index.html.')
  const projectUrl = `https://${config.supabase.projectRef}.supabase.co`
  const assets = existsSync(join(dist, 'assets')) ? readdirSync(join(dist, 'assets')) : []
  const pointsAtProduction = assets.some(
    (name) =>
      name.endsWith('.js') && readFileSync(join(dist, 'assets', name), 'utf8').includes(projectUrl),
  )
  if (!pointsAtProduction) {
    throw new Error(
      `The build does not use ${projectUrl}. Check .env.production and any .env.production.local.`,
    )
  }
  const builtAt = now.toISOString()
  writeFileSync(
    join(dist, 'release.json'),
    `${JSON.stringify({ commit: head, builtAt }, null, 2)}\n`,
  )

  const work = join(repo, '.release')
  const staging = join(work, 'staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  cpSync(dist, join(staging, 'dist'), { recursive: true })
  const files = localVpsFiles(repo, config)
  for (const [path, file] of Object.entries(files)) {
    mkdirSync(join(staging, 'deploy', path, '..'), { recursive: true })
    cpSync(join(repo, file.from), join(staging, 'deploy', path))
  }
  const sums = walk(staging)
    .map((path) => `${sha256(readFileSync(path))}  ./${relative(staging, path)}`)
    .sort()
    .join('\n')
  writeFileSync(join(staging, 'SHA256SUMS'), `${sums}\n`)
  const id = releaseId(now, label ?? `main-${head.slice(0, 7)}`, sha256(`${sums}\n`))
  const archive = join(work, `${id}.tar.gz`)
  // ustar has no room for macOS extended attributes, so GNU tar on the VPS unpacks it cleanly.
  ctx.run('tar', ['--format=ustar', '-czf', archive, '-C', staging, '.'], { COPYFILE_DISABLE: '1' })
  return { id, archive, archiveSha: sha256(readFileSync(archive)), files, builtAt }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : []
  })
}

function step(title) {
  console.log(`\n==> ${title}`)
}

export async function smokeTest(config, commit, fetchImpl = fetch) {
  const results = []
  const check = async (name, fn) => {
    try {
      results.push({ name, ok: await fn() })
    } catch (error) {
      results.push({ name, ok: false, detail: error.message })
    }
  }
  const get = (url, init = {}) =>
    fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  for (const host of config.smoke?.dashboardHosts ?? []) {
    await check(`${host} serves ${commit.slice(0, 7)}`, async () => {
      const response = await get(`https://${host}/release.json`)
      return response.ok && (await response.json()).commit === commit
    })
  }
  const events = config.smoke?.eventsHost
  if (events) {
    await check(
      `${events}/ answers 404`,
      async () => (await get(`https://${events}/`)).status === 404,
    )
    await check(`${events}/v1/events without a key answers 401`, async () => {
      const response = await get(`https://${events}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      return response.status === 401
    })
  }
  return results
}

/** The release itself. Each step is safe to repeat: re-run `apply` after fixing a failure. */
export async function applyRelease(ctx, options, gathered, hooks = {}) {
  const { config } = ctx
  const { local, remote, plan } = gathered
  const ref = config.supabase.projectRef
  const done = []
  const fail = (error) => {
    const message = [`\nThe release stopped: ${error.message}`]
    message.push(
      done.length ? `Finished before that: ${done.join(', ')}.` : 'Nothing in production changed.',
    )
    message.push('Fix the cause and run apply again; finished steps are no-ops the second time.')
    throw new Error(message.join('\n'))
  }
  try {
    step('Building the dashboard and packing the release')
    const pack = (hooks.pack ?? packRelease)(ctx, { head: local.head, label: options.label })
    console.log(`Release ${pack.id}`)

    step('Uploading it to the VPS (nothing switches yet)')
    const target = `${config.vps.root}/incoming/${pack.id}.tar.gz`
    ctx.upload(pack.archive, target)
    ctx.remote(unpackScript(config, { id: pack.id, archiveSha: pack.archiveSha }))
    done.push('release uploaded')

    step('Database migrations')
    if (gathered.supabase.migrations.pending.length) {
      ctx.supabase(['db', 'push', '--linked', '--skip-vault', '--yes'], { quiet: false })
      const after = checkMigrationList(
        parseMigrationList(ctx.supabase(['migration', 'list', '--linked'])),
        local.migrations,
      )
      if (after.pending.length)
        throw new Error(`Migrations still pending after db push: ${after.pending.join(', ')}`)
      done.push('migrations applied')
    } else console.log('Up to date.')

    step('Edge Functions')
    const groups = local.functionGroups
    if (groups.noVerify.length) {
      ctx.supabase(
        [
          'functions',
          'deploy',
          ...groups.noVerify,
          '--project-ref',
          ref,
          '--no-verify-jwt',
          '--use-api',
        ],
        {
          quiet: false,
        },
      )
    }
    if (groups.verify.length) {
      ctx.supabase(['functions', 'deploy', ...groups.verify, '--project-ref', ref, '--use-api'], {
        quiet: false,
      })
    }
    done.push('functions deployed')

    step('VPS services')
    ctx.remote(servicesScript(config, { id: pack.id, files: pack.files }))
    done.push('VPS files and services')

    step('Dashboard')
    ctx.remote(dashboardScript(config, { id: pack.id, commit: local.head }))
    done.push('dashboard switched')

    step('Recording the release')
    const record = {
      release: pack.id,
      commit: local.head,
      branch: local.branch,
      builtAt: pack.builtAt,
      deployedAt: new Date().toISOString(),
      previousRelease: remote.current,
      previousCommit: plan.live.commit,
      migrations: gathered.supabase.migrations.pending,
      functions: local.functions,
      vpsFilesChanged: plan.changedFiles,
      edge: plan.edge.ok ? 'ready' : 'pending hand merge',
    }
    ctx.remote(recordScript(config, { id: pack.id, record }))

    step('Smoke test')
    const results = await (hooks.smoke ?? smokeTest)(config, local.head)
    for (const result of results)
      console.log(
        `${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? ` (${result.detail})` : ''}`,
      )
    if (!plan.edge.ok) console.log('\nThe edge Caddy still needs the hand merge listed by status.')
    return { id: pack.id, record, smoke: results }
  } catch (error) {
    fail(error)
  }
}

export function rollbackRelease(ctx, remote) {
  const previous = remote.record?.previousRelease
  if (!previous) {
    throw new Error(
      'The live release has no record of the one before it. Switch back by hand (deploy/hostinger/README.md).',
    )
  }
  step(`Back to ${previous}`)
  ctx.remote(
    rollbackScript(ctx.config, {
      previous,
      entry: { rollback: remote.current, to: previous, at: new Date().toISOString() },
    }),
  )
  console.log(
    [
      '',
      'The dashboard and VPS services are back. The database and functions are not rolled back:',
      'migrations only add, and functions keep the newer code until a release of the older commit',
      `(check it out and run apply --allow-older --assume-live ${remote.record.commit.slice(0, 7)}).`,
    ].join('\n'),
  )
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.command || options.command === 'help') {
    console.log(USAGE)
    return
  }
  const repo = resolve(import.meta.dirname, '..')
  const config = loadConfig(resolve(repo, options.config ?? 'deploy/release.config.json'))
  const ctx = makeContext(repo, config)

  if (options.command === 'rollback') {
    rollbackRelease(ctx, gatherRemote(ctx))
    return
  }
  const gathered = gatherAll(ctx, options)
  console.log(formatPlan(gathered.plan, gathered.local))
  if (options.command === 'status') return
  if (gathered.plan.blockers.length) {
    process.exitCode = 1
    return
  }
  const result = await applyRelease(ctx, options, gathered)
  console.log(
    `\nReleased ${result.id}: commit ${result.record.commit.slice(0, 7)} is live everywhere this tool reaches.`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
