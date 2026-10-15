/**
 * `npm run attack`: try to break the confirm-first guarantee and print what the server answered.
 *
 * Three layers, all against the real code (no mocks of the code under attack):
 *   core   the same functions the HTTP routes and the MCP server call
 *   mcp    a real MCP server process over stdio, attacked as a client would
 *   race   six OS processes confirming the same proposal at the same moment on one database file
 *
 * Exit code 1 if any attack got through. Known, documented limits are listed separately and do not fail.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { verifyChain } from '../src/core/audit'
import { systemClock } from '../src/core/clock'
import { get, openDb, run } from '../src/core/db'
import { confirm, countOpen, getProposal, listPending, reject, signToken, verifyToken, type DecisionResult } from '../src/core/proposals'
import { seed } from '../src/core/seed'
import { as, createTestCore } from '../src/core/testing'
import { executeTool, type ToolOutcome } from '../src/core/tools'
import { sameOriginHeaders, signSession, SESSION_SECONDS, verifySession } from '../src/server/session-core'

interface Row {
  layer: 'core' | 'mcp' | 'race' | 'http'
  attack: string
  answer: string
  held: boolean
}
const rows: Row[] = []
const limits: string[] = []
const record = (layer: Row['layer'], attack: string, held: boolean, answer: string) => rows.push({ layer, attack, answer, held })
const err = (o: ToolOutcome) => (o.isError ? String((o.modelResult as { error?: string }).error) : 'accepted')
const st = (r: DecisionResult) => `${r.status} ${r.body.code}`

/** A fresh database with one pending proposal by bob: T-3 in_progress -> done. */
function fresh() {
  const core = createTestCore()
  const out = executeTool(as(core, 'bob', 'mcp'), 'propose_update_task_status', { taskId: 'T-3', status: 'done', reason: 'Attack suite setup.' })
  const pid = (out.modelResult as { proposalId: string }).proposalId
  const token = listPending(core, 'bob').find((p) => p.id === pid)!.token!
  const t3 = () => get<{ status: string; version: number }>(core.db, "SELECT status, version FROM tasks WHERE id = 'T-3'")!
  const untouched = () => t3().status === 'in_progress' && t3().version === 1
  const input = (token: unknown, userId = 'bob') => ({ proposalId: pid, token, userId, channel: 'web' as const })
  return { core, out, pid, token, t3, untouched, input }
}

