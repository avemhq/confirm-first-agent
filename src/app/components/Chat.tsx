'use client'

import { useEffect, useRef, useState } from 'react'
import ProposalCard from './ProposalCard'
import type { AgentEvent, ProposalView } from './types'

type Step =
  | { kind: 'tool'; id: string; name: string; input: unknown; ok?: boolean; summary?: string }
  | { kind: 'proposal'; proposal: ProposalView }
  | { kind: 'denied'; tool: string; detail: string }
  | { kind: 'flag'; source: string }
  | { kind: 'error'; message: string }

interface Turn {
  role: 'user' | 'assistant'
  text: string
  steps: Step[]
}

const clip = (s: string) => (s.length > 140 ? s.slice(0, 137) + '...' : s)

const EXAMPLES = [
  'Which tasks in Apollo are blocked?',
  'Mark T-3 as done',
  'Assign T-6 to bob',
  'Summarize T-7',
  'Weekly report for Apollo',
  'Delete T-1',
]

export default function Chat({ onChanged }: { onChanged: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Leaving the page (or switching user) cancels a running turn instead of letting it finish unseen.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Keep the newest message in view by scrolling the list itself, never the page.
  useEffect(() => {
    const el = listRef.current
    if (el && turns.length) el.scrollTop = el.scrollHeight
  }, [turns])

  const patchLast = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1]!)])

  const apply = (e: AgentEvent) => {
    switch (e.type) {
      case 'text':
        return patchLast((t) => ({ ...t, text: t.text + e.delta }))
      case 'tool_call':
        return patchLast((t) => ({ ...t, steps: [...t.steps, { kind: 'tool', id: e.id, name: e.name, input: e.input }] }))
      case 'tool_result':
        return patchLast((t) => ({
          ...t,
          steps: t.steps.map((s) => (s.kind === 'tool' && s.id === e.id ? { ...s, ok: e.ok, summary: e.summary } : s)),
        }))
      case 'proposal':
        return patchLast((t) => ({ ...t, steps: [...t.steps, { kind: 'proposal', proposal: e.proposal }] }))
      case 'denied':
        return patchLast((t) => ({ ...t, steps: [...t.steps, { kind: 'denied', tool: e.tool, detail: e.detail }] }))
      case 'flag':
        return patchLast((t) => ({ ...t, steps: [...t.steps, { kind: 'flag', source: e.source }] }))
      case 'error':
        return patchLast((t) => ({ ...t, steps: [...t.steps, { kind: 'error', message: e.message }] }))
      default:
        return undefined
    }
  }

  const send = async (text: string) => {
    const msg = text.trim()
    if (!msg || busy) return
    setInput('')
    setBusy(true)
    const history = [...turns, { role: 'user' as const, text: msg, steps: [] }]
      .filter((t) => t.text.trim())
      .slice(-20)
      .map((t) => ({ role: t.role, text: t.text.slice(0, 4000) }))
    setTurns((ts) => [...ts, { role: 'user', text: msg, steps: [] }, { role: 'assistant', text: '', steps: [] }])
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message ?? `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let finished = false
      const handle = (line: string) => {
        const e = JSON.parse(line) as AgentEvent
        if (e.type === 'done') finished = true
        apply(e)
      }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) handle(line)
        }
      }
      buf += decoder.decode()
      if (buf.trim()) handle(buf.trim())
      // The server always ends a turn with a "done" event. Without it the answer was cut off in transit.
      if (!finished && !ctrl.signal.aborted) {
        apply({ type: 'error', message: 'The answer was cut off. Pending proposals and the board below show the real state.' })
      }
    } catch (err) {
      if (!ctrl.signal.aborted) apply({ type: 'error', message: err instanceof Error ? err.message : 'request failed' })
    } finally {
      setBusy(false)
      abortRef.current = null
      onChanged()
    }
  }

  return (
    <div className="chat">
      <div className="messages" aria-live="polite" ref={listRef}>
        {turns.length === 0 && (
          <div className="empty">
            <h2>Ask about your projects</h2>
            <p className="muted">
              The agent reads only what this user may see. Changes appear as a diff with Confirm and Reject.
              The demo model is a scripted mock that also plays a <em>compromised</em> model when it meets an injection,
              so you can watch the server refuse.
            </p>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`msg ${t.role}`}>
            {t.steps.length > 0 && (
              <div className="steps">
                {t.steps.map((s, j) => {
                  if (s.kind === 'tool')
                    return (
                      <div key={j} className={`step ${s.ok === false ? 'bad' : s.ok ? 'good' : ''}`} title={s.summary}>
                        <span className="mono">{s.name}</span>
                        <span className="mono muted small">{clip(JSON.stringify(s.input))}</span>
                        <span className="small">{s.ok === undefined ? '...' : s.ok ? 'ok' : 'refused'}</span>
                      </div>
                    )
                  if (s.kind === 'proposal') return <ProposalCard key={j} proposal={s.proposal} onDecided={onChanged} />
                  if (s.kind === 'denied')
                    return (
                      <div key={j} className="step bad">
                        <span>
                          Server refused <span className="mono">{s.tool}</span>: {s.detail}
                        </span>
                      </div>
                    )
                  if (s.kind === 'flag')
                    return (
                      <div key={j} className="step warn">
                        <span>
                          Injection attempt detected in <span className="mono">{s.source}</span>. Logged; the data is treated as data.
                        </span>
                      </div>
                    )
                  return (
                    <div key={j} className="step bad">
                      {s.message}
                    </div>
                  )
                })}
              </div>
            )}
            {(t.text || t.role === 'user') && <div className="bubble">{t.text}</div>}
            {t.role === 'assistant' && !t.text && busy && i === turns.length - 1 && <div className="bubble muted">thinking...</div>}
          </div>
        ))}
      </div>
      <div className="examples">
        {EXAMPLES.map((e) => (
          <button key={e} disabled={busy} onClick={() => send(e)}>
            {e}
          </button>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask, or tell the agent what to change" maxLength={4000} aria-label="Message" />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="primary" type="submit">
            Send
          </button>
        )}
      </form>
    </div>
  )
}
