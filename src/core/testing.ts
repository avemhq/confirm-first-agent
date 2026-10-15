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

/** The three other spellings of the MAC's last base64url character (same 6 bits minus the 2 spare ones). */
export function spareBitVariants(token: string): string[] {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const i = A.indexOf(token.slice(-1))
  return [0, 1, 2, 3].filter((k) => k !== (i & 3)).map((k) => token.slice(0, -1) + A[(i & ~3) | k])
}
