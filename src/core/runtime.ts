import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { systemClock } from './clock'
import type { Core } from './context'
import { get, openDb } from './db'
import { AnthropicModel } from './models/anthropic'
import { MockModel } from './models/mock'
import type { ModelClient } from './models/types'
import { seed } from './seed'

// Runtime path, not a bundled asset: tell Turbopack not to trace it.
export const dbPath = () => resolve(/*turbopackIgnore: true*/ process.env.DB_PATH ?? '.data/demo.db')

/** CONFIRM_SECRET from the environment, else a random secret persisted to .data/confirm.secret (0600). */
export function loadSecret(): Buffer {
  const fromEnv = process.env.CONFIRM_SECRET
  if (fromEnv) {
    if (Buffer.byteLength(fromEnv) < 32) throw new Error('CONFIRM_SECRET must be at least 32 bytes')
    return Buffer.from(fromEnv)
  }
  const file = resolve(/*turbopackIgnore: true*/ dirname(dbPath()), 'confirm.secret')
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return Buffer.from(readFileSync(file, 'utf8').trim())
}

let core: Core | undefined

/** Process-wide core for the web app, the MCP server and the CLI. Seeds an empty database once. */
export function getCore(): Core {
  if (core) return core
  const path = dbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = openDb(path)
  if (!get(db, 'SELECT 1 FROM users LIMIT 1')) seed(db, systemClock)
  core = { db, clock: systemClock, secret: loadSecret() }
  return core
}

export type AgentMode = 'mock' | 'anthropic'

export function agentMode(): AgentMode {
  const m = process.env.AGENT_MODE
  if (m === 'mock' || m === 'anthropic') return m
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock'
}

/** In the web demo the mock is adversarial by default (MOCK_ADVERSARIAL=0 turns it off). */
export function createModel(opts: { web?: boolean } = {}): ModelClient {
  if (agentMode() === 'anthropic') return new AnthropicModel()
  const adversarial = (process.env.MOCK_ADVERSARIAL ?? (opts.web ? '1' : '0')) === '1'
  return new MockModel({ adversarial, delayMs: opts.web ? 12 : 0 })
}
