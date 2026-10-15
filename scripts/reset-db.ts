import './load-env'
import { noArgsOrExit } from '../mcp/args'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { systemClock } from '../src/core/clock'
import { openDb } from '../src/core/db'
import { dbPath, loadSecret } from '../src/core/runtime'
import { seed } from '../src/core/seed'

// No flags: the target is DB_PATH (or .data/demo.db). Anything on the command line is refused before
// anything is deleted, so `--db other.db` cannot be silently ignored while the default is reset.
noArgsOrExit(process.argv.slice(2), 'DB_PATH=<path> npm run db:reset')
const path = dbPath()
// Check the secret BEFORE deleting anything: a bad CONFIRM_SECRET must not cost the database.
// (Also creates .data/confirm.secret on first run unless CONFIRM_SECRET is set.)
loadSecret()
mkdirSync(dirname(path), { recursive: true })
// Demo data only. Stop `npm run dev` / `npm start` and any MCP server first: a running process keeps
// its open handle to the deleted file and would not see the new database.
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
const db = openDb(path)
seed(db, systemClock)
db.close()
console.log(`Seeded ${path}`)
