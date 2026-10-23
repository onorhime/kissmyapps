/** Local-only merchant invitation acceptance: real Edge handler + SQL, synthetic mail.
 * Never reads application credentials or contacts an external email/Stripe service.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCrossAppFixture, kmaRoot } from './managed-checkout-crossapp-fixture.mjs'

const secret = randomBytes(32).toString('hex')
let fixture
let server
let child
try {
  fixture = await createCrossAppFixture({ privateStatements: true })
  server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST' || req.headers['x-fixture-control'] !== secret) {
      reply(403, { error: 'Local fixture authorization required.' })
      return
    }
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 128000) throw Error('Fixture request too large')
      }
      const input = JSON.parse(body)
      if (req.url === '/rpc') {
        reply(200, await fixture.rpc('kma', input.name, input.args, input.admin === true))
      } else if (req.url === '/sql') {
        reply(200, { result: await fixture.sql('kma', input.sql) })
      } else reply(404, { error: 'Unknown fixture operation.' })
    } catch {
      reply(500, { error: 'The isolated database operation failed.' })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  child = spawn(
    '/opt/homebrew/bin/deno',
    [
      'run', '--cached-only', '--allow-env', '--allow-net=127.0.0.1',
      '--config', 'supabase/functions/deno.json',
      'scripts/merchant-invitation-email-acceptance.ts',
    ],
    {
      cwd: kmaRoot,
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        HOME: process.env.HOME,
        MERCHANT_MAIL_ACCEPTANCE_ORIGIN: origin,
        MERCHANT_MAIL_ACCEPTANCE_SECRET: secret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  let errors = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { errors += chunk })
  const timeout = setTimeout(() => child?.kill('SIGTERM'), 120000)
  const [code] = await once(child, 'exit')
  clearTimeout(timeout)
  if (code !== 0) throw Error(`Local invitation acceptance failed: ${errors.slice(-5000)}`)
  const result = JSON.parse(output.trim().split('\n').at(-1))
  const evidence = join(fixture.directory, 'merchant-invitation-email-acceptance.json')
  await writeFile(evidence, JSON.stringify({ ...result, hostedWrites: false, externalMail: false }, null, 2))
  console.log(JSON.stringify({ ...result, evidence }))
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM')
  if (server) await new Promise((resolve) => server.close(resolve))
  await fixture?.stop()
}
