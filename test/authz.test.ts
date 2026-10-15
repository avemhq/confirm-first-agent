import { describe, expect, it } from 'vitest'
import { can, scopedProjectIds, type Action, type Role } from '@/core/authz'
import { createTestCore } from '@/core/testing'

// The full matrix from the README. "self" = assigning to oneself, "other" = assigning to someone else.
const MATRIX: [Action, string, Record<Role, boolean>][] = [
  ['read', '', { viewer: true, member: true, admin: true }],
  ['propose_create_task', '', { viewer: false, member: true, admin: true }],
  ['propose_update_task_status', '', { viewer: false, member: true, admin: true }],
  ['propose_assign_task', 'self', { viewer: false, member: true, admin: true }],
  ['propose_assign_task', 'other', { viewer: false, member: false, admin: true }],
  ['propose_save_report', '', { viewer: false, member: true, admin: true }],
]

describe('permission matrix', () => {
  for (const [action, variant, expected] of MATRIX) {
    for (const role of ['viewer', 'member', 'admin'] as Role[]) {
      it(`${role} ${action} ${variant}`.trim(), () => {
        const opts = variant ? { actorId: 'u1', assigneeId: variant === 'self' ? 'u1' : 'u2' } : {}
        expect(can(role, action, opts)).toBe(expected[role])
      })
    }
  }

  it('denies everything without a membership', () => {
    for (const [action] of MATRIX) expect(can(null, action)).toBe(false)
  })
})

describe('scope', () => {
  it('derives visible projects from memberships only', () => {
    const core = createTestCore()
    expect(scopedProjectIds(core.db, 'bob')).toEqual(['apollo', 'borealis'])
    expect(scopedProjectIds(core.db, 'dave')).toEqual(['borealis'])
    expect(scopedProjectIds(core.db, 'carol')).toEqual(['apollo'])
    expect(scopedProjectIds(core.db, 'mallory')).toEqual([])
  })
})
