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
