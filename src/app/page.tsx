import { buildState } from '@/server/state'
import { sessionUser } from '@/server/session'
import App from './components/App'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const user = await sessionUser()
  return <App initial={buildState(user ?? 'bob')} hasSession={!!user} />
}
