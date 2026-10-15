import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTurn } from '@/core/agent'
import { FixedClock } from '@/core/clock'
import { all, enableWal, get, openDb, run, type Db } from '@/core/db'
import type { AgentEvent, Block, ModelClient, Msg } from '@/core/models/types'
import { FIELD_NAMES, TOOL_NAMES } from '@/core/names'
import { countOpen, listPending } from '@/core/proposals'
import { seedIfEmpty } from '@/core/seed'
import { as, createTestCore, SEED_TIME } from '@/core/testing'
import { executeTool, TOOLS } from '@/core/tools'

describe('first start', () => {
  it('a second process starting later never re-seeds over existing changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-'))
    try {
      const path = join(dir, 'demo.db')
      const clock = new FixedClock(SEED_TIME)
      const a = openDb(path)
      const b = openDb(path)
      expect(seedIfEmpty(a, clock)).toBe(true)
      run(a, "UPDATE tasks SET status = 'done', version = version + 1 WHERE id = 'T-3'")
      expect(seedIfEmpty(b, clock)).toBe(false)
      expect(get<{ status: string }>(b, "SELECT status FROM tasks WHERE id = 'T-3'")?.status).toBe('done')
      a.close()
      b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('first start, two processes', () => {
  it('a process that starts while another is seeding never wipes its committed changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-'))
    try {
      const path = join(dir, 'demo.db')
      const clock = new FixedClock(SEED_TIME)
      const a = openDb(path)
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('test/fixtures/seed-child.ts'), path], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (out += d.toString()))
      const until = (cond: () => boolean) =>
        new Promise<void>((ok) => { const t = setInterval(() => { if (cond()) { clearInterval(t); ok() } }, 20) })
      await until(() => out.includes('opened') || child.exitCode !== null)
      // A seeds and changes T-3 inside one transaction that it has not committed yet...
      a.exec('BEGIN IMMEDIATE')
      expect(seedIfEmpty(a, clock)).toBe(true)
      run(a, "UPDATE tasks SET status = 'done', version = version + 1 WHERE id = 'T-3'")
      // ...while B runs its first-start check. Before the fix B saw "empty" here and re-seeded later.
      child.stdin.write('go\n')
      await new Promise((ok) => setTimeout(ok, 400))
      a.exec('COMMIT')
      const code = await new Promise<number | null>((ok) => (child.exitCode !== null ? ok(child.exitCode) : child.on('close', ok)))
      expect(out).toContain('seeded=false')
      expect(code).toBe(0)
      expect(get<{ status: string }>(a, "SELECT status FROM tasks WHERE id = 'T-3'")?.status).toBe('done')
      a.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('first start, schema', () => {
  it('six processes opening one fresh database at the same moment all start (8 rounds)', async () => {
    const child = resolve('test/fixtures/open-child.ts')
    const failures: string[] = []
    for (let round = 0; round < 8; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'cfa-'))
      try {
        const path = join(dir, 'demo.db')
        const kids = Array.from({ length: 6 }, () => {
          const p = spawn(process.execPath, ['--import', 'tsx', child, path], { stdio: ['pipe', 'pipe', 'pipe'] })
          const k = { p, out: '' }
          p.stdout.on('data', (d: Buffer) => (k.out += d.toString()))
          p.stderr.on('data', (d: Buffer) => (k.out += d.toString()))
          return k
        })
        await Promise.all(
          kids.map((k) => new Promise<void>((ok) => { const t = setInterval(() => { if (k.out.includes('ready') || k.p.exitCode !== null) { clearInterval(t); ok() } }, 5) })),
        )
        for (const k of kids) k.p.stdin.write('go\n')
        await Promise.all(kids.map((k) => new Promise((ok) => (k.p.exitCode !== null ? ok(null) : k.p.on('close', ok)))))
        failures.push(...kids.filter((k) => !k.out.includes('\nok')).map((k) => k.out.trim()))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    expect(failures).toEqual([])
  }, 90_000)
})

describe('WAL switch on a busy file', () => {
  it('retries "database is locked" instead of failing the start', () => {
    let calls = 0
    const fake = {
      exec: () => {
        calls++
        if (calls <= 2) throw new Error('database is locked')
      },
      close: () => {},
    } as unknown as Db
    expect(() => enableWal(fake)).not.toThrow()
    expect(calls).toBe(3)
  })

  it('does not hide other errors', () => {
    const fake = { exec: () => { throw new Error('disk I/O error') }, close: () => {} } as unknown as Db
    expect(() => enableWal(fake)).toThrow('disk I/O error')
  })
})

describe('audit rows without a project carry no model-chosen text', () => {
  it('drops unknown tool names, unknown argument names and raw validation text', () => {
    const core = createTestCore()
    const ctx = as(core, 'bob')
    const marker = 'budgetceilingmarker'
    executeTool(ctx, `leak_${marker}`, { [marker]: 'x', taskId: 'T-1' })
    executeTool(ctx, 'get_task', { taskId: 'T-1', [marker]: 1 })
    executeTool(ctx, 'list_projects', { [marker]: true })
    const rows = all(core.db, 'SELECT * FROM audit_log WHERE project_id IS NULL')
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(rows)).not.toContain(marker)
    const unknown = rows.find((r) => r.event === 'unknown_tool')
    expect(unknown?.tool).toBe('(unknown)')
    expect(JSON.parse(String(unknown?.args_json))).toEqual({ _keys: ['taskId'], _unknownKeys: 1 })
  })

  it('the name lists match the tool registry exactly', () => {
    expect([...TOOL_NAMES].sort()).toEqual(TOOLS.map((t) => t.name).sort())
    const fields = new Set(TOOLS.flatMap((t) => Object.keys(t.schema.shape)))
    expect([...FIELD_NAMES].sort()).toEqual([...fields].sort())
  })
})

describe('pending list', () => {
  it('revoked proposals do not push valid ones out of the list', () => {
    const core = createTestCore()
    const bob = as(core, 'bob', 'mcp')
    for (let i = 0; i < 10; i++) {
      const r = executeTool(bob, 'propose_create_task', { projectId: 'apollo', title: `Apollo task ${i}`, reason: 'Fill the queue.' })
      expect(r.isError).toBe(false)
    }
    run(core.db, "DELETE FROM memberships WHERE user_id = 'bob' AND project_id = 'apollo'")
    run(core.db, "UPDATE memberships SET role = 'member' WHERE user_id = 'bob' AND project_id = 'borealis'")
    const r = executeTool(bob, 'propose_create_task', { projectId: 'borealis', title: 'Borealis task', reason: 'Still allowed here.' })
    expect(r.isError).toBe(false)
    expect(countOpen(core, 'bob')).toBe(1)
    const pending = listPending(core, 'bob')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.title).toContain('Borealis task')
  })
})

