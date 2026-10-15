import { buildState } from '@/server/state'
import { json, sessionUser } from '@/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await sessionUser()
  if (!user) return json(401, { error: 'no_session' })
  return json(200, buildState(user))
}
