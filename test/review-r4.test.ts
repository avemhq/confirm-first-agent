import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatCell } from '@/app/components/format'
import ProposalCard from '@/app/components/ProposalCard'
import { as, createTestCore } from '@/core/testing'
import { executeTool, type UiEvent } from '@/core/tools'

describe('the rendered confirmation card tells different values apart (review r4, F1)', () => {
  it('formatCell is injective on the cases that used to collide', () => {
    const cells = ['', '(none)', null, '5', 5, 'true', true, '""'].map(formatCell)
    expect(new Set(cells).size).toBe(cells.length)
  })

  it('an empty and a "(none)" description render differently', () => {
    const core = createTestCore()
    const bob = as(core, 'bob')
    const html = ['', '(none)'].map((description) => {
      const out = executeTool(bob, 'propose_create_task', { projectId: 'apollo', title: 'Same', description, reason: 'Compare.' })
      const p = out.ui.find((e): e is Extract<UiEvent, { type: 'proposal' }> => e.type === 'proposal')!.proposal
      return renderToStaticMarkup(createElement(ProposalCard, { proposal: { ...p, id: 'P-same', expiresAt: '2030-01-01T00:00:00Z' }, onDecided: () => {} }))
    })
    expect(html[0]).not.toBe(html[1])
  })
})

describe('npm run demo refuses arguments before resetting (review r4, F3)', () => {
  it('the demo script is the guarded entry point', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.demo).toBe('tsx scripts/demo.ts')
  })

  it('an argument (as npm would append it) leaves the database untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfa-demo-'))
    try {
      const db = join(dir, 'sentinel.db')
      writeFileSync(db, 'sentinel')
      const r = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/demo.ts'), '--db', 'other.db'], {
        env: { ...process.env, DB_PATH: db, CONFIRM_SECRET: 'd'.repeat(40) }, encoding: 'utf8', timeout: 30_000,
      })
      expect(r.status).toBe(2)
      expect(readFileSync(db, 'utf8')).toBe('sentinel')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
