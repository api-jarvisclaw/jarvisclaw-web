import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgent, type AgentEvent } from './agent'
import { EventQueue } from './eventqueue'
import type { ChatMessage } from './gateway'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Whether text reaches the consumer WHILE the response is open.
 *
 * The whole existing agent suite passed against the batched version, and the reason is worth
 * stating because it is the trap: every other stub enqueues all its frames and closes the stream
 * immediately, so "streamed live" and "delivered in one block at the end" produce identical
 * output. The difference is timing, and only a stub that withholds the rest of the response can
 * expose it.
 *
 * The defect this pins: the loop collected deltas into an array inside `streamChat`'s callback and
 * replayed them with `yield* pending` after the request resolved. The transport streamed the whole
 * time; delivery was batched. On the free tier an eleven-second answer appeared as one block at
 * eleven seconds, behind a spinner and an empty transcript — indistinguishable from a hung
 * request, and reported as one.
 */

/** An SSE body whose frames are released one at a time, on demand. */
function controllableStream() {
  const encoder = new TextEncoder()
  let ctrl: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    /** Releases one SSE frame to the reader. */
    send(obj: unknown) {
      ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
    },
    /** Ends the response. Until this is called the request is still open. */
    end() {
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'))
      ctrl.close()
    },
    /** Breaks the connection mid-response, the way a dropped network does. */
    fail(err: Error) {
      ctrl.error(err)
    },
  }
}

function textFrame(content: string) {
  return { choices: [{ delta: { content } }] }
}

const opts = {
  baseUrl: 'https://gw.test',
  cred: {},
  anonymous: false,
  // Pinned, so these tests exercise the streaming path rather than model selection — an unpinned
  // model spends a fetch on the router and shifts the scripted response by one.
  model: 'test/model',
  // Required by AgentOptions. Never reached here: nothing in these scripts calls a tool, and a
  // stub that silently approved spending would be the wrong default to establish in a test file.
  confirmSpend: async () => false,
}

describe('the agent forwards text while the response is still open', () => {
  it('yields a delta before the stream ends', async () => {
    const stream = controllableStream()
    vi.stubGlobal('fetch', vi.fn(async () => stream.response))

    const history: ChatMessage[] = []
    const it = runAgent(history, 'hello', opts)[Symbol.asyncIterator]()

    // Asked for the first event, then one frame released. Nothing else is sent and the stream is
    // NOT closed, so this await can only resolve if delivery is live.
    const first = it.next()
    stream.send(textFrame('Hel'))

    /**
     * A real timeout, not a bare await.
     *
     * Against the batched implementation `first` never resolves — the generator is inside
     * `await streamChat`, waiting for a response that this test deliberately never ends. Without a
     * race the test would hang until vitest's own timeout and report as a slow test rather than a
     * failure, which is a considerably worse signal than "the first delta never arrived".
     */
    const raced = await Promise.race([
      first,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1500)),
    ])
    expect(raced, 'the first delta did not arrive until the response closed').not.toBe('timeout')
    const event = raced as IteratorResult<AgentEvent>
    expect(event.done).toBe(false)
    expect(event.value).toEqual({ type: 'text', text: 'Hel' })

    // The rest arrives incrementally too, rather than the first token being a special case.
    stream.send(textFrame('lo'))
    const second = (await it.next()) as IteratorResult<AgentEvent>
    expect(second.value).toEqual({ type: 'text', text: 'lo' })

    stream.end()
    const rest: AgentEvent[] = []
    for (;;) {
      const n = await it.next()
      if (n.done) break
      rest.push(n.value)
    }
    // Nothing is replayed. If the old buffer were still in place the text would arrive a second
    // time here, doubling every answer.
    expect(rest.filter((e) => e.type === 'text')).toEqual([])
    expect(rest.at(-1)?.type).toBe('done')
  })

  it('delivers every delta exactly once, in order', async () => {
    const stream = controllableStream()
    vi.stubGlobal('fetch', vi.fn(async () => stream.response))

    const events: AgentEvent[] = []
    const consume = (async () => {
      for await (const e of runAgent([], 'hello', opts)) events.push(e)
    })()

    // Interleaved with the reads rather than sent up front, so a consumer that is briefly behind is
    // exercised — the case where the queue holds more than one item when the drain resumes.
    for (const word of ['one ', 'two ', 'three ', 'four ']) {
      stream.send(textFrame(word))
      await new Promise((r) => setTimeout(r, 0))
    }
    stream.end()
    await consume

    const text = events.filter((e) => e.type === 'text').map((e) => e.text)
    expect(text).toEqual(['one ', 'two ', 'three ', 'four '])
  })

  it('keeps the text a failed stream had already delivered', async () => {
    /**
     * A stream that dies halfway has usually already put real words on screen, and the user has read
     * them. The error path must not take them back.
     *
     * The frame is released and READ before the error, with a turn of the event loop between them.
     * My first version of this test enqueued and errored in the same tick and asserted the text
     * survived — it does not, and cannot: a ReadableStream whose `error()` is called before the
     * consumer's pending `read()` resolves discards the queued chunk, so `reader.read()` throws
     * having returned nothing. Verified directly: chunks seen before the throw was `[]`.
     *
     * That is a property of the stream API, not of this code, and no queue downstream can recover
     * bytes the reader never yielded. The recoverable case — the one that actually happens on a
     * dropped connection — is a chunk that arrived, was decoded and was forwarded, followed by a
     * failure. That is what this now pins.
     */
    const stream = controllableStream()
    vi.stubGlobal('fetch', vi.fn(async () => stream.response))

    const events: AgentEvent[] = []
    const consume = (async () => {
      for await (const e of runAgent([], 'hello', opts)) events.push(e)
    })()

    stream.send(textFrame('partial answer'))
    // Long enough for the reader to have consumed and forwarded it. Without this the test would be
    // asserting the impossible case again.
    await new Promise((r) => setTimeout(r, 20))
    stream.fail(new Error('connection reset'))
    await consume

    expect(events.some((e) => e.type === 'text' && e.text === 'partial answer')).toBe(true)
    // And the failure is still reported. Delivering the text must not swallow the error, or a
    // truncated answer looks like a complete one.
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })
})

