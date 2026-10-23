/** Private local launcher. Does not print keys or put credentials in argv/env. */
import { readFileSync, lstatSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { validateTestCredentials } from './creator-connect-browser-policy.mjs'

const root = resolve(import.meta.dirname, '..')
const resumeArgs = process.argv.slice(2)
if (
  resumeArgs.length !== 0 &&
  (resumeArgs.length !== 4 ||
    resumeArgs[0] !== '--resume-fixture' ||
    !/^\/tmp\/kma-creator-browser\.[A-Za-z0-9]+$/.test(resumeArgs[1]) ||
    resumeArgs[2] !== '--expected-account' ||
    !/^acct_[A-Za-z0-9]+$/.test(resumeArgs[3]))
) throw Error('Use --resume-fixture /tmp/kma-creator-browser.ID --expected-account acct_ID, or no flags.')
const file = resolve(root, '.env.stripe-test.local')
let credentials
try {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw Error()
  const values = parseEnv(readFileSync(file, 'utf8'))
  credentials = validateTestCredentials({
    secretKey: values.KMA_REAL_TEST_STRIPE_SECRET_KEY,
    publishableKey: values.KMA_REAL_TEST_STRIPE_PUBLISHABLE_KEY,
    platformAccountId: values.KMA_REAL_TEST_STRIPE_ACCOUNT_ID,
  })
} catch {
  throw Error(
    'Add the verified KMA Stripe TEST key pair and account ID to the private .env.stripe-test.local file first. No provider call was made.',
  )
}
const child = spawn(
  process.execPath,
  ['scripts/creator-connect-browser-local.mjs', '--stripe-test', ...resumeArgs],
  {
    cwd: root,
    env: { PATH: process.env.PATH, USER: process.env.USER, LC_ALL: 'C', LANG: 'C' },
    stdio: ['pipe', 'inherit', 'inherit'],
  },
)
child.stdin.end(JSON.stringify(credentials))
credentials = null
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
