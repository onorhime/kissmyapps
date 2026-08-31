// Rebuild the five fictional, immutable statement assets from the same snapshot
// used by the UI and CSV exports. Requires Node type stripping and reportlab.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { payoutDetails, statementPdfPath } from '../src/features/partner/payoutData.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const records = payoutDetails
  .filter((payout) => statementPdfPath(payout))
  .map((payout) => ({
    payout,
    fingerprint: createHash('sha256').update(JSON.stringify(payout)).digest('hex'),
  }))
const result = spawnSync(
  process.argv[2] ?? 'python3',
  [resolve(root, 'scripts/render-preview-statements.py'), resolve(root, 'public/statements')],
  { input: JSON.stringify(records), encoding: 'utf8' },
)
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
