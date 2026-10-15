import { canonicalJson, sha256 } from './canonical'
import { all, get, run, tx, type Db } from './db'
import type { Clock } from './clock'
import { isKnownField, isKnownTool } from './names'

export type Channel = 'web' | 'mcp' | 'cli' | 'system'
export type AuditEvent =
  | 'tool_call'
  | 'invalid_input'
  | 'denied'
  | 'proposed'
  | 'confirmed'
  | 'applied'
  | 'rejected'
  | 'expired'
  | 'conflict'
  | 'confirm_replay'
  | 'token_invalid'
  | 'unknown_tool'
  | 'injection_flagged'
  | 'turn_limit'
  | 'limit'
  | 'not_pending'

export interface AuditInput {
  actorId: string
  channel: Channel
  event: AuditEvent
  outcome: string
  /** Project the entry is about, when known. Used to hide entries once access is revoked. */
  projectId?: string | null
  tool?: string | null
  args?: unknown
  reason?: string | null
  proposalId?: string | null
  confirmedBy?: string | null
  detail?: string | null
  /**
   * Set only when detail is built from server-side constants and stored ids, never from model text.
   * Rows without a project drop any detail that is not marked trusted.
   */
  detailTrusted?: boolean
}

export interface AuditRow {
  seq: number
  ts: string
  actor_id: string
  channel: Channel
  project_id: string | null
  event: AuditEvent
  tool: string | null
  args_json: string | null
  reason: string | null
  outcome: string
  proposal_id: string | null
  confirmed_by: string | null
  detail: string | null
  prev_hash: string
  hash: string
}

export const GENESIS_HASH = '0'.repeat(64)

function rowHash(prevHash: string, row: Omit<AuditRow, 'hash' | 'prev_hash'>): string {
  return sha256(prevHash + canonicalJson(row))
}

/**
 * Rows without a project keep only server-defined identifiers: known tool names, known argument
 * names and a count of everything else. Model-chosen names could carry project content.
 */
function redactProjectless(e: AuditInput): AuditInput {
  let args: unknown
  if (e.args !== undefined) {
    if (e.args && typeof e.args === 'object' && !Array.isArray(e.args)) {
      const keys = Object.keys(e.args)
      const known = keys.filter(isKnownField).sort()
      args = { _keys: known, _unknownKeys: keys.length - known.length }
    } else {
      args = { _type: Array.isArray(e.args) ? 'array' : e.args === null ? 'null' : typeof e.args }
    }
  }
  return {
    ...e,
    tool: e.tool == null ? null : isKnownTool(e.tool) ? e.tool : '(unknown)',
    args,
    reason: null,
    detail: e.detailTrusted ? e.detail : null,
  }
}

/**
 * Append one audit row. Each row hashes the previous one, so silent edits break the chain.
 * Entries without a project carry no free text (see redactProjectless): access to them
 * cannot be revoked per project, so they must not carry project content.
 */
export function appendAudit(db: Db, clock: Clock, e: AuditInput): number {
  if (!e.projectId) e = redactProjectless(e)
  return tx(db, () => {
    const last = get<{ seq: number; hash: string }>(db, 'SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
    const row: Omit<AuditRow, 'hash' | 'prev_hash'> = {
      seq: (last?.seq ?? 0) + 1,
      ts: clock.now().toISOString(),
      actor_id: e.actorId,
      channel: e.channel,
      project_id: e.projectId ?? null,
      event: e.event,
      tool: e.tool ?? null,
      args_json: e.args === undefined ? null : canonicalJson(e.args),
      reason: e.reason ?? null,
      outcome: e.outcome,
      proposal_id: e.proposalId ?? null,
      confirmed_by: e.confirmedBy ?? null,
      detail: e.detail ?? null,
    }
    const prev = last?.hash ?? GENESIS_HASH
    run(
      db,
      `INSERT INTO audit_log (seq, ts, actor_id, channel, project_id, event, tool, args_json, reason, outcome, proposal_id, confirmed_by, detail, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.seq, row.ts, row.actor_id, row.channel, row.project_id, row.event, row.tool, row.args_json, row.reason, row.outcome,
      row.proposal_id, row.confirmed_by, row.detail, prev, rowHash(prev, row),
    )
    return row.seq
  })
}

export function listAudit(db: Db, opts: { limit?: number } = {}): AuditRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  return all<AuditRow>(db, 'SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?', limit)
}

/**
 * Audit entries one user may see: their own actions, and only for projects they can still access.
 * Entries without a project carry no free text (see appendAudit), so showing them leaks nothing.
 */
export function listAuditForUser(db: Db, userId: string, scope: string[], limit = 60): { rows: AuditRow[]; total: number } {
  const inScope = scope.length ? `OR project_id IN (${scope.map(() => '?').join(',')})` : ''
  const where = `actor_id = ? AND (project_id IS NULL ${inScope})`
  const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`, userId, ...scope)?.n ?? 0
  const rows = all<AuditRow>(db, `SELECT * FROM audit_log WHERE ${where} ORDER BY seq DESC LIMIT ?`, userId, ...scope, limit)
  return { rows, total }
}

export interface ChainStatus {
  ok: boolean
  rows: number
  firstBrokenSeq: number | null
}

/** Recompute every hash. Detects edited, inserted or reordered rows (not truncation of the tail). */
export function verifyChain(db: Db): ChainStatus {
  const rows = all<AuditRow>(db, 'SELECT * FROM audit_log ORDER BY seq ASC')
  let prev = GENESIS_HASH
  let expectedSeq = 1
  for (const r of rows) {
    const { hash, prev_hash, ...rest } = r
    if (r.seq !== expectedSeq || prev_hash !== prev || rowHash(prev, rest) !== hash) {
      return { ok: false, rows: rows.length, firstBrokenSeq: r.seq }
    }
    prev = hash
    expectedSeq++
  }
  return { ok: true, rows: rows.length, firstBrokenSeq: null }
}
