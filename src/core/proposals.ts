import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendAudit, type Channel } from './audit'
import { assertCan, AuthzError, type Action } from './authz'
import { canonicalJson, sha256 } from './canonical'
import type { Core, Ctx } from './context'
import { all, get, run, tx, type Db } from './db'

export const PROPOSAL_TTL_SECONDS = 300

export type ProposalTool = 'propose_create_task' | 'propose_update_task_status' | 'propose_assign_task' | 'propose_save_report'
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'expired' | 'conflict'

export interface ProposalRow {
  id: string
  actor_id: string
  channel: Channel
  project_id: string
  tool: ProposalTool
  title: string
  args_json: string
  args_hash: string
  target_id: string | null
  base_version: number | null
  before_json: string | null
  after_json: string
  reason: string
  status: ProposalStatus
  created_at: string
  expires_at: string
  decided_by: string | null
  decided_at: string | null
  result_json: string | null
}

/** What the UI renders. Includes the token, so it is only ever sent to the human's browser. */
export interface ProposalView {
  id: string
  tool: ProposalTool
  title: string
  projectId: string
  actorId: string
  channel: Channel
  before: Record<string, unknown> | null
  after: Record<string, unknown>
  reason: string
  status: ProposalStatus
  expiresAt: string
  token?: string
}

// ---------------------------------------------------------------------------
// Tokens: v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, "v1." + payload))>
// ---------------------------------------------------------------------------

export interface TokenPayload {
  pid: string // proposal id
  sub: string // the only user allowed to confirm
  ah: string // sha256 of the canonical args: any change to the args invalidates the token
  bv: number | null // task version the diff was computed against
  exp: number // unix seconds
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function signToken(secret: Buffer, payload: TokenPayload): string {
  const body = 'v1.' + b64u(canonicalJson(payload))
  const mac = createHmac('sha256', secret).update(body).digest()
  return `${body}.${b64u(mac)}`
}

export type VerifyResult = { ok: true; payload: TokenPayload } | { ok: false; reason: string }

export function verifyToken(secret: Buffer, token: unknown): VerifyResult {
  if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'missing_or_malformed' }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' }
  const [, payloadB64, macB64] = parts as [string, string, string]
  const expected = createHmac('sha256', secret).update(`v1.${payloadB64}`).digest()
  const given = Buffer.from(macB64, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' }
  try {
    const p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload
    if (typeof p.pid !== 'string' || typeof p.sub !== 'string' || typeof p.ah !== 'string' || typeof p.exp !== 'number') {
      return { ok: false, reason: 'malformed_payload' }
    }
    return { ok: true, payload: p }
  } catch {
    return { ok: false, reason: 'malformed_payload' }
  }
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface NewProposal {
  tool: ProposalTool
  projectId: string
  title: string
  args: Record<string, unknown>
  targetId: string | null
  baseVersion: number | null
  before: Record<string, unknown> | null
  after: Record<string, unknown>
  reason: string
}

export function toView(p: ProposalRow, token?: string): ProposalView {
  return {
    id: p.id,
    tool: p.tool,
    title: p.title,
    projectId: p.project_id,
    actorId: p.actor_id,
    channel: p.channel,
    before: p.before_json ? (JSON.parse(p.before_json) as Record<string, unknown>) : null,
    after: JSON.parse(p.after_json) as Record<string, unknown>,
    reason: p.reason,
    status: p.status,
    expiresAt: p.expires_at,
    ...(token ? { token } : {}),
  }
}

export function tokenFor(core: Core, p: ProposalRow): string {
  return signToken(core.secret, {
    pid: p.id,
    sub: p.actor_id,
    ah: p.args_hash,
    bv: p.base_version,
    exp: Math.floor(Date.parse(p.expires_at) / 1000),
  })
}

/** Store a pending change. Nothing in the business tables is touched here. */
export function createProposal(ctx: Ctx, np: NewProposal): { row: ProposalRow; token: string } {
  const now = ctx.clock.now()
  const argsJson = canonicalJson(np.args)
  const row: ProposalRow = {
    id: 'P-' + randomBytes(8).toString('hex'),
    actor_id: ctx.actorId,
    channel: ctx.channel,
    project_id: np.projectId,
    tool: np.tool,
    title: np.title,
    args_json: argsJson,
    args_hash: sha256(argsJson),
    target_id: np.targetId,
    base_version: np.baseVersion,
    before_json: np.before ? canonicalJson(np.before) : null,
    after_json: canonicalJson(np.after),
    reason: np.reason,
    status: 'pending',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PROPOSAL_TTL_SECONDS * 1000).toISOString(),
    decided_by: null,
    decided_at: null,
    result_json: null,
  }
  tx(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO proposals (id, actor_id, channel, project_id, tool, title, args_json, args_hash, target_id, base_version,
         before_json, after_json, reason, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id, row.actor_id, row.channel, row.project_id, row.tool, row.title, row.args_json, row.args_hash,
      row.target_id, row.base_version, row.before_json, row.after_json, row.reason, row.status, row.created_at, row.expires_at,
    )
    appendAudit(ctx.db, ctx.clock, {
      actorId: ctx.actorId, channel: ctx.channel, event: 'proposed', outcome: 'pending',
      tool: np.tool, args: np.args, reason: np.reason, proposalId: row.id,
    })
  })
  return { row, token: tokenFor(ctx, row) }
}

