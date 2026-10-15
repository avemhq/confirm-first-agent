import { verifyChain } from '../src/core/audit'
import { openDb } from '../src/core/db'
import { dbPath } from '../src/core/runtime'

const status = verifyChain(openDb(dbPath()))
console.log(status.ok ? `audit chain OK (${status.rows} rows)` : `audit chain BROKEN at seq ${status.firstBrokenSeq} (${status.rows} rows)`)
process.exit(status.ok ? 0 : 1)
