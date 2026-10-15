// One of several processes opening the same fresh database at the same moment (first-start test).
// It waits for "go" on stdin so that all processes start opening together.
import { once } from 'node:events'
import { openDb } from '../../src/core/db'

process.stdout.write('ready\n')
await once(process.stdin, 'data')
try {
  openDb(process.argv[2]!).close()
  process.stdout.write('ok\n')
} catch (e) {
  process.stdout.write(`FAIL ${(e as Error).message}\n`)
}
process.exit(0)