describe('EventQueue', () => {
  it('drains items pushed before the consumer starts', async () => {
    const q = new EventQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    const out: number[] = []
    for await (const n of q.drain()) out.push(n)
    expect(out).toEqual([1, 2])
  })

  it('delivers everything queued before close, not just what fits', async () => {
    // A consumer that is behind must still receive the tail. Dropping it would silently truncate
    // the last words of an answer — which is worse than an obvious failure, because it reads as the
    // model having stopped early.
    const q = new EventQueue<number>()
    const out: number[] = []
    const consume = (async () => {
      for await (const n of q.drain()) {
        out.push(n)
        await new Promise((r) => setTimeout(r, 0))
      }
    })()
    for (let i = 0; i < 20; i++) q.push(i)
    q.close()
    await consume
    expect(out).toHaveLength(20)
    expect(out[19]).toBe(19)
  })

  it('raises a failure only after the buffer drains', async () => {
    const q = new EventQueue<string>()
    q.push('kept')
    q.fail(new Error('upstream died'))
    const out: string[] = []
    await expect(async () => {
      for await (const s of q.drain()) out.push(s)
    }).rejects.toThrow('upstream died')
    expect(out).toEqual(['kept'])
  })

  it('ignores a push after close instead of throwing', async () => {
    // A callback can fire once more while a stream tears down. Throwing from inside a fetch
    // reader's callback surfaces as an unrelated network error, which is a far worse symptom than
    // one dropped frame that arrived after the answer was complete.
    const q = new EventQueue<number>()
    q.close()
    expect(() => q.push(1)).not.toThrow()
    const out: number[] = []
    for await (const n of q.drain()) out.push(n)
    expect(out).toEqual([])
  })

  it('wakes a waiting consumer for each push', async () => {
    // The bug this guards: clearing the `wake` slot AFTER calling the resolver wipes the new
    // resolver a synchronously-resuming consumer just installed, so the next push wakes nobody and
    // the stream hangs with the answer half-written.
    const q = new EventQueue<number>()
    const out: number[] = []
    const consume = (async () => {
      for await (const n of q.drain()) out.push(n)
    })()
    for (let i = 0; i < 5; i++) {
      q.push(i)
      await new Promise((r) => setTimeout(r, 0))
    }
    q.close()
    await consume
    expect(out).toEqual([0, 1, 2, 3, 4])
  })
})
