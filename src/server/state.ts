import { listAuditForUser, verifyChain, type AuditRow } from '@/core/audit'
import { scopedProjectIds, type Role } from '@/core/authz'
import { isoDate } from '@/core/clock'
import { all } from '@/core/db'
import { listPending, type ProposalView } from '@/core/proposals'
import { agentMode, getCore } from '@/core/runtime'

export interface BoardTask {
  id: string
  title: string
  status: string
  assigneeId: string | null
  dueDate: string | null
  overdue: boolean
  version: number
}

export interface AppState {
  user: string
  users: { id: string; name: string; roles: Record<string, Role> }[]
  projects: { id: string; name: string; description: string; role: Role; tasks: BoardTask[]; reports: { id: string; title: string }[] }[]
  pending: ProposalView[]
  audit: AuditRow[]
  auditTotal: number
  chain: { ok: boolean; rows: number; firstBrokenSeq: number | null }
  model: string
}

/** Everything the UI shows for one user. Every query is scoped to that user's projects. */
export function buildState(user: string): AppState {
  const core = getCore()
  const today = isoDate(core.clock.now())
  const users = all<{ id: string; name: string }>(core.db, 'SELECT id, name FROM users ORDER BY id').map((u) => ({
    ...u,
    roles: Object.fromEntries(
      all<{ project_id: string; role: Role }>(core.db, 'SELECT project_id, role FROM memberships WHERE user_id = ?', u.id).map((m) => [m.project_id, m.role]),
    ) as Record<string, Role>,
  }))
  const scope = scopedProjectIds(core.db, user)
  const projects = scope.map((pid) => {
    const p = all<{ id: string; name: string; description: string }>(core.db, 'SELECT * FROM projects WHERE id = ?', pid)[0]!
    const role = users.find((u) => u.id === user)!.roles[pid]!
    const tasks = all<{ id: string; title: string; status: string; assignee_id: string | null; due_date: string | null; version: number }>(
      core.db, 'SELECT * FROM tasks WHERE project_id = ? ORDER BY CAST(substr(id, 3) AS INTEGER)', pid,
    ).map((t) => ({
      id: t.id, title: t.title, status: t.status, assigneeId: t.assignee_id, dueDate: t.due_date, version: t.version,
      overdue: !!t.due_date && t.due_date < today && t.status !== 'done',
    }))
    const reports = all<{ id: string; title: string }>(core.db, "SELECT id, title FROM documents WHERE project_id = ? AND kind = 'report' ORDER BY id", pid)
    return { ...p, role, tasks, reports }
  })
  return {
    user,
    users,
    projects,
    pending: listPending(core, user),
    ...(({ rows, total }) => ({ audit: rows, auditTotal: total }))(listAuditForUser(core.db, user, scope, 60)),
    chain: verifyChain(core.db),
    model: agentMode() === 'anthropic' ? (process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5') : process.env.MOCK_ADVERSARIAL === '0' ? 'mock' : 'mock (adversarial)',
  }
}
