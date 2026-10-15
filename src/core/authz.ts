import { all, get, type Db } from './db'

export type Role = 'viewer' | 'member' | 'admin'
export type Action =
  | 'read'
  | 'propose_create_task'
  | 'propose_update_task_status'
  | 'propose_assign_task'
  | 'propose_save_report'

/** Error codes are deliberately coarse: an unknown id and a forbidden id look the same. */
export class AuthzError extends Error {
  constructor(
    public readonly code: 'not_found_or_forbidden' | 'forbidden',
    public readonly detail: string,
  ) {
    super(code)
  }
}

/**
 * The permission matrix. Pure function, tested as a table in test/authz.test.ts.
 * Members may only assign tasks to themselves; there is no delete action at all.
 */
export function can(role: Role | null, action: Action, opts: { actorId?: string; assigneeId?: string } = {}): boolean {
  if (!role) return false
  if (action === 'read') return true
  if (role === 'viewer') return false
  if (action === 'propose_assign_task' && role === 'member') return opts.assigneeId === opts.actorId
  return true
}

export function roleOf(db: Db, userId: string, projectId: string): Role | null {
  const row = get<{ role: Role }>(db, 'SELECT role FROM memberships WHERE user_id = ? AND project_id = ?', userId, projectId)
  return row?.role ?? null
}

/** The single source of truth for what a user can see. All reads filter on this in SQL. */
export function scopedProjectIds(db: Db, userId: string): string[] {
  return all<{ project_id: string }>(db, 'SELECT project_id FROM memberships WHERE user_id = ? ORDER BY project_id', userId).map(
    (r) => r.project_id,
  )
}

export function assertCan(
  db: Db,
  userId: string,
  projectId: string,
  action: Action,
  opts: { assigneeId?: string } = {},
): Role {
  const role = roleOf(db, userId, projectId)
  if (!role) throw new AuthzError('not_found_or_forbidden', `${userId} has no access to project ${projectId}`)
  if (!can(role, action, { actorId: userId, ...opts })) {
    throw new AuthzError('forbidden', `${userId} is ${role} in ${projectId}; ${action} not allowed`)
  }
  return role
}

export function isMember(db: Db, userId: string, projectId: string): boolean {
  return roleOf(db, userId, projectId) !== null
}
