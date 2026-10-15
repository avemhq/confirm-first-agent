import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256 } from '@/core/canonical'
import { businessStateHash, get, run } from '@/core/db'
import { confirm, reject, signToken, tokenFor, getProposal } from '@/core/proposals'
import { as, createTestCore } from '@/core/testing'
import { executeTool } from '@/core/tools'

function propose(core = createTestCore(), taskId = 'T-3', status = 'done') {
  const out = executeTool(as(core, 'bob'), 'propose_update_task_status', { taskId, status, reason: 'Testing the flow.' })
  const ev = out.ui.find((e) => e.type === 'proposal')
  if (!ev || ev.type !== 'proposal') throw new Error('no proposal')
  return { core, proposal: ev.proposal, out }
}

const version = (core: ReturnType<typeof createTestCore>, id: string) =>
  get<{ version: number; status: string }>(core.db, 'SELECT version, status FROM tasks WHERE id = ?', id)!

describe('proposals', () => {
  it('never hands the token to the model', () => {
    const { out, proposal } = propose()
    expect(proposal.token).toMatch(/^v1\./)
    expect(JSON.stringify(out.modelResult)).not.toContain(proposal.token!)
    expect(JSON.stringify(out.modelResult)).not.toContain('token')
  })

  it('writes nothing until confirmed, then applies exactly once', () => {
    const { core, proposal } = propose()
    expect(version(core, 'T-3')).toEqual({ version: 1, status: 'in_progress' })
    const input = { proposalId: proposal.id, token: proposal.token, userId: 'bob', channel: 'web' as const }
    expect(confirm(core, input).status).toBe(200)
    expect(version(core, 'T-3')).toEqual({ version: 2, status: 'done' })
    const again = confirm(core, input)
    expect(again.status).toBe(200)
    expect(again.body.replay).toBe(true)
    expect(version(core, 'T-3').version).toBe(2)
  })

  it('rejects a token whose args hash does not match the stored args', () => {
    const { core, proposal } = propose()
    const p = getProposal(core.db, proposal.id)!
    const forged = signToken(core.secret, { pid: p.id, sub: 'bob', ah: sha256(canonicalJson({ taskId: 'T-3', status: 'blocked' })), bv: 1, exp: 9e9 })
    expect(confirm(core, { proposalId: p.id, token: forged, userId: 'bob', channel: 'web' }).status).toBe(401)
    // Tampering the stored args directly also breaks the binding.
    run(core.db, `UPDATE proposals SET args_hash = ? WHERE id = ?`, 'x'.repeat(64), p.id)
    expect(confirm(core, { proposalId: p.id, token: proposal.token, userId: 'bob', channel: 'web' }).status).toBe(401)
    expect(version(core, 'T-3').version).toBe(1)
  })

  it('detects a stale base version', () => {
    const { core, proposal } = propose()
    run(core.db, "UPDATE tasks SET status = 'blocked', version = version + 1 WHERE id = 'T-3'")
    const r = confirm(core, { proposalId: proposal.id, token: proposal.token, userId: 'bob', channel: 'web' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('conflict')
    expect(version(core, 'T-3').status).toBe('blocked')
  })

  it('re-checks permissions at confirmation time', () => {
    const { core, proposal } = propose()
    run(core.db, "UPDATE memberships SET role = 'viewer' WHERE user_id = 'bob' AND project_id = 'apollo'")
    expect(confirm(core, { proposalId: proposal.id, token: proposal.token, userId: 'bob', channel: 'web' }).status).toBe(403)
    expect(version(core, 'T-3').version).toBe(1)
  })

  it('reject needs a valid token and writes nothing', () => {
    const { core, proposal } = propose()
    const before = businessStateHash(core.db, sha256)
    expect(reject(core, { proposalId: proposal.id, token: 'nope', userId: 'bob', channel: 'web' }).status).toBe(401)
    expect(reject(core, { proposalId: proposal.id, token: proposal.token, userId: 'bob', channel: 'web' }).status).toBe(200)
    expect(confirm(core, { proposalId: proposal.id, token: proposal.token, userId: 'bob', channel: 'web' }).status).toBe(409)
    expect(businessStateHash(core.db, sha256)).toBe(before)
  })

  it('a freshly minted UI token matches the original binding', () => {
    const { core, proposal } = propose()
    const t = tokenFor(core, getProposal(core.db, proposal.id)!)
    expect(confirm(core, { proposalId: proposal.id, token: t, userId: 'bob', channel: 'web' }).status).toBe(200)
  })
})

describe('write path', () => {
  // Structural guarantee: business tables are written in exactly one module.
  it('only proposals.ts writes to tasks or documents', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(f) && !p.endsWith(join('core', 'proposals.ts')) && !p.endsWith(join('core', 'seed.ts'))) {
          const src = readFileSync(p, 'utf8')
          if (/(UPDATE|INSERT INTO|DELETE FROM)\s+(tasks|documents)\b/i.test(src)) offenders.push(p)
        }
      }
    }
    walk(join(__dirname, '..', 'src'))
    walk(join(__dirname, '..', 'mcp'))
    expect(offenders).toEqual([])
  })
})
