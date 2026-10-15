import { confirm, reject } from '@/core/proposals'
import { getCore } from '@/core/runtime'
import { json, sameOrigin, sessionUser } from '@/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/proposals/:id/confirm and /api/proposals/:id/reject. Human-only: needs session + token. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; decision: string }> }) {
  const { id, decision } = await params
  if (decision !== 'confirm' && decision !== 'reject') return json(404, { error: 'not_found' })
  if (!sameOrigin(req)) return json(403, { error: 'bad_origin' })
  const user = await sessionUser()
  if (!user) return json(401, { error: 'no_session' })
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null
  const input = { proposalId: id, token: body?.token, userId: user, channel: 'web' as const }
  const res = decision === 'confirm' ? confirm(getCore(), input) : reject(getCore(), input)
  return json(res.status, res.body)
}
