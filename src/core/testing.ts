import { FixedClock } from './clock'
import type { Channel } from './audit'
import type { Core, Ctx } from './context'
import { openDb } from './db'
import { seed } from './seed'

export const SEED_TIME = '2026-10-01T09:00:00.000Z'

/** Fresh in-memory database with seed data and a fixed clock. Used by unit tests and evals. */
export function createTestCore(): Core & { clock: FixedClock } {
  const clock = new FixedClock(SEED_TIME)
  const db = openDb(':memory:')
  seed(db, clock)
  return { db, clock, secret: Buffer.from('test-secret-'.padEnd(48, 'x')) }
}

export const as = (core: Core, actorId: string, channel: Channel = 'web'): Ctx => ({ ...core, actorId, channel })
