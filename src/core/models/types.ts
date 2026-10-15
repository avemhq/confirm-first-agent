import type { ProposalView } from '../proposals'

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /** Provider-specific block (e.g. thinking) that must be sent back unchanged. */
  | { type: 'opaque'; data: unknown }

export interface Msg {
  role: 'user' | 'assistant'
  content: string | Block[]
}

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'

export interface ModelClient {
  readonly label: string
  stream(
    req: { system: string; messages: Msg[]; tools: ToolDef[]; signal?: AbortSignal },
    onText: (delta: string) => void,
  ): Promise<{ content: Block[]; stopReason: StopReason }>
}

/** Events streamed to the UI as NDJSON, one per line. */
export type AgentEvent =
  | { type: 'meta'; model: string; actorId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { type: 'proposal'; proposal: ProposalView }
  | { type: 'denied'; tool: string; detail: string }
  | { type: 'flag'; kind: 'injection'; source: string }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
