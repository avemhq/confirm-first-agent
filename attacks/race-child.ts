/** One racer for attacks/run.ts: waits for a shared start time, then confirms the proposal once. */
import { confirm, getProposal, tokenFor } from '../src/core/proposals'
import { getCore } from '../src/core/runtime'

const [id, startAt] = process.argv.slice(2) as [string, string]
const core = getCore()
const token = tokenFor(core, getProposal(core.db, id)!)
while (Date.now() < Number(startAt)) {
  // busy-wait so all racers hit the database within the same millisecond window
}
const r = confirm(core, { proposalId: id, token, userId: 'bob', channel: 'cli' })
console.log(`${r.status} ${r.body.code}${r.body.replay ? ' replay' : ''}`)
