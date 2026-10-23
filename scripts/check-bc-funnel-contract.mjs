// Read-only parity guard. No deployment, credential loading or provider requests.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const target = resolve(process.argv[2] || '../test bclearn funnel/funnel-web')
const files = [
  'browser-attribution.ts',
  'server-events.ts',
  'checkout-contract.ts',
  'checkout-proxy.ts',
]
const digest = (value) => createHash('sha256').update(value).digest('hex')
for (const name of files) {
  assert.equal(
    digest(readFileSync(resolve(target, 'lib/kma', name))),
    digest(readFileSync(resolve('integrations/funnel', name))),
    `SDK drift: ${name}`,
  )
}
for (const [source, name] of [
  ['API_CONTRACT.md', 'funnel-api.md'],
  ['openapi.json', 'openapi.json'],
]) {
  const canonical = digest(readFileSync(resolve('integrations/funnel', source)))
  for (const root of [process.cwd(), target])
    assert.equal(
      digest(readFileSync(resolve(root, 'public/developers/funnels', name))),
      canonical,
      `Published contract drift: ${name}`,
    )
}
const spec = JSON.parse(readFileSync('integrations/funnel/openapi.json', 'utf8'))
assert.equal(spec.info.version, '1.3.0')
for (const route of ['offer', 'checkout', 'status']) {
  assert.ok(spec.paths[`/api/partner/${route}`]?.post)
  assert.match(
    readFileSync(resolve(target, `app/api/partner/${route}/route.ts`), 'utf8'),
    new RegExp(`partnerRoute\\(['"]${route}['"]\\)`),
  )
}
assert.deepEqual(spec.components.schemas.CheckoutInput.required, ['click_id', 'offer_key'])
assert.ok(spec.paths['/browser-events'].post.responses['200'])
assert.ok(spec.paths['/checkout-session'].post.responses['201'])
assert.match(
  readFileSync(resolve(target, 'lib/kma/server.ts'), 'utf8'),
  /KMA_CHECKOUT_ENABLED\s*===\s*['"]true['"]/,
)
console.log(
  'PASS: four SDK files, two published contract copies, and three adapter routes match contract v1.3.',
)