describe('agent loop boundaries', () => {
  it('the confirmation token never reaches the model, in any message the model receives', async () => {
    const core = createTestCore()
    const seen: Msg[][] = []
    let step = 0
    const model: ModelClient = {
      label: 'probe',
      stream: async (req) => {
        seen.push(structuredClone(req.messages))
        if (step++ === 0) {
          const call: Block = { type: 'tool_use', id: 'c1', name: 'propose_update_task_status', input: { taskId: 'T-3', status: 'done', reason: 'Probe the boundary.' } }
          return { content: [call], stopReason: 'tool_use' }
        }
        return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
      },
    }
    const events: AgentEvent[] = []
    await runTurn({ ctx: as(core, 'bob'), model, history: [{ role: 'user', text: 'Mark T-3 as done' }], emit: (e) => events.push(e) })
    const proposal = events.find((e) => e.type === 'proposal')
    expect(proposal?.type).toBe('proposal')
    const token = proposal?.type === 'proposal' ? proposal.proposal.token : undefined
    expect(token).toBeTruthy()
    expect(seen).toHaveLength(2)
    const toModel = JSON.stringify(seen)
    expect(toModel).not.toContain(String(token))
    expect(toModel).not.toContain(String(token).split('.')[2])
  })

  it('an abort during the answer stops the tool calls of that answer', async () => {
    const core = createTestCore()
    const ac = new AbortController()
    const model: ModelClient = {
      label: 'aborting',
      stream: async () => {
        ac.abort() // the client goes away while the answer streams
        return {
          content: [{ type: 'tool_use', id: 'c1', name: 'propose_update_task_status', input: { taskId: 'T-3', status: 'done', reason: 'Should never run.' } }],
          stopReason: 'tool_use',
        }
      },
    }
    await runTurn({ ctx: as(core, 'bob'), model, history: [{ role: 'user', text: 'Mark T-3 as done' }], emit: () => {}, signal: ac.signal })
    expect(all(core.db, 'SELECT id FROM proposals')).toHaveLength(0)
  })
})
