import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const caddy = read('deploy/hostinger/Caddyfile.kissmyapps')
const vercel = JSON.parse(read('deploy/tracking-gateway/vercel.json'))
const upstream = 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/tracking-redirect'
const pretty = caddy.match(/path_regexp pretty_get (\S+)/)?.[1]
const route = new RegExp(pretty, 'u')

test('Caddy routes readable Unicode aliases and rejects malformed path structure', () => {
  assert.ok(pretty)
  for (const path of [
    '/speaksix/victory-onorhime',
    '/speaksix/victory-onorhime/instagram',
    '/английский/алексей',
    '/英语/小明/课程',
    '/speaksix/فاطمة',
    '/speaksix/zoë',
  ]) {
    const wirePath = new URL(`https://go.kissmyapps.dev${path}`).pathname
    assert.equal(route.test(decodeURIComponent(wirePath)), true, path)
  }
  for (const path of [
    '/',
    '/speaksix',
    '/speaksix/victory/',
    '/speaksix//victory',
    '/speaksix/victory/instagram/extra',
    '/speaksix/-victory',
    '/speaksix/victory--name',
    '/speaksix/name%2Fother',
    '/speaksix/name@example.com',
    '/speaksix/😀',
  ])
    assert.equal(route.test(path), false, path)
  assert.match(caddy, /path_regexp pretty_method ([^\n]+)/)
  assert.equal(caddy.match(/path_regexp pretty_method (\S+)/)?.[1], pretty)
  assert.equal((caddy.match(/not path \/r\/\* \/tracking-redirect\/\*/g) ?? []).length, 2)
  assert.match(
    caddy,
    /@prettyWrongMethod \{[\s\S]*?not method GET[\s\S]*?respond @prettyWrongMethod "Method not allowed" 405/,
  )
  assert.match(caddy, /@prettyTracking \{\s+method GET/)
})

test('Caddy preserves the legacy route first and never adds another upstream', () => {
  assert.ok(caddy.indexOf('handle @tracking') < caddy.indexOf('handle @prettyTracking'))
  assert.match(caddy, /@wrongMethod \{\s+path \/r\/\*\s+not method GET/)
  assert.match(caddy, /@tracking \{\s+method GET\s+path \/r\/\*/)
  assert.equal(
    (caddy.match(/rewrite \* \/functions\/v1\/tracking-redirect\{uri\}/g) ?? []).length,
    2,
  )
  assert.equal(
    (caddy.match(/reverse_proxy https:\/\/mmyruzjemjecqyivhrgr.supabase.co/g) ?? []).length,
    2,
  )
  assert.match(caddy, /respond "Not found" 404/)
  assert.match(caddy, /Cache-Control "no-store, max-age=0"/)
  const production = read('deploy/hostinger/Caddyfile.production')
  assert.equal(
    production.slice(production.indexOf('go.kissmyapps.dev {')).trim(),
    caddy.slice(caddy.indexOf('go.kissmyapps.dev {')).trim(),
  )
})

function rewrite(path) {
  for (const entry of vercel.rewrites) {
    const names = []
    const pattern = entry.source.replace(/:([a-z]+)(\*)?/g, (_, name, wildcard) => {
      names.push(name)
      return wildcard ? '(.+)' : '([^/]+)'
    })
    const match = new RegExp(`^${pattern}$`).exec(path)
    if (!match) continue
    return entry.destination.replace(/:([a-z]+)\*?/g, (_, name) => match[names.indexOf(name) + 1])
  }
  return null
}

test('Vercel keeps original codes and encoded Unicode paths intact for upstream validation', () => {
  assert.equal(vercel.rewrites[0].source, '/r/:path*')
  const paths = [
    '/r/partner-one/abcdefghijklmnop',
    '/speaksix/victory-onorhime',
    '/speaksix/victory-onorhime/instagram',
    new URL('https://go.kissmyapps.dev/英语/小明').pathname,
    new URL('https://go.kissmyapps.dev/speaksix/фёдор/видео').pathname,
  ]
  for (const path of paths) assert.equal(rewrite(path), upstream + path)
  assert.equal(rewrite('/speaksix'), null)
  assert.equal(rewrite('/speaksix/creator/variant/extra'), null)
  for (const entry of vercel.rewrites) {
    assert.ok(entry.destination.startsWith(upstream + '/'))
    const headers = vercel.headers.find((value) => value.source === entry.source)?.headers
    assert.ok(headers)
    assert.equal(
      headers.find((value) => value.key === 'Cache-Control')?.value,
      'no-store, max-age=0',
    )
    assert.equal(
      headers.find((value) => value.key === 'X-Robots-Tag')?.value,
      'noindex, nofollow, noarchive',
    )
  }
})