export function getProposal(db: Db, id: string): ProposalRow | undefined {
  return get<ProposalRow>(db, 'SELECT * FROM proposals WHERE id = ?', id)
}

/** Pending, unexpired proposals of one user, from any channel (web chat or MCP). */
export function listPending(core: Core, userId: string): ProposalView[] {
  const now = core.clock.now().toISOString()
  return all<ProposalRow>(
    core.db,
    "SELECT * FROM proposals WHERE actor_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at",
    userId, now,
  ).map((p) => toView(p, tokenFor(core, p)))
}

// ---------------------------------------------------------------------------
// Confirm / reject
// ---------------------------------------------------------------------------

export interface DecisionInput {
  proposalId: string
  token: unknown
  /** The authenticated human (session cookie or TTY user). */
  userId: string
  channel: Channel
}

export interface DecisionResult {
  status: number
  body: {
    ok: boolean
    code: string
    message: string
    replay?: boolean
    result?: unknown
    proposal?: ProposalView
    current?: unknown
  }
}

const ACTION_OF: Record<ProposalTool, Action> = {
  propose_create_task: 'propose_create_task',
  propose_update_task_status: 'propose_update_task_status',
  propose_assign_task: 'propose_assign_task',
  propose_save_report: 'propose_save_report',
}

type Checked = { ok: true; p: ProposalRow; payload: TokenPayload } | { ok: false; res: DecisionResult }

