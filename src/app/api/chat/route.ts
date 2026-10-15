import { z } from 'zod'
import { runTurn } from '@/core/agent'
import type { AgentEvent } from '@/core/models/types'
import { createModel, getCore } from '@/core/runtime'
import { json, sameOrigin, sessionUser } from '@/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(4000) }).strict())
      .min(1)
      .max(20),
  })
  .strict()

/** POST /api/chat: streams AgentEvents as NDJSON (one JSON object per line). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json(403, { error: 'bad_origin' })
  const user = await sessionUser()
  if (!user) return json(401, { error: 'no_session' })
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success || parsed.data.messages.at(-1)?.role !== 'user') return json(400, { error: 'invalid_body' })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const emit = (e: AgentEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'))
        } catch {
          open = false // client went away; the turn stops via req.signal
        }
      }
      try {
        await runTurn({
          ctx: { ...getCore(), actorId: user, channel: 'web' },
          model: createModel({ web: true }),
          history: parsed.data.messages,
          emit,
          signal: req.signal,
        })
      } catch (e) {
        console.error('chat turn failed', e instanceof Error ? e.message : e)
        emit({ type: 'error', message: 'The model call failed. Check the server log.' })
        emit({ type: 'done' })
      } finally {
        if (open) controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
