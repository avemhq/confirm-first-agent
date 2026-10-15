/**
 * Human confirmation for proposals made over MCP: `npm run confirm -- P-xxxx --user bob`.
 * Shows the diff and requires a y/N answer on a real terminal. Refuses to run without a TTY,
 * so an agent cannot pipe "y" into it.
 */
import { createInterface } from 'node:readline/promises'
import { confirm, getProposal, reject, toView, tokenFor } from '../src/core/proposals'
import { getCore } from '../src/core/runtime'
import { parseArgs } from './args'

const { flags, positional } = parseArgs(process.argv.slice(2))
if (flags.db) process.env.DB_PATH = flags.db
const id = positional[0]
const user = flags.user
if (!id || !user) {
  console.error('usage: npm run confirm -- <proposal-id> --user <id>')
  process.exit(2)
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Refusing: confirmation requires an interactive terminal.')
  process.exit(3)
}

const core = getCore()
const row = getProposal(core.db, id)
if (!row) {
  console.error('Proposal not found.')
  process.exit(4)
}
const v = toView(row)
console.log(`\n${v.id}  ${v.title}\nrequested by ${v.actorId} via ${v.channel}, status ${v.status}, expires ${v.expiresAt}\nreason: ${v.reason}\n`)
for (const k of new Set([...Object.keys(v.before ?? {}), ...Object.keys(v.after)])) {
  console.log(`  ${k.padEnd(12)} ${JSON.stringify(v.before?.[k] ?? null)}  ->  ${JSON.stringify(v.after[k] ?? null)}`)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = (await rl.question('\nApply this change? [y]es / [r]eject / [N]o: ')).trim().toLowerCase()
rl.close()

const input = { proposalId: id, token: tokenFor(core, row), userId: user, channel: 'cli' as const }
if (answer === 'y' || answer === 'yes') {
  const r = confirm(core, input)
  console.log(`${r.status} ${r.body.message}`)
  process.exit(r.body.ok ? 0 : 1)
} else if (answer === 'r') {
  const r = reject(core, input)
  console.log(`${r.status} ${r.body.message}`)
} else {
  console.log('Nothing changed.')
}
