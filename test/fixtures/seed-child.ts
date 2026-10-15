// Second process of the first-start race test: opens the same file and runs the first-start seed.
import { FixedClock } from '../../src/core/clock'
import { openDb } from '../../src/core/db'
import { seedIfEmpty } from '../../src/core/seed'

const db = openDb(process.argv[2]!)
process.stdout.write('opened\n')
const seeded = seedIfEmpty(db, new FixedClock('2026-10-01T09:00:00.000Z'))
process.stdout.write(`seeded=${seeded}\n`)
db.close()
