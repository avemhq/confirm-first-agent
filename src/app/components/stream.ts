/**
 * Reads an NDJSON event stream from /api/chat and hands each parsed line to onLine.
 * Returns true only if the stream carried a `done` event: the server always ends a turn with one,
 * so its absence means the answer was cut off in transit.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onLine: (event: { type: string }) => void,
): Promise<boolean> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finished = false
  const handle = (line: string) => {
    const e = JSON.parse(line) as { type: string }
    if (e.type === 'done') finished = true
    onLine(e)
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) handle(line)
    }
  }
  buf += decoder.decode()
  if (buf.trim()) handle(buf.trim())
  return finished
}

/** What the browser sends as context: the last HISTORY_TURNS messages, each cut to HISTORY_CHARS. */
export const HISTORY_TURNS = 20
export const HISTORY_CHARS = 4000

/**
 * Builds the request history and says, in words a person reads, what was left out. The model gets
 * less context than the screen shows, so the screen has to say so.
 */
export function chatHistory(turns: { role: 'user' | 'assistant'; text: string }[]): {
  history: { role: 'user' | 'assistant'; text: string }[]
  cut: string | null
} {
  const all = turns.filter((t) => t.text.trim())
  const kept = all.slice(-HISTORY_TURNS)
  const dropped = all.length - kept.length
  const shortened = kept.filter((t) => t.text.length > HISTORY_CHARS).length
  const parts = [
    dropped ? `${dropped} older message${dropped === 1 ? '' : 's'} not sent` : '',
    shortened ? `${shortened} long message${shortened === 1 ? '' : 's'} shortened to ${HISTORY_CHARS} characters` : '',
  ].filter(Boolean)
  return {
    history: kept.map((t) => ({ role: t.role, text: t.text.slice(0, HISTORY_CHARS) })),
    cut: parts.length ? `Context for this answer: ${parts.join(', ')}.` : null,
  }
}
