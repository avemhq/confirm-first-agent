import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArgsError, parseArgs } from '../mcp/args'
import { loadEnvFrom } from '../scripts/env'
import { chatHistory } from '@/app/components/stream'
import { run } from '@/core/db'
import { listPending } from '@/core/proposals'
import { as, createTestCore } from '@/core/testing'
import { executeTool, type UiEvent } from '@/core/tools'
import { isSafeLine } from '@/core/untrusted'

const RLO = String.fromCharCode(0x202e)
const tsx = resolve('node_modules/tsx/dist/cli.mjs')
const runScript = (script: string, args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [tsx, resolve(script), ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 })

describe('env files load like Next.js (review r2, F1)', () => {
  const keys = ['CFA_T_ROOT', 'CFA_T_DB', 'CFA_T_MODE', 'CFA_T_LOCAL']
  afterEach(() => keys.forEach((k) => delete process.env[k]))

  it('expands $VAR, reads the development files and lets .env.local win over .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-env-'))
    try {
      writeFileSync(join(dir, '.env'), 'CFA_T_ROOT=.data\nCFA_T_DB=$CFA_T_ROOT/probe.db\nCFA_T_LOCAL=from-env\n')
      writeFileSync(join(dir, '.env.local'), 'CFA_T_LOCAL=from-local\n')
      writeFileSync(join(dir, '.env.development'), 'CFA_T_MODE=development\n')
      // Next.js switches to the test files when NODE_ENV=test (vitest sets it); the CLI tools run without it.
      const nodeEnv = process.env.NODE_ENV
      ;(process.env as Record<string, string | undefined>).NODE_ENV = 'development'
      try {
        loadEnvFrom(dir, true)
      } finally {
        ;(process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv
      }
      expect(process.env.CFA_T_DB).toBe('.data/probe.db')
      expect(process.env.CFA_T_MODE).toBe('development')
      expect(process.env.CFA_T_LOCAL).toBe('from-local')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('strict command lines (review r2, F2)', () => {
  it('parseArgs refuses empty and repeated values', () => {
    expect(() => parseArgs(['--user', 'bob', '--db', ''], ['user', 'db'])).toThrow(ArgsError)
    expect(() => parseArgs(['--db', 'a.db', '--db', 'b.db'], ['db'])).toThrow(ArgsError)
  })

  it('db:reset refuses any argument before deleting anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-r2-'))
    try {
      const db = join(dir, 'default.db')
      writeFileSync(db, 'existing')
      const r = runScript('scripts/reset-db.ts', ['--db', join(dir, 'requested.db')], { DB_PATH: db, CONFIRM_SECRET: 'r'.repeat(40) })
      expect(r.status).toBe(2)
      expect(readFileSync(db, 'utf8')).toBe('existing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('audit:verify and the eval runner refuse unknown arguments', () => {
    expect(runScript('scripts/audit-verify.ts', ['--db', 'x.db'], { DB_PATH: join(tmpdir(), 'cfa-none.db') }).status).toBe(2)
    expect(runScript('evals/run.ts', ['--liv'], {}).status).toBe(2)
  })
})

describe('confirmation views escape stored text (review r2, F3)', () => {
  it('a stored task title with a bidi override reaches no confirmation view raw', () => {
    const core = createTestCore()
    run(core.db, 'UPDATE tasks SET title = ? WHERE id = ?', `Invoice ${RLO}fdp.exe`, 'T-3')
    const bob = as(core, 'bob')
    const status = executeTool(bob, 'propose_update_task_status', { taskId: 'T-3', status: 'done', reason: 'Finished.' })
    const assign = executeTool(as(core, 'alice'), 'propose_assign_task', { taskId: 'T-3', assigneeId: 'alice', reason: 'Take over.' })
    for (const out of [status, assign]) {
      expect(out.isError).toBe(false)
      const view = out.ui.find((e): e is Extract<UiEvent, { type: 'proposal' }> => e.type === 'proposal')!.proposal
      expect(isSafeLine(view.title)).toBe(true)
      expect(view.title).toContain('\\u{202e}')
    }
    expect(listPending(core, 'bob').every((v) => isSafeLine(v.title))).toBe(true)
  })

  it('rows stored before the input check are escaped on the way out', () => {
    const core = createTestCore()
    executeTool(as(core, 'bob'), 'propose_create_task', { projectId: 'apollo', title: 'Plain', reason: 'Plain reason.' })
    run(core.db, 'UPDATE proposals SET reason = ?, after_json = ?', `ok ${RLO}gnp.exe`, JSON.stringify({ title: `x${RLO}y` }))
    const [v] = listPending(core, 'bob')
    expect(isSafeLine(v!.reason)).toBe(true)
    expect(isSafeLine(String(v!.after.title))).toBe(true)
  })
})

describe('cut results are shown to the human by the server (review r2, F6)', () => {
  it('task and document searches that return fewer than the total push a notice', () => {
    const core = createTestCore()
    const bob = as(core, 'bob')
    const tasks = executeTool(bob, 'search_tasks', { projectId: 'apollo', limit: 1 })
    expect(tasks.ui.some((e) => e.type === 'notice' && /returned 1 of \d+/.test(e.message))).toBe(true)
    const full = executeTool(bob, 'search_tasks', { projectId: 'apollo', limit: 50 })
    expect(full.ui.some((e) => e.type === 'notice')).toBe(false)
  })

  it('the report states how many confirmed changes it lists out of how many', () => {
    const core = createTestCore()
    const out = executeTool(as(core, 'bob'), 'project_report_data', { projectId: 'apollo' })
    expect((out.modelResult as { recentChangesNote: string }).recentChangesNote).toMatch(/^latest \d+ of \d+ confirmed changes$/)
  })

  it('the chat says when older or long messages are left out of the context', () => {
    const turns = Array.from({ length: 25 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `m${i}` }))
    const a = chatHistory(turns)
    expect(a.history).toHaveLength(20)
    expect(a.cut).toBe('Context for this answer: 5 older messages not sent.')
    const b = chatHistory([{ role: 'user', text: 'x'.repeat(4001) }])
    expect(b.history[0]!.text).toHaveLength(4000)
    expect(b.cut).toBe('Context for this answer: 1 long message shortened to 4000 characters.')
    expect(chatHistory([{ role: 'user', text: 'hi' }]).cut).toBeNull()
  })
})

describe('project descriptions are untrusted data (review r2, F8)', () => {
  it('list_projects wraps descriptions', () => {
    const core = createTestCore()
    const out = executeTool(as(core, 'bob'), 'list_projects', {})
    const items = out.modelResult as { description: string }[]
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((p) => p.description.startsWith('<untrusted_data source="project:'))).toBe(true)
  })
})
