// One of several processes opening the same fresh database at once (schema race test).
import { openDb } from '../../src/core/db'

try {
  openDb(process.argv[2]!).close()
  process.stdout.write('ok\n')
} catch (e) {
  process.stdout.write(`FAIL ${(e as Error).message}\n`)
}
