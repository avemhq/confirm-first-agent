/**
 * Human confirmation for proposals made over MCP, for a person at a terminal:
 * `npm run confirm -- P-xxxx --user bob [--db path]`. Shows the diff and asks y/N.
 *
 * Threat model, stated plainly: this CLI is a convenience, not a security boundary. It refuses a
 * plain pipe (no TTY), but a process that can run commands can open a pseudo-terminal and type "y",
 * and it could just as well edit the database file. The boundary is the process boundary: the agent
 * reaches this app only through the MCP tools (stdio) and has no shell or file access to this
 * checkout. The MCP server therefore never tells the model about this command; it points the human
 * to the web UI. See README, "Threat model and limitations".
 */
import { fromInvocation } from '../scripts/load-env'
import { createInterface } from 'node:readline/promises'
import { confirm, getProposal, reject, toView, tokenFor } from '../src/core/proposals'
import { getCore } from '../src/core/runtime'
import { parseArgsOrExit } from './args'

const USAGE = 'npm run confirm -- <proposal-id> --user <id> [--db path]'
const { flags, positional } = parseArgsOrExit(process.argv.slice(2), ['user', 'db'], USAGE)
if (flags.db !== undefined) process.env.DB_PATH = fromInvocation(flags.db)
const id = positional[0]
const user = flags.user
if (!id || !user || positional.length !== 1) {
  console.error(`usage: ${USAGE}`)
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
// toView escapes stored text once (control and bidi characters shown as \u{..}, backslashes doubled);
// multiline: false also escapes newlines, so no value can start a fake line in the terminal.
const v = toView(row, undefined, { multiline: false })
const show = (x: unknown) => (x === undefined || x === null ? '-' : typeof x === 'string' ? `"${x}"` : String(x))
console.log(`\n${v.id}  ${v.title}\nrequested by ${v.actorId} via ${v.channel}, status ${v.status}, expires ${v.expiresAt}\nreason: ${v.reason}\n`)
for (const k of new Set([...Object.keys(v.before ?? {}), ...Object.keys(v.after)])) {
  console.log(`  ${k.padEnd(12)} ${show(v.before?.[k])}  ->  ${show(v.after[k])}`)
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