/** Steps 1 to 5 of the protocol, shared by confirm and reject. Runs inside the caller's transaction. */
function checkToken(core: Core, input: DecisionInput, verb: 'confirm' | 'reject'): Checked {
  const audit = (event: 'token_invalid' | 'expired', detail: string, outcome = 'refused') =>
    appendAudit(core.db, core.clock, {
      actorId: input.userId, channel: input.channel, event, outcome, proposalId: input.proposalId, detail: `${verb}: ${detail}`,
    })
  const fail = (status: number, code: string, message: string): Checked => ({
    ok: false,
    res: { status, body: { ok: false, code, message } },
  })

  const v = verifyToken(core.secret, input.token)
  if (!v.ok) {
    audit('token_invalid', v.reason)
    return fail(401, 'token_invalid', 'Confirmation token is missing or invalid.')
  }
  if (v.payload.pid !== input.proposalId) {
    audit('token_invalid', 'token belongs to another proposal')
    return fail(401, 'token_invalid', 'Token does not match this proposal.')
  }
  const p = getProposal(core.db, input.proposalId)
  if (!p) return fail(404, 'not_found', 'Proposal not found.')
  if (v.payload.exp <= Math.floor(core.clock.now().getTime() / 1000)) {
    if (p.status === 'pending') {
      run(core.db, "UPDATE proposals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", core.clock.now().toISOString(), p.id)
    }
    audit('expired', 'token expired', 'expired')
    return fail(410, 'expired', 'This proposal expired. Ask the agent again.')
  }
  if (input.userId !== v.payload.sub || v.payload.sub !== p.actor_id) {
    audit('token_invalid', `user ${input.userId} is not the requester ${p.actor_id}`)
    return fail(403, 'not_requester', 'Only the user who asked for this change can decide on it.')
  }
  if (v.payload.ah !== p.args_hash || v.payload.bv !== p.base_version) {
    audit('token_invalid', 'arguments changed after the token was issued')
    return fail(401, 'token_invalid', 'Token does not match the proposed arguments.')
  }
  return { ok: true, p, payload: v.payload }
}

/** The ONLY code path that writes to the business tables. Called only from confirm(). */
function applyProposal(core: Core, p: ProposalRow): Record<string, unknown> {
  const args = JSON.parse(p.args_json) as Record<string, string | undefined>
  const now = core.clock.now().toISOString()
  const n = (v: string | undefined) => v ?? null
  switch (p.tool) {
    case 'propose_update_task_status': {
      const changed = run(
        core.db,
        'UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
        n(args.status), now, p.target_id, p.base_version,
      )
      if (changed !== 1) throw new Error('version race')
      return { taskId: p.target_id, status: args.status }
    }
    case 'propose_assign_task': {
      const changed = run(
        core.db,
        'UPDATE tasks SET assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
        n(args.assigneeId), now, p.target_id, p.base_version,
      )
      if (changed !== 1) throw new Error('version race')
      return { taskId: p.target_id, assigneeId: args.assigneeId }
    }
    case 'propose_create_task': {
      const max = get<{ m: number | null }>(core.db, 'SELECT MAX(CAST(substr(id, 3) AS INTEGER)) AS m FROM tasks')
      const id = `T-${(max?.m ?? 0) + 1}`
      run(
        core.db,
        `INSERT INTO tasks (id, project_id, title, description, status, assignee_id, due_date, version, updated_at)
         VALUES (?,?,?,?,'todo',?,?,1,?)`,
        id, p.project_id, n(args.title), args.description ?? '', n(args.assigneeId), n(args.dueDate), now,
      )
      return { taskId: id }
    }
    case 'propose_save_report': {
      const max = get<{ m: number | null }>(core.db, 'SELECT MAX(CAST(substr(id, 3) AS INTEGER)) AS m FROM documents')
      const id = `D-${(max?.m ?? 0) + 1}`
      run(
        core.db,
        "INSERT INTO documents (id, project_id, kind, title, body, created_by, created_at) VALUES (?,?,'report',?,?,?,?)",
        id, p.project_id, n(args.title), n(args.body), p.actor_id, now,
      )
      return { documentId: id }
    }
  }
}

