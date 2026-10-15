/**
 * Load the env files exactly as Next.js does (same loader, same order, same $VAR expansion), so the
 * CLI tools (MCP server, confirm, reset, audit:verify) use the same DB_PATH and
 * CONFIRM_SECRET as the web app. Variables already set in the environment win.
 *
 * The web app runs with the project root as working directory, so relative paths (DB_PATH, the
 * secret file) are relative to the project root. The CLI tools switch to the project root as well,
 * wherever they are started from; paths given on their command line are resolved against the
 * directory they were started in (see `fromInvocation`).
 *
 * Mode: `development` files (.env.development*) unless NODE_ENV=production, matching `next dev`.
 * Import this module first.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFrom } from './env'

const invocationCwd = process.cwd()
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(projectRoot)
loadEnvFrom(projectRoot)

/** A path from the command line, resolved against the directory the tool was started in. */
export const fromInvocation = (p: string): string => resolve(invocationCwd, p)
