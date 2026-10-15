'use client'

import { useCallback, useEffect, useState } from 'react'
import AuditTable from './AuditTable'
import Chat from './Chat'
import ProposalCard from './ProposalCard'
import type { AppState } from './types'

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export default function App({ initial, hasSession }: { initial: AppState; hasSession: boolean }) {
  const [state, setState] = useState(initial)
  const [tab, setTab] = useState<'pending' | 'audit'>('pending')
  const [chatKey, setChatKey] = useState(0)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/state', { cache: 'no-store' })
    if (res.ok) setState((await res.json()) as AppState)
  }, [])

  useEffect(() => {
    if (!hasSession) void post('/api/session', { userId: initial.user }).then(refresh)
  }, [hasSession, initial.user, refresh])

  const switchUser = async (userId: string) => {
    await post('/api/session', { userId })
    await refresh()
    setChatKey((k) => k + 1)
  }

  const me = state.users.find((u) => u.id === state.user)

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>✓</span>
          <div>
            <h1>Confirm-first agent</h1>
            <p>Acts on your project data. Writes nothing without your click.</p>
          </div>
        </div>
        <div className="badges">
          <span className="badge" title="Model used for the chat">model: {state.model}</span>
          <span className={`badge ${state.chain.ok ? 'ok' : 'bad'}`} title="Audit log hash chain">
            {state.chain.ok ? `audit chain verified (${state.chain.rows})` : `audit chain broken at #${state.chain.firstBrokenSeq}`}
          </span>
        </div>
      </header>

      <nav className="users" aria-label="Demo user">
        <span className="muted">Signed in as (demo switcher):</span>
        {state.users.map((u) => (
          <button key={u.id} className={`user ${u.id === state.user ? 'active' : ''}`} onClick={() => switchUser(u.id)}>
            <strong>{u.name}</strong>
            <span>
              {Object.entries(u.roles)
                .map(([p, r]) => `${p}: ${r}`)
                .join(' · ') || 'no projects'}
            </span>
          </button>
        ))}
      </nav>

      <main className="grid">
        <section className="panel board" aria-label="Projects">
          <h2>What {me?.name} can see</h2>
          {state.projects.length === 0 && <p className="muted">No projects.</p>}
          {state.projects.map((p) => (
            <div key={p.id} className="project">
              <div className="project-head">
                <h3>{p.name}</h3>
                <span className={`role role-${p.role}`}>{p.role}</span>
              </div>
              <p className="muted small">{p.description}</p>
              <ul className="tasks">
                {p.tasks.map((t) => (
                  <li key={t.id} className={t.version > 1 ? 'changed' : ''}>
                    <span className="mono">{t.id}</span>
                    <span className="title">{t.title}</span>
                    <span className={`status s-${t.status}`}>{t.status.replace('_', ' ')}</span>
                    <span className="meta">
                      {t.assigneeId ?? 'unassigned'}
                      {t.dueDate && <span className={t.overdue ? 'overdue' : ''}> · {t.dueDate}</span>}
                      {t.version > 1 && <span className="ver"> · v{t.version}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {p.reports.length > 0 && (
                <p className="small">Saved reports: {p.reports.map((r) => `${r.id} ${r.title}`).join(', ')}</p>
              )}
            </div>
          ))}
        </section>

        <section className="panel chat-panel" aria-label="Chat">
          <Chat key={`${state.user}-${chatKey}`} onChanged={refresh} />
        </section>

        <section className="panel side" aria-label="Pending and audit">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'pending'} onClick={() => setTab('pending')}>
              Pending {state.pending.length > 0 && <span className="count">{state.pending.length}</span>}
            </button>
            <button role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>
              Audit log
            </button>
          </div>
          {tab === 'pending' ? (
            <div className="pending">
              <p className="muted small">Proposals waiting for you, from the web chat or from MCP clients (Claude Desktop, Claude Code).</p>
              {state.pending.length === 0 && <p className="muted">Nothing waiting.</p>}
              {state.pending.map((p) => (
                <ProposalCard key={p.id} proposal={p} onDecided={refresh} />
              ))}
            </div>
          ) : (
            <AuditTable rows={state.audit} total={state.auditTotal} />
          )}
        </section>
      </main>
    </div>
  )
}
