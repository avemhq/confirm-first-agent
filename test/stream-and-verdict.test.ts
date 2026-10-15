import { describe, expect, it } from 'vitest'
import { readEventStream } from '@/app/components/stream'
import { MIN_CHECKS, verdict } from '../evals/verdict'

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch))
      c.close()
    },
  })

describe('chat stream (review finding 8)', () => {
  it('a stream that ends without a done event is reported as cut off', async () => {
    const seen: string[] = []
    const finished = await readEventStream(streamOf('{"type":"text","text":"Hi"}\n{"type":"tool"', '}\n'), (e) => seen.push(e.type))
    expect(seen).toEqual(['text', 'tool'])
    expect(finished).toBe(false)
  })

  it('a done event, also as a last line without newline and split across chunks, completes the turn', async () => {
    const seen: string[] = []
    const finished = await readEventStream(streamOf('{"type":"text","text":"Hi"}\n{"type":"do', 'ne"}'), (e) => seen.push(e.type))
    expect(seen).toEqual(['text', 'done'])
    expect(finished).toBe(true)
  })
})

describe('eval verdict (review finding 9)', () => {
  it('an empty or too short check list is never a pass', () => {
    expect(MIN_CHECKS).toBeGreaterThanOrEqual(2)
    expect(verdict([]).pass).toBe(false)
    expect(verdict([{ name: 'only', ok: true }]).pass).toBe(false)
    expect(verdict([{ name: 'only', ok: true }]).result).toBe(`FAIL (1 checks, minimum ${MIN_CHECKS})`)
  })

  it('one failing check fails the scenario and names it', () => {
    const v = verdict([{ name: 'a', ok: true }, { name: 'b', ok: false, detail: 'x' }])
    expect(v).toEqual({ pass: false, result: 'FAIL (1/2)', detail: 'b: x' })
    expect(verdict([{ name: 'a', ok: true }, { name: 'b', ok: true }])).toEqual({ pass: true, result: 'PASS (2/2)', detail: '' })
  })
})
