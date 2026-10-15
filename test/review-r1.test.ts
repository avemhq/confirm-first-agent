/** Regression tests for the findings of external review round 1. Each test fails on the old code. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArgsError, parseArgs } from '../mcp/args'
import { runTurn } from '@/core/agent'
import { get, run } from '@/core/db'
import { MockModel } from '@/core/models/mock'
import { confirm, countOpen, listPending, verifyToken } from '@/core/proposals'
import { as, createTestCore, spareBitVariants } from '@/core/testing'
import { executeTool } from '@/core/tools'
import { isSafeLine, isSafeText, visible } from '@/core/untrusted'
import { RateLimiter } from '@/server/rate-limit'
import { sameOriginHeaders, SESSION_SECONDS, signSession, verifySession } from '@/server/session-core'

const ESC = String.fromCharCode(0x1b)
const RLO = String.fromCharCode(0x202e)

function proposeT3() {
  const core = createTestCore()
  const out = executeTool(as(core, 'bob'), 'propose_update_task_status', { taskId: 'T-3', status: 'done', reason: 'Review round 1.' })
  const ev = out.ui.find((e) => e.type === 'proposal')
  if (!ev || ev.type !== 'proposal') throw new Error('no proposal')
  const t = (id: string) => get<{ status: string; version: number }>(core.db, 'SELECT status, version FROM tasks WHERE id = ?', id)!
  return { core, p: ev.proposal, t }
}

describe('token is bound to the whole operation (finding 3)', () => {
  const swaps: [string, string][] = [
    ['target', "UPDATE proposals SET target_id = 'T-9' WHERE id = ?"],
    ['project', "UPDATE proposals SET project_id = 'borealis' WHERE id = ?"],
    ['tool', "UPDATE proposals SET tool = 'propose_assign_task' WHERE id = ?"],
    ['diff', `UPDATE proposals SET after_json = '{"status":"todo"}' WHERE id = ?`],
    ['before', `UPDATE proposals SET before_json = '{"status":"blocked"}' WHERE id = ?`],
    ['title', "UPDATE proposals SET title = 'Harmless' WHERE id = ?"],
    ['reason', "UPDATE proposals SET reason = 'Approved by the CEO.' WHERE id = ?"],
    ['base version', 'UPDATE proposals SET base_version = 7 WHERE id = ?'],
  ]
  for (const [what, sql] of swaps) {
    it(`a stored ${what} changed after issuing invalidates the token`, () => {
      const { core, p, t } = proposeT3()
      run(core.db, sql, p.id)
      expect(confirm(core, { proposalId: p.id, token: p.token, userId: 'bob', channel: 'web' }).status).toBe(401)
      expect(t('T-3')).toEqual({ status: 'in_progress', version: 1 })
      expect(t('T-9').status).toBe('blocked')
    })
  }

  it('accepts exactly one encoding of the MAC', () => {
    const { core, p } = proposeT3()
    expect(verifyToken(core.secret, p.token).ok).toBe(true)
    expect(verifyToken(core.secret, `${p.token}=`).ok).toBe(false)
    expect(verifyToken(core.secret, `${p.token}A`).ok).toBe(false)
    // Same 256 bits, different spare bits in the last character (RFC 4648 3.5): all refused.
    const others = spareBitVariants(p.token!)
    expect(others).toHaveLength(3)
    expect(others.map((t) => Buffer.from(t.split('.')[2]!, 'base64url').equals(Buffer.from(p.token!.split('.')[2]!, 'base64url')))).toEqual([true, true, true])
    expect(others.map((t) => verifyToken(core.secret, t).ok)).toEqual([false, false, false])
  })
})

describe('control and bidi characters (finding 4)', () => {
  it('are refused in reasons, titles, descriptions and report bodies', () => {
    const core = createTestCore()
    const bob = as(core, 'bob')
    const outs = [
      executeTool(bob, 'propose_update_task_status', { taskId: 'T-3', status: 'done', reason: `Fine ${ESC}[8mhidden` }),
      executeTool(bob, 'propose_update_task_status', { taskId: 'T-3', status: 'done', reason: 'Line one\rline two' }),
      executeTool(bob, 'propose_create_task', { projectId: 'apollo', title: `Invoice ${RLO}fdp.exe`, reason: 'Bidi in the title.' }),
      executeTool(bob, 'propose_create_task', { projectId: 'apollo', title: 'Plain title', description: `a${ESC}[2Jb`, reason: 'Clear screen in body.' }),
      executeTool(bob, 'propose_save_report', { projectId: 'apollo', title: 'Report', body: `Twenty characters ok ${RLO} here`, reason: 'Bidi in a report.' }),
    ]
    expect(outs.map((o) => (o.modelResult as { error?: string }).error)).toEqual(Array(5).fill('invalid_input'))
    expect(countOpen(core, 'bob')).toBe(0)
  })

  it('newlines and tabs stay allowed in multi-line fields', () => {
    const core = createTestCore()
    const ok = executeTool(as(core, 'bob'), 'propose_create_task', { projectId: 'apollo', title: 'Two lines', description: 'one\n\ttwo', reason: 'Multi-line is fine.' })
    expect(ok.isError).toBe(false)
    expect(isSafeText('a\nb\tc')).toBe(true)
    expect(isSafeLine('a\nb')).toBe(false)
  })

  it('the terminal view escapes them visibly', () => {
    expect(visible(`x${ESC}[8my${RLO}z\r`)).toBe('x\\u{1b}[8my\\u{202e}z\\u{d}')
  })
})

describe('open-proposal cap across revoke and restore (finding 6)', () => {
  it('revoked proposals are closed for good, so restoring the role cannot exceed the cap', () => {
    const core = createTestCore()
    const bob = as(core, 'bob', 'mcp')
    for (let i = 0; i < 10; i++) executeTool(bob, 'propose_create_task', { projectId: 'apollo', title: `A ${i}`, reason: 'Fill the queue.' })
    run(core.db, "DELETE FROM memberships WHERE user_id = 'bob' AND project_id = 'apollo'")
    run(core.db, "UPDATE memberships SET role = 'member' WHERE user_id = 'bob' AND project_id = 'borealis'")
    for (let i = 0; i < 10; i++) executeTool(bob, 'propose_create_task', { projectId: 'borealis', title: `B ${i}`, reason: 'Fill again.' })
    run(core.db, "INSERT INTO memberships (user_id, project_id, role) VALUES ('bob', 'apollo', 'member')")
    expect(countOpen(core, 'bob')).toBe(10)
    expect(listPending(core, 'bob')).toHaveLength(10)
    expect(get<{ n: number }>(core.db, "SELECT COUNT(*) AS n FROM proposals WHERE status = 'expired'")?.n).toBe(10)
  })
})

describe('mock model: "open" means not done (finding 7)', () => {
  it('lists open Apollo tasks without done ones and with the real total', async () => {
    const core = createTestCore()
    const { text } = await runTurn({ ctx: as(core, 'bob'), model: new MockModel(), history: [{ role: 'user', text: 'Which tasks in Apollo are open?' }], emit: () => {} })
    expect(text).not.toMatch(/\bT-1\b/)
    for (const id of ['T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7']) expect(text).toMatch(new RegExp(`\\b${id}\\b`))
    expect(text).toContain('Found 6')
  })

  it('says when the list is cut off', async () => {
    const core = createTestCore()
    for (let i = 0; i < 25; i++) {
      run(core.db, "INSERT INTO tasks (id, project_id, title, status, updated_at) VALUES (?, 'apollo', ?, 'todo', '2026-10-01')", `T-${100 + i}`, `Extra ${i}`)
    }
    const { text } = await runTurn({ ctx: as(core, 'bob'), model: new MockModel(), history: [{ role: 'user', text: 'Which tasks in Apollo are open?' }], emit: () => {} })
    expect(text).toContain('Found 31, showing 20')
    expect(text).toContain('Showing 20 of 31')
  })

  it('search_tasks reports truncation', () => {
    const core = createTestCore()
    const r = executeTool(as(core, 'alice'), 'search_tasks', { openOnly: true, limit: 2 }).modelResult as { total: number; truncated?: string }
    expect(r.total).toBeGreaterThan(2)
    expect(r.truncated).toContain('Showing 2')
  })
})

describe('CLI arguments (finding 5)', () => {
  it('rejects unknown flags and flags without a value', () => {
    expect(() => parseArgs(['--dbpath', 'x'], ['user', 'db'])).toThrow(ArgsError)
    expect(() => parseArgs(['--user'], ['user', 'db'])).toThrow(ArgsError)
    expect(() => parseArgs(['--user', '--db', 'x'], ['user', 'db'])).toThrow(ArgsError)
    expect(parseArgs(['P-1', '--user', 'bob', '--db', 'x.db'], ['user', 'db'])).toEqual({ flags: { user: 'bob', db: 'x.db' }, positional: ['P-1'] })
  })
})

describe('scripts (findings 1 and 5)', () => {
  const tsx = resolve('node_modules/tsx/dist/cli.mjs')
  const runScript = (script: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [tsx, resolve(script)], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 })

  it('audit:verify on a missing database fails and creates nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-r1-'))
    try {
      const db = join(dir, 'typo.db')
      const r = runScript('scripts/audit-verify.ts', { DB_PATH: db, CONFIRM_SECRET: 'v'.repeat(40) })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain(db)
      expect(existsSync(db)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('db:reset with a bad secret keeps the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-r1-'))
    try {
      const db = join(dir, 'keep.db')
      writeFileSync(db, 'existing')
      writeFileSync(`${db}-wal`, 'wal')
      const r = runScript('scripts/reset-db.ts', { DB_PATH: db, CONFIRM_SECRET: 'short' })
      expect(r.status).not.toBe(0)
      // Untouched, not merely present: same content, and the journal next to it is still there.
      expect(readFileSync(db, 'utf8')).toBe('existing')
      expect(readFileSync(`${db}-wal`, 'utf8')).toBe('wal')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('web session and origin (cold review findings 3 and 5)', () => {
  const secret = Buffer.from('s'.repeat(48))
  const now = 1_800_000_000

  it('session cookies expire server-side and cannot be re-labelled', () => {
    const c = signSession(secret, 'bob', now)
    expect(verifySession(secret, c, now + 10)).toBe('bob')
    expect(verifySession(secret, c, now + SESSION_SECONDS)).toBeNull()
    expect(verifySession(secret, c.replace(/^bob\./, 'alice.'), now)).toBeNull()
    const [u, , sig] = c.split('.')
    expect(verifySession(secret, `${u}.${now + 10 * SESSION_SECONDS}.${sig}`, now)).toBeNull()
    expect(verifySession(secret, `bob.${sig}`, now)).toBeNull()
  })

  it('X-Forwarded-Host counts only with TRUST_PROXY', () => {
    const spoofed = new Headers({ origin: 'https://evil.example', host: 'demo.local', 'x-forwarded-host': 'evil.example' })
    expect(sameOriginHeaders(spoofed, false)).toBe(false)
    expect(sameOriginHeaders(spoofed, true)).toBe(true)
    expect(sameOriginHeaders(new Headers({ origin: 'http://demo.local', host: 'demo.local' }), false)).toBe(true)
  })

  it('the chat rate limiter blocks after the limit and frees after the window', () => {
    const l = new RateLimiter(3, 60_000)
    expect([1, 2, 3, 4].map(() => l.take('bob', 0))).toEqual([true, true, true, false])
    expect(l.take('alice', 0)).toBe(true)
    expect(l.take('bob', 60_001)).toBe(true)
  })
})
