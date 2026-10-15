import type { Channel } from './audit'
import type { Clock } from './clock'
import type { Db } from './db'

/** Everything the core needs. Web, MCP, CLI and evals each build one of these. */
export interface Core {
  db: Db
  clock: Clock
  /** HMAC key for confirmation tokens. Never sent to the model. */
  secret: Buffer
}

/** A core plus the authenticated human. The actor comes from the session, never from model output. */
export interface Ctx extends Core {
  actorId: string
  channel: Channel
}
