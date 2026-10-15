import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArgsError, parseArgs } from '../mcp/args'
import { chatHistory } from '@/app/components/stream'
import { all, get, run } from '@/core/db'
import { confirm, listPending, toView, type ProposalRow } from '@/core/proposals'
import { as, createTestCore } from '@/core/testing'
import { executeTool, type UiEvent } from '@/core/tools'
import { isSafeLine } from '@/core/untrusted'

const RLO = String.fromCharCode(0x202e)
const tsx = resolve('node_modules/tsx/dist/cli.mjs')
const runScript = (script: string, args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [tsx, resolve(script), ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 })

describe('env files load like Next.js (review r2 F1, r3 F3)', () => {
  // Each case in its own process: @next/env keeps process-wide state between calls.
  const loadIn = (files: Record<string, string>, nodeEnv: 'development' | 'test') => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-env-'))
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
      const r = spawnSync(
        process.execPath,
        [tsx, '-e', `import('./scripts/env.ts').then((m) => { m.loadEnvFrom(${JSON.stringify(dir)}); console.log(JSON.stringify({ db: process.env.CFA_T_DB, mode: process.env.CFA_T_MODE, local: process.env.CFA_T_LOCAL })) })`],
        { env: { ...process.env, NODE_ENV: nodeEnv }, encoding: 'utf8', timeout: 30_000 },
      )
      return JSON.parse(r.stdout.trim()) as { db?: string; mode?: string; local?: string }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const files = {
    '.env': 'CFA_T_ROOT=.data\nCFA_T_DB=$CFA_T_ROOT/probe.db\nCFA_T_LOCAL=from-env\n',
    '.env.local': 'CFA_T_LOCAL=from-local\n',
    '.env.development': 'CFA_T_MODE=development\n',
    '.env.test': 'CFA_T_MODE=test\n',
  }

  it('expands $VAR, reads the development files and lets .env.local win over .env', () => {
    expect(loadIn(files, 'development')).toEqual({ db: '.data/probe.db', mode: 'development', local: 'from-local' })
  })

  it('with NODE_ENV=test, like Next.js, reads .env.test and skips .env.local', () => {
    expect(loadIn(files, 'test')).toEqual({ db: '.data/probe.db', mode: 'test', local: 'from-env' })
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

  it('audit:verify and the eval runner refuse unknown or repeated arguments', () => {
    expect(runScript('scripts/audit-verify.ts', ['--db', 'x.db'], { DB_PATH: join(tmpdir(), 'cfa-none.db') }).status).toBe(2)
    expect(runScript('evals/run.ts', ['--liv'], {}).status).toBe(2)
    const twice = runScript('evals/run.ts', ['--live', '--live'], { ANTHROPIC_API_KEY: '' })
    expect(twice.status).toBe(2)
    expect(twice.stderr).toContain('--live given twice')
  })

  it('a relative --db is relative to where the command was run, also under npm (review r3, F2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-cwd-'))
    try {
      const probe = (env: Record<string, string>, cwd: string) =>
        spawnSync(process.execPath, [tsx, '-e', "import('./scripts/load-env.ts').then((m) => console.log(m.fromInvocation('probe.db')))"], {
          cwd, env: { ...process.env, npm_lifecycle_event: '', INIT_CWD: '', ...env }, encoding: 'utf8', timeout: 30_000,
        }).stdout.trim()
      const root = resolve('.')
      // npm runs the script from the package directory and passes the caller's directory in INIT_CWD.
      expect(probe({ npm_lifecycle_event: 'confirm', INIT_CWD: dir }, root)).toBe(join(dir, 'probe.db'))
      // Started directly: the process directory counts, an inherited INIT_CWD does not.
      expect(probe({ INIT_CWD: '/somewhere/else' }, root)).toBe(join(root, 'probe.db'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('the display is unambiguous: a real line break and the typed text \\u{a} look different (review r3, F1)', () => {
    const core = createTestCore()
    const bob = as(core, 'bob')
    const mk = (description: string) =>
      executeTool(bob, 'propose_create_task', { projectId: 'apollo', title: 'Same title', description, reason: 'Compare.' })
    const a = mk('line one\nline two')
    const b = mk('line one\\u{a}line two')
    const views = [a, b].map((o) => o.ui.find((e): e is Extract<UiEvent, { type: 'proposal' }> => e.type === 'proposal')!.proposal)
    expect(views[0]!.after.description).toBe('line one\nline two')
    expect(views[1]!.after.description).toBe('line one\\\\u{a}line two')
    expect(views[0]!.after.description).not.toBe(views[1]!.after.description)
    // Terminal view: no real line breaks at all, still distinguishable.
    const rows = all<ProposalRow>(core.db, 'SELECT * FROM proposals ORDER BY created_at, id')
    const term = rows.map((r) => String(toView(r, undefined, { multiline: false }).after.description))
    expect(term.every((t) => !t.includes('\n'))).toBe(true)
    expect(new Set(term).size).toBe(2)
    // What is applied is the raw value, unchanged by the display escaping.
    for (const [i, raw] of ['line one\nline two', 'line one\\u{a}line two'].entries()) {
      const v = views[i]!
      expect(confirm(core, { proposalId: v.id, token: v.token, userId: 'bob', channel: 'web' }).status).toBe(200)
      expect(get<{ n: number }>(core.db, 'SELECT COUNT(*) AS n FROM tasks WHERE description = ?', raw)!.n).toBe(1)
    }
  })

  it('rows stored before the input check are escaped on the way out', () => {
    const core = createTestCore()
    executeTool(as(core, 'bob'), 'propose_create_task', { projectId: 'apollo', title: 'Plain', reason: 'Plain reason.' })
    run(core.db, 'UPDATE proposals SET title = ?, reason = ?, after_json = ?', `t${RLO}t`, `ok ${RLO}gnp.exe`, JSON.stringify({ title: `x${RLO}y` }))
    const [v] = listPending(core, 'bob')
    expect(isSafeLine(v!.title)).toBe(true)
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

  it('a document search with more than 20 hits pushes a notice with the exact numbers (review r3, F5)', () => {
    const core = createTestCore()
    const visibleBefore = (executeTool(as(core, 'bob'), 'search_documents', { query: 'zz-probe' }).modelResult as { total: number }).total
    expect(visibleBefore).toBe(0)
    for (let i = 0; i < 22; i++) run(core.db, 'INSERT INTO documents VALUES (?,?,?,?,?,?,?)', `D-P${i}`, 'apollo', 'doc', `zz-probe ${i}`, 'x', 'system', '2026-01-01T00:00:00Z')
    for (let i = 0; i < 3; i++) run(core.db, 'INSERT INTO documents VALUES (?,?,?,?,?,?,?)', `D-Q${i}`, 'borealis', 'doc', `zz-probe other ${i}`, 'x', 'system', '2026-01-01T00:00:00Z')
    const carol = executeTool(as(core, 'carol'), 'search_documents', { query: 'zz-probe' }) // apollo only
    expect(carol.modelResult).toMatchObject({ total: 22, returned: 20 })
    expect(carol.ui).toContainEqual({ type: 'notice', message: 'Document search returned 20 of 22 matching documents; the answer covers only those.' })
  })

  it('the report states how many confirmed changes it lists out of how many (review r3, F5)', () => {
    const core = createTestCore()
    const bob = as(core, 'bob')
    for (let i = 0; i < 7; i++) {
      const out = executeTool(bob, 'propose_create_task', { projectId: 'apollo', title: `Change ${i}`, reason: 'Fill the report.' })
      const v = out.ui.find((e): e is Extract<UiEvent, { type: 'proposal' }> => e.type === 'proposal')!.proposal
      expect(confirm(core, { proposalId: v.id, token: v.token, userId: 'bob', channel: 'web' }).status).toBe(200)
    }
    const out = executeTool(bob, 'project_report_data', { projectId: 'apollo' })
    const data = out.modelResult as { recentChanges: unknown[]; recentChangesNote: string }
    expect(data.recentChanges).toHaveLength(5)
    expect(data.recentChangesNote).toBe('latest 5 of 7 confirmed changes')
    expect(out.ui).toContainEqual({ type: 'notice', message: 'The report lists the latest 5 of 7 confirmed changes.' })
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