export function confirm(core: Core, input: DecisionInput): DecisionResult {
  return tx(core.db, () => {
    const c = checkToken(core, input, 'confirm')
    if (!c.ok) return c.res
    const p = c.p
    const args = JSON.parse(p.args_json) as Record<string, string | undefined>

    // 6. Permissions are checked again: a role may have changed since the proposal was made.
    try {
      assertCan(core.db, p.actor_id, p.project_id, ACTION_OF[p.tool], { assigneeId: args.assigneeId })
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e
      appendAudit(core.db, core.clock, {
        actorId: input.userId, channel: input.channel, event: 'denied', outcome: 'refused',
        tool: p.tool, proposalId: p.id, detail: `confirm: ${e.detail}`,
      })
      return { status: 403, body: { ok: false, code: 'forbidden', message: 'You no longer have permission for this change.' } }
    }

    // 7. Idempotency: a second click returns the stored result instead of applying again.
    if (p.status === 'applied') {
      appendAudit(core.db, core.clock, {
        actorId: input.userId, channel: input.channel, event: 'confirm_replay', outcome: 'replayed', tool: p.tool, proposalId: p.id,
      })
      return {
        status: 200,
        body: { ok: true, code: 'applied', message: 'Already applied.', replay: true, result: JSON.parse(p.result_json ?? 'null') },
      }
    }
    if (p.status !== 'pending') {
      return { status: 409, body: { ok: false, code: p.status, message: `Proposal is ${p.status}.` } }
    }

    // 8. Optimistic concurrency: the diff the human saw must still be the truth.
    if (p.target_id && p.base_version !== null) {
      const task = get<{ version: number; status: string; assignee_id: string | null }>(
        core.db, 'SELECT version, status, assignee_id FROM tasks WHERE id = ?', p.target_id,
      )
      if (!task || task.version !== p.base_version) {
        run(core.db, "UPDATE proposals SET status = 'conflict', decided_by = ?, decided_at = ? WHERE id = ?", input.userId, core.clock.now().toISOString(), p.id)
        appendAudit(core.db, core.clock, {
          actorId: input.userId, channel: input.channel, event: 'conflict', outcome: 'refused', tool: p.tool, proposalId: p.id,
          detail: `task version ${task?.version ?? 'missing'} != base ${p.base_version}`,
        })
        return {
          status: 409,
          body: { ok: false, code: 'conflict', message: 'The task changed after this proposal was made. Ask again.', current: task ?? null },
        }
      }
    }

    // 9. Claim the proposal first; only the caller that flips pending -> applied may write.
    const now = core.clock.now().toISOString()
    const claimed = run(
      core.db,
      "UPDATE proposals SET status = 'applied', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      input.userId, now, p.id,
    )
    if (claimed !== 1) return { status: 409, body: { ok: false, code: 'race', message: 'Proposal was decided concurrently.' } }
    const result = applyProposal(core, p)
    run(core.db, 'UPDATE proposals SET result_json = ? WHERE id = ?', canonicalJson(result), p.id)
    appendAudit(core.db, core.clock, {
      actorId: input.userId, channel: input.channel, event: 'confirmed', outcome: 'ok', tool: p.tool,
      args: JSON.parse(p.args_json), reason: p.reason, proposalId: p.id, confirmedBy: input.userId,
    })
    appendAudit(core.db, core.clock, {
      actorId: p.actor_id, channel: input.channel, event: 'applied', outcome: 'ok', tool: p.tool,
      args: result, reason: p.reason, proposalId: p.id, confirmedBy: input.userId,
    })
    const updated = getProposal(core.db, p.id)!
    return { status: 200, body: { ok: true, code: 'applied', message: 'Change applied.', result, proposal: toView(updated) } }
  })
}

export function reject(core: Core, input: DecisionInput): DecisionResult {
  return tx(core.db, () => {
    const c = checkToken(core, input, 'reject')
    if (!c.ok) return c.res
    const changed = run(
      core.db,
      "UPDATE proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      input.userId, core.clock.now().toISOString(), c.p.id,
    )
    if (changed !== 1) return { status: 409, body: { ok: false, code: c.p.status, message: `Proposal is ${c.p.status}.` } }
    appendAudit(core.db, core.clock, {
      actorId: input.userId, channel: input.channel, event: 'rejected', outcome: 'ok', tool: c.p.tool,
      reason: c.p.reason, proposalId: c.p.id, confirmedBy: input.userId,
    })
    return { status: 200, body: { ok: true, code: 'rejected', message: 'Change discarded. Nothing was written.' } }
  })
}
