import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const previewStatements = resolve(import.meta.dirname, '..', 'dist', 'statements')

rmSync(previewStatements, { recursive: true, force: true })
