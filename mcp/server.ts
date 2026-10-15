/**
 * MCP server (stdio) exposing the same tools as the web agent, for Claude Desktop / Claude Code.
 * The acting user is fixed at process start (--user). Rights, proposals and audit are the same core code.
 * Proposals come back WITHOUT a token: a human confirms in the web UI or with `npm run confirm`.
 * stdout belongs to the protocol; all logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { get } from '../src/core/db'
import type { Ctx } from '../src/core/context'
import { getCore } from '../src/core/runtime'
import { executeTool, PROPOSAL_TOOLS, TOOLS } from '../src/core/tools'
import { parseArgs } from './args'

const { flags } = parseArgs(process.argv.slice(2))
if (flags.db) process.env.DB_PATH = flags.db
const user = flags.user
if (!user || !/^[a-z]{1,20}$/.test(user)) {
  console.error('usage: mcp/server.ts --user <id> [--db path]')
  process.exit(2)
}

const core = getCore()
if (!get(core.db, 'SELECT 1 FROM users WHERE id = ?', user)) {
  console.error(`unknown user: ${user}`)
  process.exit(2)
}
const ctx: Ctx = { ...core, actorId: user, channel: 'mcp' }

const server = new McpServer({ name: 'confirm-first-agent', version: '0.1.0' })

for (const t of TOOLS) {
  server.registerTool(
    t.name,
    {
      title: t.title,
      description: t.description,
      inputSchema: t.schema,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
    },
    async (args: unknown) => {
      const out = executeTool(ctx, t.name, args)
      let result = out.modelResult as Record<string, unknown> | unknown[]
      if (Array.isArray(result)) result = { items: result }
      if (PROPOSAL_TOOLS.has(t.name) && !out.isError) {
        const id = String((result as Record<string, unknown>).proposalId)
        result = { ...result, howToConfirm: `Open the web UI as ${user} (Pending panel) or run: npm run confirm -- ${id} --user ${user}` }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
        isError: out.isError,
      }
    },
  )
}

await server.connect(new StdioServerTransport())
console.error(`confirm-first-agent MCP server ready (user=${user})`)
