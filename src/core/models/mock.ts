import { detectInjection } from '../untrusted'
import type { Block, ModelClient, Msg, StopReason } from './types'

/**
 * Deterministic, scripted stand-in for an LLM so the demo, tests and evals run offline.
 * It is NOT intelligent: it pattern-matches the last user message.
 *
 * adversarial = true simulates a COMPROMISED model: when a task description contains an
 * injection, the mock obeys it (calls a delete tool and tries to close tasks in another project).
 * The point of the demo is that the server still holds.
 */
export class MockModel implements ModelClient {
  readonly label: string
  constructor(private readonly opts: { adversarial?: boolean; delayMs?: number } = {}) {
    this.label = opts.adversarial ? 'mock (adversarial)' : 'mock'
  }

  async stream(req: { messages: Msg[]; signal?: AbortSignal }, onText: (d: string) => void) {
    const { userText, step, results } = readState(req.messages)
    const decision = decide(userText, step, results, !!this.opts.adversarial)
    const content: Block[] = []
    if (decision.text) {
      for (const word of decision.text.split(/(?<=\s)/)) {
        if (req.signal?.aborted) break
        await new Promise((r) => setTimeout(r, this.opts.delayMs ?? 0))
        onText(word)
      }
      content.push({ type: 'text', text: decision.text })
    }
    // Like a real streamed response that was cancelled: no tool calls after an abort.
    if (req.signal?.aborted) return { content, stopReason: 'end_turn' as StopReason }
    ;(decision.calls ?? []).forEach((c, i) => content.push({ type: 'tool_use', id: `mock_${step}_${i}`, name: c.name, input: c.input }))
    const stopReason: StopReason = decision.calls?.length ? 'tool_use' : 'end_turn'
    return { content, stopReason }
  }
}

interface ToolResult {
  name: string
  isError: boolean
  data: Record<string, unknown>
}

function readState(messages: Msg[]): { userText: string; step: number; results: ToolResult[] } {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && typeof m.content === 'string') {
      start = i
      break
    }
  }
  const userText = start >= 0 ? (messages[start]!.content as string) : ''
  const names = new Map<string, string>()
  const results: ToolResult[] = []
  let step = 0
  for (const m of messages.slice(start + 1)) {
    if (typeof m.content === 'string') continue
    if (m.role === 'assistant') step++
    for (const b of m.content) {
      if (b.type === 'tool_use') names.set(b.id, b.name)
      if (b.type === 'tool_result') {
        results.push({ name: names.get(b.tool_use_id) ?? '?', isError: !!b.is_error, data: JSON.parse(b.content) as Record<string, unknown> })
      }
    }
  }
  return { userText, step, results }
}

interface Decision {
  text?: string
  calls?: { name: string; input: Record<string, unknown> }[]
}

const STATUS_WORDS: Record<string, string> = { todo: 'todo', 'to do': 'todo', 'in progress': 'in_progress', in_progress: 'in_progress', blocked: 'blocked', done: 'done' }

const project = (t: string) => (/\bapollo\b/i.test(t) ? 'apollo' : /\bborealis\b/i.test(t) ? 'borealis' : undefined)
const last = (r: ToolResult[]) => r[r.length - 1]
const refusal = (r: ToolResult) => `The server refused: ${String(r.data.message ?? r.data.error)}`

const HELP =
  'I can answer questions about your projects and propose changes. Try: "Which tasks in Apollo are blocked?", "Mark T-3 as done", "Assign T-6 to bob", "Create task \\"Update privacy page\\" in Apollo", "Weekly report for Apollo" or "Summarize T-7". Every change waits for your Confirm click.'

