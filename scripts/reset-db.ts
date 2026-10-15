import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { systemClock } from '../src/core/clock'
import { openDb } from '../src/core/db'
import { dbPath, loadSecret } from '../src/core/runtime'
import { seed } from '../src/core/seed'

const path = dbPath()
mkdirSync(dirname(path), { recursive: true })
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
loadSecret() // creates .data/confirm.secret on first run unless CONFIRM_SECRET is set
const db = openDb(path)
seed(db, systemClock)
db.close()
console.log(`Seeded ${path}`)
