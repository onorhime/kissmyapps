import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { kmaRoot } from './managed-checkout-crossapp-fixture.mjs'
test('synthetic merchant identity cannot invoke admin SQL through the real handler', async () => {
  const configuration = {
    enabled: true,
    key: 'sk_test_fixture123456789',
    platformAccountId: 'acct_platform',
    clientId: 'ca_fixture',
    ...Object.fromEntries(
      ['control', 'admin', 'merchant', 'inbound', 'outbound'].map((k, i) => [
        k,
        String(i + 1).repeat(64),
      ]),
    ),
  }
  const child = spawn(
    'deno',
    [
      'run',
      '--cached-only',
      '--config',
      'supabase/functions/deno.json',
      '--allow-env',
      '--allow-net=127.0.0.1',
      'scripts/merchant-real-bridge.ts',
    ],
    {
      cwd: kmaRoot,
      env: { PATH: process.env.PATH, USER: process.env.USER },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  child.stdin.end(JSON.stringify(configuration))
  let output = '',
    error = ''
  child.stderr.on('data', (chunk) => {
    error += chunk
  })
  try {
    const { port } = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Error('Bridge timed out')), 10000)
      child.stdout.on('data', (chunk) => {
        output += chunk
        const line = output.split('\n').find((v) => v.startsWith('{'))
        if (line) {
          clearTimeout(t)
          resolve(JSON.parse(line))
        }
      })
      child.once('exit', () => {
        clearTimeout(t)
        reject(Error(error))
      })
    })
    const origin = `http://127.0.0.1:${port}`,
      id = 'ac570000-0000-4000-8000-000000000001'
    for (const payload of [
      { action: 'status' },
      {
        action: 'create_invitation',
        request_id: id,
        binding_id: 'merchant-real-test',
        business_name: 'Test merchant',
        email: 'merchant@example.invalid',
      },
      { action: 'assign_product', product_id: id, merchant_id: id, livemode: false },
      { action: 'revoke', merchant_id: id, livemode: false },
    ]) {
      const r = await fetch(origin + '/merchant', {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:5194',
          authorization: `Bearer ${configuration.merchant}`,
          'x-local-control': configuration.control,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      assert.equal(r.status, 403)
      assert.equal((await r.json()).error, 'forbidden')
    }
    const response = await fetch(origin + '/state', {
      method: 'POST',
      headers: { 'x-local-control': configuration.control },
      body: '{}',
    })
    const state = await response.json()
    assert.equal(state.providerReads, 0)
    assert.equal(state.oauthExchanges, 0)
    assert(!output.includes(configuration.key))
    assert(!output.includes(configuration.merchant))
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
})
