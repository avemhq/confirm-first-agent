import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Minimal hook stand-in so the real click handler runs in node without a DOM library.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }))
vi.mock('react', async () => ({
  ...(await vi.importActual<typeof import('react')>('react')),
  useState: (initial: unknown) => {
    const i = hooks.cursor++
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [hooks.values[i], (v: unknown) => { hooks.values[i] = v }]
  },
  useEffect: () => {},
}))

import ProposalCard from '@/app/components/ProposalCard'
import type { ProposalView } from '@/app/components/types'

type Btn = ReactElement<{ onClick: () => Promise<void>; children: unknown; disabled: boolean }>
function buttons(node: unknown): Btn[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(buttons)
  const e = node as ReactElement<{ children?: unknown }>
  if (e.type === 'button') return [e as Btn]
  return buttons(e.props?.children)
}

const proposal = {
  id: 'P-0000000000000000', tool: 'propose_create_task', title: 'Task', projectId: 'apollo', actorId: 'bob', channel: 'web',
  before: null, after: { title: 'Task' }, reason: 'Review sample', status: 'pending',
  expiresAt: new Date(Date.now() + 300_000).toISOString(), token: 'synthetic',
} as unknown as ProposalView

const render = (onDecided: () => void) => {
  hooks.cursor = 0
  return ProposalCard({ proposal, onDecided })
}

describe('ProposalCard', () => {
  it('a network error does not lock the buttons, shows a message and re-syncs', async () => {
    const saved = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    try {
      hooks.values = []
      const onDecided = vi.fn()
      const confirm = buttons(render(onDecided)).find((b) => b.props.children === 'Confirm')!
      await expect(confirm.props.onClick()).resolves.toBeUndefined()
      expect(onDecided).toHaveBeenCalledTimes(1)
      const again = buttons(render(onDecided)).find((b) => b.props.children === 'Confirm')!
      expect(again.props.disabled).toBe(false)
      expect(JSON.stringify(render(onDecided))).toContain('Network error')
    } finally {
      globalThis.fetch = saved
    }
  })

  it('a body cut off in transit is a network error, not a final result', async () => {
    const saved = globalThis.fetch
    const broken = new ReadableStream({ start: (c) => c.error(new TypeError('network error')) })
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(broken, { status: 200 }))
    try {
      hooks.values = []
      const onDecided = vi.fn()
      const confirm = buttons(render(onDecided)).find((b) => b.props.children === 'Confirm')!
      await confirm.props.onClick()
      const tree = render(onDecided)
      expect(JSON.stringify(tree)).toContain('Network error')
      expect(buttons(tree).find((b) => b.props.children === 'Confirm')?.props.disabled).toBe(false)
    } finally {
      globalThis.fetch = saved
    }
  })
  it('a 200 with a body that is not the server answer is not shown as a final result', async () => {
    const saved = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>proxy</html>', { status: 200 }))
    try {
      hooks.values = []
      const onDecided = vi.fn()
      const confirm = buttons(render(onDecided)).find((b) => b.props.children === 'Confirm')!
      await confirm.props.onClick()
      const tree = render(onDecided)
      expect(JSON.stringify(tree)).toContain('Unexpected response (HTTP 200)')
      expect(JSON.stringify(tree)).not.toContain('200: error')
      expect(buttons(tree).find((b) => b.props.children === 'Confirm')?.props.disabled).toBe(false)
      expect(onDecided).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = saved
    }
  })
})