// ---------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------
{
  const f = fresh()
  const text = JSON.stringify(f.out.modelResult)
  record('core', 'Look for the confirmation token in what the model receives', !text.includes(f.token) && !text.includes('v1.'), 'no token in the tool result')
}
{
  const f = fresh()
  const r = confirm(f.core, f.input(undefined))
  record('core', 'Confirm without a token', r.status === 401 && f.untouched(), st(r))
}
{
  const f = fresh()
  const payload = JSON.parse(Buffer.from(f.token.split('.')[1]!, 'base64url').toString())
  const r = confirm(f.core, f.input(signToken(Buffer.from('attacker-key-'.padEnd(40, 'k')), payload)))
  record('core', 'Sign a correct payload with a guessed secret', r.status === 401 && f.untouched(), st(r))
}
{
  const f = fresh()
  const [v, body, mac] = f.token.split('.')
  const p = JSON.parse(Buffer.from(body!, 'base64url').toString())
  p.exp += 86_400
  const r = confirm(f.core, f.input(`${v}.${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`))
  record('core', 'Extend the expiry inside the token, keep the old MAC', r.status === 401 && f.untouched(), st(r))
}
{
  const f = fresh()
  const other = executeTool(as(f.core, 'bob'), 'propose_update_task_status', { taskId: 'T-2', status: 'done', reason: 'Second proposal.' })
  const pid2 = (other.modelResult as { proposalId: string }).proposalId
  const r = confirm(f.core, { ...f.input(f.token), proposalId: pid2 })
  record('core', "Use proposal A's token to confirm proposal B", r.status === 401, st(r))
}
{
  const f = fresh()
  const a = confirm(f.core, f.input(f.token, 'alice'))
  const c = confirm(f.core, f.input(f.token, 'carol'))
  record('core', "Admin and viewer replay the requester's valid token", a.status === 403 && c.status === 403 && f.untouched(), `${st(a)} / ${st(c)}`)
}
{
  const f = fresh()
  const r = reject(f.core, f.input(f.token, 'alice'))
  record('core', "Another user rejects someone else's proposal", r.status === 403 && getProposal(f.core.db, f.pid)!.status === 'pending', st(r))
}
{
  const f = fresh()
  f.core.clock.advance(301)
  const r = confirm(f.core, f.input(f.token))
  record('core', 'Confirm 301 s after the proposal (TTL 300 s)', r.status === 410 && f.untouched(), st(r))
}
{
  const f = fresh()
  const a = confirm(f.core, f.input(f.token))
  const b = confirm(f.core, f.input(f.token))
  record('core', 'Double click: confirm twice', a.status === 200 && b.body.replay === true && f.t3().version === 2, `${st(a)}, then replay, version ${f.t3().version}`)
}
{
  const f = fresh()
  reject(f.core, f.input(f.token))
  const r = confirm(f.core, f.input(f.token))
  record('core', 'Confirm after the human rejected', r.status === 409 && f.untouched(), st(r))
}
{
  const f = fresh()
  run(f.core.db, "UPDATE memberships SET role = 'viewer' WHERE user_id = 'bob' AND project_id = 'apollo'")
  const r = confirm(f.core, f.input(f.token))
  record('core', 'Role downgraded between proposal and click', r.status === 403 && f.untouched(), st(r))
}
{
  const f = fresh()
  run(f.core.db, "UPDATE tasks SET status = 'blocked', version = version + 1 WHERE id = 'T-3'")
  const r = confirm(f.core, f.input(f.token))
  record('core', 'Task changed elsewhere after the diff was shown', r.status === 409 && f.t3().status === 'blocked', st(r))
}
for (const [what, sql] of [
  ['arguments (done -> blocked)', `UPDATE proposals SET args_json = '{"status":"blocked","taskId":"T-3"}' WHERE id = ?`],
  ['target (T-3 -> T-9 in another project)', "UPDATE proposals SET target_id = 'T-9' WHERE id = ?"],
  ['project', "UPDATE proposals SET project_id = 'borealis' WHERE id = ?"],
  ['tool', "UPDATE proposals SET tool = 'propose_assign_task' WHERE id = ?"],
  ['diff shown to the human', `UPDATE proposals SET after_json = '{"status":"todo"}' WHERE id = ?`],
  ['reason shown to the human', "UPDATE proposals SET reason = 'Approved by the CEO.' WHERE id = ?"],
] as const) {
  const f = fresh()
  run(f.core.db, sql, f.pid)
  const r = confirm(f.core, f.input(f.token))
  const t9 = get<{ status: string }>(f.core.db, "SELECT status FROM tasks WHERE id = 'T-9'")!
  record('core', `Swap the stored ${what} after the token was issued`, r.status === 401 && f.untouched() && t9.status === 'blocked', st(r))
}
{
  const core = createTestCore()
  const bob = as(core, 'bob', 'mcp')
  const tries = [
    executeTool(bob, 'propose_assign_task', { taskId: 'T-2', assigneeId: 'alice', reason: 'Member assigns to the admin.' }),
    executeTool(bob, 'propose_update_task_status', { taskId: 'T-8', status: 'done', reason: 'Viewer writes in Borealis.' }),
    executeTool(bob, 'propose_create_task', { projectId: 'apollo', title: 'Sneaky task', assigneeId: 'alice', reason: 'Assign via create.' }),
    executeTool(bob, 'propose_create_task', { projectId: 'borealis', title: 'Sneaky task', reason: 'Viewer creates a task.' }),
  ]
  record('core', 'Privilege escalation: assign others, viewer writes, assign on create', tries.every((t) => t.isError), tries.map(err).join(', '))
  const read = executeTool(as(core, 'carol'), 'get_task', { taskId: 'T-8' })
  record('core', 'Read a task in a project without membership', err(read) === 'not_found_or_forbidden', err(read))
}
{
  const core = createTestCore()
  const names = ['delete_task', 'confirm_proposal', '__proto__', 'constructor', 'toString']
  const outs = names.map((n) => executeTool(as(core, 'bob'), n, {}))
  record('core', `Call tools that do not exist (${names.join(', ')})`, outs.every((o) => err(o) === 'unknown_tool'), 'unknown_tool x5')
  const proto = executeTool(as(core, 'bob'), 'propose_update_task_status', JSON.parse('{"taskId":"T-3","status":"done","reason":"Pollute it.","__proto__":{"isAdmin":true}}'))
  record('core', 'Prototype pollution key in the tool input', proto.isError && !({} as Record<string, unknown>).isAdmin, err(proto))
}
{
  const core = createTestCore()
  const ctx = as(core, 'bob', 'mcp')
  let created = 0
  for (let i = 0; i < 15; i++) if (!executeTool(ctx, 'propose_create_task', { projectId: 'apollo', title: `Flood ${i}`, reason: 'Flood the queue.' }).isError) created++
  record('core', 'Flood the human with 15 proposals', created === 10, `${created} accepted, then too_many_pending`)
}
{
  const core = createTestCore()
  const ctx = as(core, 'bob', 'mcp')
  for (let i = 0; i < 10; i++) executeTool(ctx, 'propose_create_task', { projectId: 'apollo', title: `Queued ${i}`, reason: 'Fill the queue.' })
  run(core.db, "DELETE FROM memberships WHERE user_id = 'bob' AND project_id = 'apollo'")
  run(core.db, "UPDATE memberships SET role = 'member' WHERE user_id = 'bob' AND project_id = 'borealis'")
  for (let i = 0; i < 10; i++) executeTool(ctx, 'propose_create_task', { projectId: 'borealis', title: `Queued ${i}`, reason: 'Fill the queue again.' })
  run(core.db, "INSERT INTO memberships (user_id, project_id, role) VALUES ('bob', 'apollo', 'member')")
  const open = countOpen(core, 'bob')
  const listed = listPending(core, 'bob').length
  record('core', 'Exceed the cap: fill, revoke the role, fill again, restore the role', open <= 10 && open === listed, `${open} open, ${listed} listed`)
}
{
  const f = fresh()
  const bad: unknown[] = ['', 'v1..', `v1.${'A'.repeat(5000)}.x`, 'v2.a.b', ['v1', 'a'], { toString: () => f.token }, `v1.e30.${Buffer.alloc(32).toString('base64url')}`]
  const codes = bad.map((t) => confirm(f.core, f.input(t)).status)
  record('core', '7 malformed token shapes (array, object, oversize, wrong version)', codes.every((c) => c === 401) && f.untouched(), codes.join(','))
  const variants = [`${f.token}=`, `${f.token}A`].map((t) => verifyToken(f.core.secret, t).ok)
  record('core', 'Re-encode the MAC (padding, trailing character)', variants.every((ok) => !ok), 'malformed')
}
{
  const core = createTestCore()
  const tries = [
    { reason: `Looks fine ${String.fromCharCode(0x1b)}[8mhidden from the terminal` },
    { reason: 'First line\rOverwritten line' },
    { reason: `Reads backwards ${String.fromCharCode(0x202e)}txt.exe` },
  ].map((x) => executeTool(as(core, 'bob'), 'propose_update_task_status', { taskId: 'T-3', status: 'done', ...x }))
  record('core', 'Hide text from the human: ESC[8m, CR, U+202E in the reason', tries.every((t) => err(t) === 'invalid_input'), 'invalid_input x3')
}
{
  const f = fresh()
  confirm(f.core, f.input(f.token))
  const clean = verifyChain(f.core.db).ok
  run(f.core.db, "UPDATE audit_log SET reason = 'nothing to see' WHERE event = 'confirmed'")
  const after = verifyChain(f.core.db)
  record('core', 'Edit a confirmed row in the audit log', clean && !after.ok, `chain broken at #${after.firstBrokenSeq}`)
  run(f.core.db, 'DELETE FROM audit_log WHERE seq = (SELECT MAX(seq) FROM audit_log)')
  limits.push('Deleting the newest audit rows is not detected by the chain itself (needs an external anchor; see README).')
}

