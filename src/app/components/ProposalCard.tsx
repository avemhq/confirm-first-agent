'use client'

import { useEffect, useState } from 'react'
import { formatCell as fmt } from './format'
import type { ProposalView } from './types'

/** The server's JSON answer, or null for anything else (e.g. a proxy error page). */
function parseBody(text: string): { ok?: unknown; message?: unknown } | null {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' ? (v as { ok?: unknown; message?: unknown }) : null
  } catch {
    return null
  }
}


export default function ProposalCard({ proposal, onDecided }: { proposal: ProposalView; onDecided: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, Date.parse(proposal.expiresAt) - Date.now()))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Date.parse(proposal.expiresAt) - Date.now())), 1000)
    return () => clearInterval(t)
  }, [proposal.expiresAt])

  const [netError, setNetError] = useState<string | null>(null)

  const decide = async (decision: 'confirm' | 'reject') => {
    setBusy(true)
    setNetError(null)
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/${decision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: proposal.token }),
      })
      // Reading the body can still fail in transit: that must reach the network-error path below,
      // not be shown as a final error (the change may already be applied).
      const text = await res.text()
      const body = parseBody(text)
      if (!body || typeof body.ok !== 'boolean' || typeof body.message !== 'string') {
        // Not a server answer we understand: do not show a final verdict. The re-sync below shows the truth.
        setNetError(`Unexpected response (HTTP ${res.status}). Check the board and the Pending panel; retrying is safe.`)
        return
      }
      setResult({ ok: body.ok, message: `${res.status}: ${body.message}` })
    } catch {
      // The request may or may not have reached the server. Retrying is safe: confirm is idempotent.
      setNetError('Network error. The server may or may not have received this; you can safely try again.')
    } finally {
      setBusy(false)
      onDecided() // re-sync board, pending list and audit with the server either way
    }
  }

  const keys = Array.from(new Set([...Object.keys(proposal.before ?? {}), ...Object.keys(proposal.after)]))
  const expired = left === 0
  const mm = String(Math.floor(left / 60000)).padStart(1, '0')
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')

  return (
    <div className={`proposal ${result ? (result.ok ? 'done' : 'failed') : ''}`}>
      <div className="proposal-head">
        <span className="tag">proposed change</span>
        <span className="mono small">{proposal.id}</span>
        {proposal.channel !== 'web' && <span className="tag alt">via {proposal.channel}</span>}
        {!result && <span className={`timer ${expired ? 'overdue' : ''}`}>{expired ? 'expired' : `${mm}:${ss}`}</span>}
      </div>
      <p className="proposal-title">{proposal.title}</p>
      <table className="diff">
        <thead>
          <tr>
            <th>Field</th>
            {proposal.before && <th>Before</th>}
            <th>{proposal.before ? 'After' : 'New value'}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              {proposal.before && <td className="before">{fmt(proposal.before[k])}</td>}
              <td className="after">{fmt(proposal.after[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        <span className="muted">Agent&apos;s reason:</span> {proposal.reason}
      </p>
      {netError && !result && <p className="small bad-text">{netError}</p>}
      {result ? (
        <p className={`small ${result.ok ? 'ok-text' : 'bad-text'}`}>{result.message}</p>
      ) : (
        <div className="actions">
          <button className="primary" disabled={busy || expired} onClick={() => decide('confirm')}>
            Confirm
          </button>
          <button disabled={busy || expired} onClick={() => decide('reject')}>
            Reject
          </button>
        </div>
      )}
    </div>
  )
}
