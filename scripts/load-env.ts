/**
 * Load .env.local and .env the way Next.js does, so the CLI tools (MCP server, confirm, reset,
 * audit:verify) use the same DB_PATH and CONFIRM_SECRET as the web app. Variables that are already
 * set in the environment win; the first file that sets a variable wins over later ones.
 * Import this module first.
 */
import { existsSync } from 'node:fs'

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file)
}