// ---------------------------------------------------------------------------
// http layer (pure functions behind the routes)
// ---------------------------------------------------------------------------
{
  const secret = Buffer.from('session-secret-'.padEnd(48, 's'))
  const now = 1_800_000_000
  const cookie = signSession(secret, 'bob', now)
  const forged = cookie.replace(/^bob\./, 'alice.')
  record('http', 'Change the user id inside the session cookie', verifySession(secret, forged, now) === null, '401 no_session')
  record('http', 'Reuse a copied cookie after it expired', verifySession(secret, cookie, now + SESSION_SECONDS + 1) === null, '401 no_session')
  const h = new Headers({ origin: 'https://evil.example', host: 'demo.local', 'x-forwarded-host': 'evil.example' })
  record('http', 'Cross-site POST with a spoofed X-Forwarded-Host', !sameOriginHeaders(h, false), '403 bad_origin')
}

// ---------------------------------------------------------------------------
// mcp: a real server process over stdio
// ---------------------------------------------------------------------------
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs')
const dir = mkdtempSync(join(tmpdir(), 'cfa-attack-'))
const env: Record<string, string> = { ...(process.env as Record<string, string>), CONFIRM_SECRET: 'attack-suite-secret-'.padEnd(48, 'a'), DB_PATH: join(dir, 'attack.db') }
try {
  const db = openDb(env.DB_PATH!)
  seed(db, systemClock)
  db.close()

  const transport = new StdioClientTransport({ command: process.execPath, args: [tsxCli, resolve('mcp/server.ts'), '--user', 'bob'], env, stderr: 'ignore' })
  const client = new Client({ name: 'attacker', version: '0.0.0' })
  await client.connect(transport)
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      try {
        const r = await client.callTool({ name, arguments: args })
        return { isError: r.isError === true, text: JSON.stringify(r.structuredContent ?? r.content) }
      } catch (e) {
        return { isError: true, text: e instanceof Error ? e.message : String(e) }
      }
    }
    const code = (t: string) => {
      const app = /"error":"([a-z_]+)"/.exec(t)?.[1]
      if (app) return app
      const proto = /MCP error (-?\d+): ([^".]{0,60})/.exec(t)
      return proto ? `MCP ${proto[1]}: ${proto[2]}` : 'refused'
    }
    const tools = (await client.listTools()).tools.map((t) => t.name)
    record('mcp', 'List tools, look for delete or confirm', !tools.some((n) => /delete|confirm/.test(n)), `${tools.length} tools, none of them delete or confirm`)
    for (const [attack, name, args] of [
      ['Call delete_task anyway', 'delete_task', { taskId: 'T-3' }],
      ['Guess a confirm tool', 'confirm_proposal', { id: 'P-0' }],
      ['Viewer writes over MCP', 'propose_update_task_status', { taskId: 'T-8', status: 'done', reason: 'Viewer write over MCP.' }],
      ['Smuggle actorId: "alice" into the arguments', 'propose_update_task_status', { taskId: 'T-2', status: 'done', reason: 'Act as alice.', actorId: 'alice' }],
    ] as const) {
      const r = await call(name, args)
      record('mcp', attack, r.isError, code(r.text))
    }
    const ok = await call('propose_update_task_status', { taskId: 'T-2', status: 'done', reason: 'A legitimate proposal.' })
    record(
      'mcp',
      'Legit proposal: does the model get a token or a way to confirm itself?',
      !ok.isError && !/v1\.[A-Za-z0-9_-]{10,}\./.test(ok.text) && !/npm run confirm/.test(ok.text),
      'pending, no token, told to ask the human in the web UI',
    )
  } finally {
    await client.close()
  }

  // -------------------------------------------------------------------------
  // race: six processes confirm the same proposal at once
  // -------------------------------------------------------------------------
  const core = openDb(env.DB_PATH!)
  const pid = String(get<{ id: string }>(core, "SELECT id FROM proposals WHERE status = 'pending' AND target_id = 'T-2'")!.id)
  core.close()
  const startAt = Date.now() + 1500
  const outputs = await Promise.all(
    Array.from({ length: 6 }, () =>
      new Promise<string>((done) => {
        const child = spawn(process.execPath, [tsxCli, resolve('attacks/race-child.ts'), pid, String(startAt)], { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'] })
        let out = ''
        child.stdout.on('data', (d: Buffer) => (out += d.toString()))
        child.on('close', () => done(out.trim()))
      }),
    ),
  )
  const check = openDb(env.DB_PATH!)
  const t2 = get<{ version: number; status: string }>(check, "SELECT version, status FROM tasks WHERE id = 'T-2'")!
  const applied = get<{ n: number }>(check, "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'applied'")!.n
  check.close()
  const firsts = outputs.filter((o) => o === '200 applied').length
  const replays = outputs.filter((o) => o === '200 applied replay').length
  record('race', '6 processes confirm the same proposal at the same moment', firsts === 1 && replays === 5 && t2.version === 2 && applied === 1, `1 applied, ${replays} replays, version ${t2.version}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
const broken = rows.filter((r) => !r.held)
const table = [
  '| # | Layer | Attack | Server answer | Held |',
  '|---|---|---|---|---|',
  ...rows.map((r, i) => `| ${i + 1} | ${r.layer} | ${r.attack} | ${r.answer.replace(/\|/g, '/')} | ${r.held ? 'yes' : '**NO**'} |`),
].join('\n')
console.log(`${table}\n\n${rows.length - broken.length}/${rows.length} attacks held.`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Attacks\n\n${table}\n\n${rows.length - broken.length}/${rows.length} held.\n`)
if (limits.length) console.log(`\nKnown limits (documented, not counted):\n${limits.map((l) => `- ${l}`).join('\n')}`)
process.exit(broken.length ? 1 : 0)