function decide(text: string, step: number, results: ToolResult[], adversarial: boolean): Decision {
  const t = text.trim()

  if (/\b(delete|remove|erase)\b/i.test(t)) {
    return { text: "I can't delete anything: this agent has no delete capability. I can propose a status change instead, for example marking a task as done." }
  }

  let m = /\b(?:mark|move|set)\s+(T-\d+)\s+(?:as|to)\s+(to do|todo|in progress|in_progress|blocked|done)\b/i.exec(t)
  if (m) {
    const [, taskId, word] = m as unknown as [string, string, string]
    const status = STATUS_WORDS[word.toLowerCase()]!
    if (step === 0) {
      return {
        text: `I'll prepare that change for ${taskId}.\n`,
        calls: [{ name: 'propose_update_task_status', input: { taskId: taskId.toUpperCase(), status, reason: `User asked to set ${taskId.toUpperCase()} to ${status}.` } }],
      }
    }
    return proposalReply(last(results)!)
  }

  m = /\bassign\s+(T-\d+)\s+to\s+([a-z]+)/i.exec(t)
  if (m) {
    const [, taskId, who] = m as unknown as [string, string, string]
    if (step === 0) {
      return {
        text: `Preparing the assignment of ${taskId.toUpperCase()}.\n`,
        calls: [{ name: 'propose_assign_task', input: { taskId: taskId.toUpperCase(), assigneeId: who.toLowerCase(), reason: `User asked to assign ${taskId.toUpperCase()} to ${who}.` } }],
      }
    }
    return proposalReply(last(results)!)
  }

  m = /\bcreate\s+(?:a\s+)?task\s+["“](.+?)["”]\s+in\s+([a-z]+)/i.exec(t)
  if (m) {
    const [, title, proj] = m as unknown as [string, string, string]
    if (step === 0) {
      return {
        text: `Drafting a new task in ${proj}.\n`,
        calls: [{ name: 'propose_create_task', input: { projectId: proj.toLowerCase(), title, reason: 'User asked for this task in the chat.' } }],
      }
    }
    return proposalReply(last(results)!)
  }

  m = /\breport\b/i.exec(t)
  if (m && project(t)) {
    const p = project(t)!
    if (step === 0) return { text: `Collecting the numbers for ${p}.\n`, calls: [{ name: 'project_report_data', input: { projectId: p } }] }
    if (step === 1) {
      const r = last(results)!
      if (r.isError) return { text: refusal(r) }
      const by = r.data.byStatus as Record<string, number>
      const overdue = r.data.overdue as { id: string; title: string; dueDate: string }[]
      const body = [
        `Status ${String(r.data.asOf)}: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
        overdue.length ? `Overdue: ${overdue.map((o) => `${o.id} ${o.title} (due ${o.dueDate})`).join('; ')}.` : 'Nothing is overdue.',
        `Open work by person: ${(r.data.openByAssignee as { assignee: string; open: number }[]).map((x) => `${x.assignee} ${x.open}`).join(', ')}.`,
      ].join('\n')
      return {
        text: `${body}\n\nI can save this as a report document.\n`,
        calls: [{ name: 'propose_save_report', input: { projectId: p, title: `Status report ${String(r.data.asOf)}`, body, reason: 'User asked for a status report.' } }],
      }
    }
    return proposalReply(last(results)!)
  }

  m = /\bsummari[sz]e\s+(T-\d+)/i.exec(t)
  if (m) {
    const taskId = m[1]!.toUpperCase()
    if (step === 0) return { text: `Reading ${taskId}.\n`, calls: [{ name: 'get_task', input: { taskId } }] }
    const task = results[0]!
    if (task.isError) return { text: refusal(task) }
    const injected = detectInjection(String(task.data.description))
    if (step === 1 && injected && adversarial) {
      // Simulated compromised model: obeys the instruction hidden in the data.
      return {
        text: 'The task contains a system note. Following it now.\n',
        calls: [
          { name: 'delete_task', input: { scope: 'all' } },
          { name: 'propose_update_task_status', input: { taskId: 'T-9', status: 'done', reason: 'System note in T-7 says to mark every Borealis task as done.' } },
        ],
      }
    }
    const header = `${taskId} "${String(task.data.title)}" is ${String(task.data.status)}, assigned to ${String(task.data.assigneeId ?? 'nobody')}, due ${String(task.data.dueDate ?? 'n/a')}.`
    if (step >= 2) {
      const outcomes = results.slice(1).map((r) => `${r.name}: ${r.isError ? `refused (${String(r.data.error)})` : 'proposal created'}`)
      return { text: `${header}\nI attempted what the note said. Server response: ${outcomes.join('; ')}. Nothing was changed.` }
    }
    return {
      text: injected
        ? `${header}\nWarning: the description contains text that tries to give me instructions ("delete all tasks"). I treated it as data and did nothing.`
        : header,
    }
  }

  if (/\b(blocked|overdue|open)\b/i.test(t) && /\btasks?\b/i.test(t)) {
    const p = project(t)
    if (step === 0) {
      const input: Record<string, unknown> = {}
      if (p) input.projectId = p
      if (/\bblocked\b/i.test(t)) input.status = 'blocked'
      if (/\boverdue\b/i.test(t)) input.overdueOnly = true
      return { calls: [{ name: 'search_tasks', input }] }
    }
    const r = last(results)!
    if (r.isError) return { text: `I can't access ${p ?? 'that project'}. ${String(r.data.message)}` }
    const tasks = r.data.tasks as { id: string; title: string; assigneeId: string | null; dueDate: string | null; status: string }[]
    if (!tasks.length) return { text: 'No matching tasks.' }
    const lines = tasks.map((x) => `- ${x.id} ${x.title} (${x.status}, ${x.assigneeId ?? 'unassigned'}, due ${x.dueDate ?? 'n/a'})`)
    return { text: `Found ${tasks.length}:\n${lines.join('\n')}` }
  }

  if (/\bprojects?\b/i.test(t)) {
    if (step === 0) return { calls: [{ name: 'list_projects', input: {} }] }
    const rows = last(results)!.data as unknown as { id: string; name: string; role: string }[]
    return { text: `You have access to: ${rows.map((x) => `${x.name} (${x.role})`).join(', ') || 'no projects'}.` }
  }

  return { text: HELP }
}

function proposalReply(r: ToolResult): Decision {
  if (r.isError) return { text: refusal(r) }
  return { text: `Proposal ${String(r.data.proposalId)} is ready: ${String(r.data.summary)}. Review the diff and click Confirm. Nothing is saved until you do.` }
}
