import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgent, type AgentEvent } from './agent'
import type { ChatMessage } from './gateway'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * A model that deliberates forever, and a model that says nothing at all.
 *
 * Both were measured on the live console, and between them they are the reported
 * "front-end hang" — which was never a hang. Captured from ducat.jarvisclaw.ai on the
 * single-intent prompt "What's the current price of Bitcoin and its 24h change?":
 *
 *   auto/free resolved to `nemotron-3-nano-omni-30b-a3b-reasoning`, which streamed
 *   229,295 characters of `reasoning_content` for one question. The stream was healthy the
 *   whole time — frames arriving continuously — so nothing errored, nothing timed out, and
 *   the page sat on "Thinking" for over seven minutes with no answer. The reasoning itself
 *   showed it inventing tool results it had not called: "Let's assume the first result is
 *   an API with id 123, price $0.01 per call".
 *
 *   The same model, asked the same question directly, returned 0 reasoning, 0 content and
 *   0 tool calls in 21.7s — a completely empty answer with a 200 status.
 *
 * The other eight free models on the same prompt produced 148-191 characters of reasoning
 * and finished in 1.9-22.3s. So this is one model's pathology, not a property of the pool,
 * and the fix is to stop waiting on it rather than to slow everything down.
 */

interface Frame {
  content?: string
  reasoning_content?: string
  tool_calls?: unknown[]
}

/** Streams the given frames as SSE, the shape gateway.streamChat parses. */
function sseFrom(frames: Frame[], model = 'test/model'): Response {
  const body = frames
    .map((f) =>
      `data: ${JSON.stringify({
        model,
        choices: [{ index: 0, delta: f, finish_reason: null }],
      })}\n\n`,
    )
    .join('')
  return new Response(body + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const baseOpts = {
  baseUrl: 'https://gw.test',
  cred: {},
  anonymous: true,
  confirmSpend: async () => false,
  model: 'test/model',
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('runaway reasoning', () => {
  it('abandons a model that deliberates past the cap instead of waiting forever', async () => {
    // 300 frames x 1,000 characters = 300,000, which is the measured 229k rounded up past it.
    const frames: Frame[] = Array.from({ length: 300 }, () => ({
      reasoning_content: 'x'.repeat(1_000),
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseFrom(frames, 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')),
    )

    const history: ChatMessage[] = []
    const events = await collect(runAgent(history, 'What is the price of Bitcoin?', baseOpts))

    // The turn must END. Before the cap it ran to the last frame and then asked for another
    // completion, which is what produced a seven-minute "Thinking".
    const reasoning = events
      .filter((e) => e.type === 'reasoning')
      .map((e) => e.text ?? '')
      .join('')
    expect(reasoning.length).toBeLessThan(300_000)

    // And it must SAY something rather than ending silently: a turn that stops with no text
    // is indistinguishable from the stall being fixed by luck.
    const spoken = events.filter((e) => e.type === 'error' || e.type === 'notice')
    expect(spoken.length).toBeGreaterThan(0)
    expect(spoken.map((e) => e.text).join(' ')).toMatch(/too long|deliberat|thinking/i)
  })

  it('reports a PINNED runaway model instead of claiming the free pool is exhausted', async () => {
    // My own bug, found by driving the guard against the live gateway with the cap lowered
    // rather than by reading the code. `router` is undefined whenever a model is pinned, so the
    // shared retire path fell through to 'exhausted' and the page announced "Every free model
    // the gateway offers is unavailable right now" — about a session that had pinned one model
    // and never touched the pool. The guard fired correctly and then explained itself wrongly.
    const frames: Frame[] = Array.from({ length: 300 }, () => ({
      reasoning_content: 'x'.repeat(1_000),
    }))
    vi.stubGlobal('fetch', vi.fn(async () => sseFrom(frames, 'pinned/model')))

    const history: ChatMessage[] = []
    const events = await collect(
      runAgent(history, 'What is the price of Bitcoin?', { ...baseOpts, model: 'pinned/model' }),
    )

    const said = events
      .filter((e) => e.type === 'error' || e.type === 'notice')
      .map((e) => e.text ?? '')
      .join(' ')
    expect(said).not.toMatch(/every free model/i)
    expect(said).toMatch(/pinned\/model/)
    expect(said).toMatch(/different model|narrower/i)
  })

  it('leaves an ordinary amount of reasoning completely alone', async () => {
    // 191 characters is the worst of the eight healthy free models. Nothing near the cap.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseFrom([
          { reasoning_content: 'y'.repeat(191) },
          { content: 'Bitcoin is trading at the price the API returned.' },
        ]),
      ),
    )

    const history: ChatMessage[] = []
    const events = await collect(runAgent(history, 'What is the price of Bitcoin?', baseOpts))

    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
    expect(events.some((e) => e.type === 'done')).toBe(true)
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.text)
      .join('')
    expect(text).toContain('Bitcoin is trading')
  })

  it('reports a model that returns nothing at all rather than ending in silence', async () => {
    // Measured: nemotron-3-nano-omni answered a direct request with 200 OK, zero content,
    // zero reasoning and zero tool calls, in 21.7s. The loop saw no tool calls and emitted
    // `done`, so the UI stopped its spinner and showed an empty bubble — a turn that looks
    // finished and answered nothing.
    vi.stubGlobal('fetch', vi.fn(async () => sseFrom([])))

    const history: ChatMessage[] = []
    const events = await collect(runAgent(history, 'What is the price of Bitcoin?', baseOpts))

    const spoken = events.filter((e) => e.type === 'error' || e.type === 'notice')
    expect(spoken.length).toBeGreaterThan(0)
    expect(spoken.map((e) => e.text).join(' ')).toMatch(/empty|nothing|no answer/i)
  })

  it('does not call an empty answer a failure when a tool call is what came back', async () => {
    // An assistant turn carrying only tool_calls has no content BY DESIGN — that is the
    // normal first step of every tool-using turn. Reporting it as empty would break the
    // whole agent flow, and the naive form of the check above does exactly that.
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/marketplace/apis')) {
          return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })
        }
        call += 1
        if (call === 1) {
          return sseFrom([
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'c1',
                  type: 'function',
                  function: { name: 'search_apis', arguments: '{"query":"bitcoin price"}' },
                },
              ],
            },
          ])
        }
        return sseFrom([{ content: 'Nothing in the catalogue matched.' }])
      }),
    )

    const history: ChatMessage[] = []
    const events = await collect(runAgent(history, 'What is the price of Bitcoin?', baseOpts))

    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
    expect(events.some((e) => e.type === 'tool-start')).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })
})
