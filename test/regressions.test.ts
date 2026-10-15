import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTurn } from '@/core/agent'
import { FixedClock } from '@/core/clock'
import { all, get, openDb, run } from '@/core/db'
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
      // A holds the write lock: it has seeded and changed T-3 but not committed yet.
      a.exec('BEGIN IMMEDIATE')
      expect(seedIfEmpty(a, clock)).toBe(true)
      run(a, "UPDATE tasks SET status = 'done', version = version + 1 WHERE id = 'T-3'")
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('test/fixtures/seed-child.ts'), path], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (out += d.toString()))
      // Let B open the file and reach its first-start check while A still holds the lock.
      await new Promise<void>((ok) => { const t = setInterval(() => { if (out.includes('opened')) { clearInterval(t); setTimeout(ok, 300) } }, 20) })
      a.exec('COMMIT')
      const code = await new Promise<number | null>((ok) => child.on('close', ok))
      expect(out).toContain('seeded=false')
      expect(code).toBe(0)
      expect(get<{ status: string }>(a, "SELECT status FROM tasks WHERE id = 'T-3'")?.status).toBe('done')
      a.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
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
