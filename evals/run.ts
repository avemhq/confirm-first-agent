import { appendFileSync, writeFileSync } from 'node:fs'
import { AnthropicModel } from '../src/core/models/anthropic'
import { defaultModelFactory, SCENARIOS } from './scenarios'

const live = process.argv.includes('--live')
if (live && !process.env.ANTHROPIC_API_KEY) {
  console.error('eval:live needs ANTHROPIC_API_KEY in the environment.')
  process.exit(2)
}
const model = live ? () => new AnthropicModel() : defaultModelFactory
const selected = live ? SCENARIOS.filter((s) => s.live) : SCENARIOS

/** A scenario with fewer checks proves too little to count as a pass (an empty list is not a PASS). */
const MIN_CHECKS = 2

const rows: string[] = []
let failed = 0
let checks = 0
for (const s of selected) {
  const t0 = performance.now()
  let result: string
  let detail = ''
  try {
    const res = await s.run({ model, live })
    checks += res.length
    const bad = res.filter((c) => !c.ok)
    if (res.length < MIN_CHECKS) {
      failed++
      result = `FAIL (${res.length} checks, minimum ${MIN_CHECKS})`
      detail = 'too few checks to prove anything'
    } else {
      result = bad.length ? `FAIL (${res.length - bad.length}/${res.length})` : `PASS (${res.length}/${res.length})`
      if (bad.length) {
        failed++
        detail = bad.map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ''}`).join(' | ')
      }
    }
  } catch (e) {
    failed++
    result = 'ERROR'
    detail = e instanceof Error ? e.message : String(e)
  }
  const ms = Math.round(performance.now() - t0)
  rows.push(`| ${s.id} | ${s.name} | ${s.threat} | ${s.attack} | ${result} | ${ms} |`)
  if (detail) console.error(`  scenario ${s.id} ${s.name}: ${detail}`)
}

const header = `| # | Scenario | Threat covered | How it is attacked | Result | ms |\n|---|---|---|---|---|---|`
const summary = `${selected.length - failed}/${selected.length} scenarios passed, ${checks} checks, model: ${live ? new AnthropicModel().label : 'mock (scripted)'}`
const table = `${header}\n${rows.join('\n')}\n\n${summary}\n`
console.log(table)
writeFileSync(new URL('./results.md', import.meta.url), table)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Eval\n\n${table}`)
process.exit(failed ? 1 : 0)
