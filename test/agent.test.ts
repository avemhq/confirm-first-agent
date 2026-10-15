import { describe, expect, it } from 'vitest'
import { MAX_PROPOSALS_PER_TURN, MAX_STEPS, runTurn } from '@/core/agent'
import { all } from '@/core/db'
import type { AgentEvent, Block, ModelClient } from '@/core/models/types'
import { as, createTestCore } from '@/core/testing'

/** A model that never stops calling tools: proves the loop caps hold regardless of the model. */
function runaway(callsPerStep: () => Block[]): ModelClient {
  return {
    label: 'runaway',
    stream: async () => ({ content: callsPerStep(), stopReason: 'tool_use' as const }),
  }
}

describe('agent loop limits', () => {
  it(`stops after ${MAX_STEPS} steps`, async () => {
    const core = createTestCore()
    let n = 0
    const events: AgentEvent[] = []
    await runTurn({
      ctx: as(core, 'bob'),
      model: runaway(() => [{ type: 'tool_use', id: `t${n++}`, name: 'list_projects', input: {} }]),
      history: [{ role: 'user', text: 'loop' }],
      emit: (e) => events.push(e),
    })
    expect(n).toBe(MAX_STEPS)
    expect(MAX_STEPS).toBe(6) // the documented contract (README), not just whatever the constant says
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(all(core.db, "SELECT 1 FROM audit_log WHERE event = 'turn_limit'")).toHaveLength(1)
  })

  it(`allows at most ${MAX_PROPOSALS_PER_TURN} proposals per turn`, async () => {
    const core = createTestCore()
    let n = 0
    await runTurn({
      ctx: as(core, 'alice'),
      model: runaway(() =>
        Array.from({ length: 5 }, () => ({
          type: 'tool_use' as const,
          id: `t${n++}`,
          name: 'propose_create_task',
          input: { projectId: 'apollo', title: `Task ${n}`, reason: 'Flooding the queue.' },
        })),
      ),
      history: [{ role: 'user', text: 'flood' }],
      emit: () => {},
    })
    expect(all(core.db, 'SELECT id FROM proposals')).toHaveLength(MAX_PROPOSALS_PER_TURN)
    expect(MAX_PROPOSALS_PER_TURN).toBe(3) // the documented contract (README)
  })
})
