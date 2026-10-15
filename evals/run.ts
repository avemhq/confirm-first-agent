import { appendFileSync, writeFileSync } from 'node:fs'
import { AnthropicModel } from '../src/core/models/anthropic'
import { defaultModelFactory, SCENARIOS } from './scenarios'
import { verdict } from './verdict'

const live = process.argv.includes('--live')
if (live && !process.env.ANTHROPIC_API_KEY) {
  console.error('eval:live needs ANTHROPIC_API_KEY in the environment.')
  process.exit(2)
}
const model = live ? () => new AnthropicModel() : defaultModelFactory
const selected = live ? SCENARIOS.filter((s) => s.live) : SCENARIOS

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
    const v = verdict(res)
    result = v.result
    detail = v.detail
    if (!v.pass) failed++
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
