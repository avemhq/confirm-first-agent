import { json, sameOrigin, setSessionUser, userExists } from '@/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Demo user switcher. Not authentication; see README. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json(403, { error: 'bad_origin' })
  const body = (await req.json().catch(() => null)) as { userId?: unknown } | null
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  if (!userExists(userId)) return json(400, { error: 'unknown_user' })
  await setSessionUser(userId)
  return json(200, { ok: true, userId })
}
