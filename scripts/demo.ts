/**
 * `npm run demo`: reset the demo database, then start the dev server on port 3000.
 * npm appends extra arguments to the end of a script, so a chained `reset && next dev` would reset
 * first and only then fail on `--db other.db`. This entry point refuses any argument before anything
 * is deleted.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { noArgsOrExit } from '../mcp/args'
import { projectRoot } from './load-env'

noArgsOrExit(process.argv.slice(2), 'DB_PATH=<path> npm run demo (no arguments)')
const tsx = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs')
const reset = spawnSync(process.execPath, [tsx, resolve(projectRoot, 'scripts/reset-db.ts')], { stdio: 'inherit' })
if (reset.status !== 0) process.exit(reset.status ?? 1)
const next = resolve(projectRoot, 'node_modules/next/dist/bin/next')
const dev = spawnSync(process.execPath, [next, 'dev', '-p', '3000'], { stdio: 'inherit' })
process.exit(dev.status ?? 1)
