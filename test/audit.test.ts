import { describe, expect, it } from 'vitest'
import { appendAudit, verifyChain } from '@/core/audit'
import { run } from '@/core/db'
import { createTestCore } from '@/core/testing'

function coreWithRows(n: number) {
  const core = createTestCore()
  for (let i = 0; i < n; i++) {
    appendAudit(core.db, core.clock, { actorId: 'bob', channel: 'web', event: 'tool_call', outcome: 'ok', tool: 'search_tasks', args: { i } })
  }
  return core
}

describe('audit hash chain', () => {
  it('verifies an untouched chain', () => {
    expect(verifyChain(coreWithRows(5).db)).toEqual({ ok: true, rows: 5, firstBrokenSeq: null })
  })

  it('detects an edited row and reports the first broken seq', () => {
    const core = coreWithRows(5)
    run(core.db, "UPDATE audit_log SET outcome = 'refused' WHERE seq = 3")
    expect(verifyChain(core.db)).toMatchObject({ ok: false, firstBrokenSeq: 3 })
  })

  it('detects a deleted row in the middle', () => {
    const core = coreWithRows(5)
    run(core.db, 'DELETE FROM audit_log WHERE seq = 2')
    expect(verifyChain(core.db)).toMatchObject({ ok: false, firstBrokenSeq: 3 })
  })

  it('detects a recomputed hash that does not match the next row', () => {
    const core = coreWithRows(3)
    run(core.db, "UPDATE audit_log SET hash = 'f' || substr(hash, 2) WHERE seq = 1")
    expect(verifyChain(core.db).ok).toBe(false)
  })
})

describe('row shape', () => {
  it('returns plain objects (server components reject null prototypes)', async () => {
    const { listAudit } = await import('@/core/audit')
    const rows = listAudit(coreWithRows(1).db)
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype)
  })
})
