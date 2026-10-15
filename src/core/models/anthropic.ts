import Anthropic from '@anthropic-ai/sdk'
import type { Block, ModelClient, Msg, StopReason, ToolDef } from './types'

export const DEFAULT_MODEL = 'claude-sonnet-5-5'

/** Adapter for the Anthropic Messages API (streaming, client-side tools). Key comes only from the environment. */
export class AnthropicModel implements ModelClient {
  readonly label: string
  private readonly client: Anthropic
  private readonly model: string

  constructor(opts: { model?: string } = {}) {
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL
    this.label = this.model
    this.client = new Anthropic() // reads ANTHROPIC_API_KEY from the environment
  }

  async stream(
    req: { system: string; messages: Msg[]; tools: ToolDef[]; signal?: AbortSignal },
    onText: (delta: string) => void,
  ): Promise<{ content: Block[]; stopReason: StopReason }> {
    const tools: Anthropic.Tool[] = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      // Cache the (static) tool list and system prompt across turns.
      ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }))
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: 4096,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages: req.messages.map(toParam),
      },
      { signal: req.signal },
    )
    stream.on('text', onText)
    const msg = await stream.finalMessage()

    const content: Block[] = msg.content.map((b): Block => {
      if (b.type === 'text') return { type: 'text', text: b.text }
      // The server validates input with Zod again; nothing here is trusted.
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
      return { type: 'opaque', data: b } // e.g. thinking blocks: replayed unchanged
    })
    const stopReason: StopReason =
      msg.stop_reason === 'tool_use' ? 'tool_use' : msg.stop_reason === 'max_tokens' ? 'max_tokens' : msg.stop_reason === 'refusal' ? 'refusal' : 'end_turn'
    return { content, stopReason }
  }
}

function toParam(m: Msg): Anthropic.MessageParam {
  if (typeof m.content === 'string') return { role: m.role, content: m.content }
  return {
    role: m.role,
    content: m.content.map((b): Anthropic.ContentBlockParam => {
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text }
        case 'tool_use':
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
        case 'tool_result':
          return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error ?? false }
        case 'opaque':
          return b.data as Anthropic.ContentBlockParam
      }
    }),
  }
}
