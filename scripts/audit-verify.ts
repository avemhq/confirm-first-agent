import './load-env'
import { noArgsOrExit } from '../mcp/args'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { verifyChain } from '../src/core/audit'
import { dbPath } from '../src/core/runtime'

// Verify, never create: a missing or mistyped DB_PATH is an error, not an empty "OK" chain.
noArgsOrExit(process.argv.slice(2), 'DB_PATH=<path> npm run audit:verify')
const path = dbPath()
if (!existsSync(path)) {
  console.error(`no database at ${path} (set DB_PATH or run "npm run db:reset")`)
  process.exit(2)
}
let db: DatabaseSync
try {
  db = new DatabaseSync(path, { readOnly: true })
  db.prepare('SELECT 1 FROM audit_log LIMIT 1').all()
} catch (e) {
  console.error(`${path} is not a confirm-first-agent database: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
}
const status = verifyChain(db)
console.log(
  status.ok
    ? `audit chain OK: ${status.rows} rows in ${path}`
    : `audit chain BROKEN at seq ${status.firstBrokenSeq} (${status.rows} rows) in ${path}`,
)
process.exit(status.ok ? 0 : 1)
