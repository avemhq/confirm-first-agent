import type { AuditRow } from './types'

const TONE: Record<string, string> = {
  applied: 'ok', confirmed: 'ok', proposed: 'info', rejected: 'muted', tool_call: 'muted', confirm_replay: 'info',
  denied: 'bad', unknown_tool: 'bad', token_invalid: 'bad', injection_flagged: 'warn', expired: 'warn', conflict: 'warn',
  invalid_input: 'warn', turn_limit: 'warn',
}

/** Audit entries of the signed-in user, newest first. */
export default function AuditTable({ rows, total }: { rows: AuditRow[]; total: number }) {
  if (!rows.length) return <p className="muted">No entries yet. Ask the agent something.</p>
  return (
    <div className="audit-wrap">
      <p className="muted small">
        Your entries for projects you can access, newest first{total > rows.length ? ` (latest ${rows.length} of ${total})` : ''}. Each row
        hashes the previous one (npm run audit:verify).
      </p>
      <ol className="audit">
        {rows.map((r) => (
          <li key={r.seq}>
            <div className="audit-head">
              <span className="mono muted">#{r.seq}</span>
              <span className="mono muted">{r.ts.slice(11, 19)}</span>
              <span className={`ev ev-${TONE[r.event] ?? 'muted'}`}>{r.event}</span>
              {r.tool && <span className="mono small">{r.tool}</span>}
            </div>
            {r.reason && <div className="small">Why: {r.reason}</div>}
            {r.detail && <div className="small muted">{r.detail}</div>}
            {!r.reason && !r.detail && r.args_json && (
              <div className="small muted mono" title={r.args_json}>
                {r.args_json.length > 120 ? `${r.args_json.slice(0, 117)}...` : r.args_json}
              </div>
            )}
            <div className="small muted">
              by {r.actor_id} via {r.channel}
              {r.confirmed_by && <span className="ok-text"> · confirmed by {r.confirmed_by}</span>}
              {r.proposal_id && <span className="mono"> · {r.proposal_id}</span>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
