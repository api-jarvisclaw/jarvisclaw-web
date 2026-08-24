import { describe, expect, it, vi, afterEach } from 'vitest'

import { runAgent, SYSTEM_PROMPT, type AgentEvent } from './agent'
import type { ChatMessage } from './gateway'

afterEach(() => {
  vi.unstubAllGlobals()
})

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f))
        controller.close()
      },
    }),
    { status: 200 },
  )
}

/** Serves one scripted SSE response per model turn, in order. */
function stubTurns(turns: string[][]) {
  let i = 0
  const mock = vi.fn(async () => {
    const t = turns[Math.min(i, turns.length - 1)]
    i++
    return sseResponse(t)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/**
 * Pins the model so these tests exercise the loop, not model selection.
 *
 * Without a pin the loop consults the ModelRouter, which spends a fetch on
 * /api/discovery/free-models — shifting every scripted turn by one and making a loop
 * test fail for a reason that has nothing to do with the loop. Downgrade behaviour has
 * its own tests in route.test.ts and below.
 */
const baseOpts = {
  baseUrl: 'https://gw.test',
  cred: {},
  anonymous: false,
  model: 'test/model',
  confirmSpend: async () => true,
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('runAgent', () => {
  it('answers a plain question without any tools', async () => {
    stubTurns([[frame({ choices: [{ delta: { content: 'Hi there' } }] })]])
    const history: ChatMessage[] = []

    const events = await collect(runAgent(history, 'hello', baseOpts))

    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('Hi there')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('installs the system prompt exactly once', async () => {
    stubTurns([[frame({ choices: [{ delta: { content: 'ok' } }] })]])
    const history: ChatMessage[] = []

    await collect(runAgent(history, 'one', baseOpts))
    await collect(runAgent(history, 'two', baseOpts))

    expect(history.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(history[0].content).toBe(SYSTEM_PROMPT)
  })

  it('runs a tool the model asked for, then answers with the result', async () => {
    stubTurns([
      [
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'list_models', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      ],
      [frame({ choices: [{ delta: { content: 'Found them.' } }] })],
    ])
    // The tool itself calls the gateway, so the third fetch is its own. Serving the
    // discovery shape keeps this a test of the loop, not of the tool.
    const history: ChatMessage[] = []

    const events = await collect(runAgent(history, 'what models?', baseOpts))

    expect(events.some((e) => e.type === 'tool-start' && e.tool === 'list_models')).toBe(true)
    expect(events.some((e) => e.type === 'tool-end')).toBe(true)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('always answers every tool_call_id, even for an unknown tool', async () => {
    // An assistant turn carrying tool_calls whose ids are not all answered is rejected
    // on the NEXT request, so one unanswered call breaks the whole conversation rather
    // than just that step.
    stubTurns([
      [
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'ghost', function: { name: 'no_such_tool', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      ],
      [frame({ choices: [{ delta: { content: 'ok' } }] })],
    ])
    const history: ChatMessage[] = []

    await collect(runAgent(history, 'do it', baseOpts))

    const assistantCalls = history
      .filter((m) => m.role === 'assistant' && m.tool_calls)
      .flatMap((m) => m.tool_calls!)
    const answeredIds = history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    for (const call of assistantCalls) {
      expect(answeredIds).toContain(call.id)
    }
  })

  it('tells the model when its arguments were not valid JSON', async () => {
    // Reported back rather than thrown: a malformed argument string is something the
    // model can fix next turn, and failing the run would waste the whole message.
    stubTurns([
      [
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'list_models', arguments: '{oops' } },
                ],
              },
            },
          ],
        }),
      ],
      [frame({ choices: [{ delta: { content: 'retrying' } }] })],
    ])
    const history: ChatMessage[] = []

    const events = await collect(runAgent(history, 'go', baseOpts))

    const end = events.find((e) => e.type === 'tool-end')
    expect(end?.result).toContain('not valid JSON')
    expect(history.some((m) => m.role === 'tool' && m.content.includes('not valid JSON'))).toBe(true)
  })

  it('stops after the turn cap instead of looping forever', async () => {
    // A model that keeps calling a failing tool would otherwise burn the free tier's
    // per-IP allowance and, once a wallet exists, real money.
    stubTurns([
      [
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c', function: { name: 'list_models', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      ],
    ])
    const history: ChatMessage[] = []

    const events = await collect(runAgent(history, 'loop', { ...baseOpts, maxTurns: 3 }))

    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.text).toContain('3 steps')
  })

  it('reports a gateway failure as an error event rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'upstream down' }), { status: 502 })),
    )
    const history: ChatMessage[] = []

    const events = await collect(runAgent(history, 'hi', baseOpts))

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect(events[0].text).toContain('upstream down')
  })

  it('keeps the assistant tool-call turn in history', async () => {
    // Dropping it makes the model re-plan from scratch on the next message and re-run
    // tools it already paid for.
    stubTurns([
      [
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'list_models', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      ],
      [frame({ choices: [{ delta: { content: 'done' } }] })],
    ])
    const history: ChatMessage[] = []

    await collect(runAgent(history, 'go', baseOpts))

    expect(history.some((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0)).toBe(true)
  })
})

describe('runAgent downgrade', () => {
  // The live defect this exists for (2026-08-24): auto/free resolved to
  // zai/glm-4-flash and the request came back "Unknown model: zai/glm-4-flash", while
  // that same model requested by name worked. A client that trusts one virtual model
  // name has no first run at all when that happens.

  /** Serves the free-model list, then fails once with an unavailability, then answers. */
  function stubDowngrade() {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/free-models')) {
          return new Response(
            JSON.stringify({ free: [{ model: 'nvidia/step-3.7-flash', free: true }] }),
            { status: 200 },
          )
        }
        call++
        if (call === 1) {
          return new Response(
            JSON.stringify({ error: { message: 'Unknown model: zai/glm-4-flash' } }),
            { status: 500 },
          )
        }
        return sseResponse([frame({ model: 'nvidia/step-3.7-flash', choices: [{ delta: { content: 'recovered' } }] })])
      }),
    )
  }

  const unpinned = {
    baseUrl: 'https://gw.test',
    cred: {},
    anonymous: true,
    confirmSpend: async () => true,
  }

  it('falls back to a named free model and still answers', async () => {
    stubDowngrade()
    const events = await collect(runAgent([], 'hello', unpinned))

    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('recovered')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('says that it downgraded rather than swapping silently', async () => {
    // A downgrade changes which model answered. Hiding it makes an unexplained quality
    // drop look like the model got worse on its own.
    stubDowngrade()
    const events = await collect(runAgent([], 'hello', unpinned))

    const note = events.find((e) => e.type === 'downgrade')
    expect(note).toBeDefined()
    expect(note?.text).toContain('unavailable')
  })

  it('reports which concrete model finally answered', async () => {
    stubDowngrade()
    const events = await collect(runAgent([], 'hello', unpinned))
    expect(events.find((e) => e.type === 'done')?.model).toBe('nvidia/step-3.7-flash')
  })

  it('does not downgrade away from a model the user pinned', async () => {
    // The user chose that model; answering from a different one without saying so is
    // worse than reporting the failure.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Unknown model: test/model' } }), {
          status: 500,
        }),
      ),
    )
    const events = await collect(runAgent([], 'hello', { ...unpinned, model: 'test/model' }))

    expect(events.some((e) => e.type === 'downgrade')).toBe(false)
    expect(events.at(-1)?.type).toBe('error')
  })

  it('gives up with an explanation when every free model is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/free-models')) {
          return new Response(JSON.stringify({ free: [{ model: 'nvidia/a', free: true }] }), {
            status: 200,
          })
        }
        return new Response(JSON.stringify({ error: { message: 'Unknown model: whatever' } }), {
          status: 500,
        })
      }),
    )
    const events = await collect(runAgent([], 'hello', unpinned))

    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.text).toContain('unavailable')
    // Every candidate must have been attempted before giving up, or the fallback is
    // decorative.
    expect(events.filter((e) => e.type === 'downgrade').length).toBeGreaterThan(0)
  })

  it('does not downgrade on a rate limit', async () => {
    // 429 says nothing about the model. Retiring candidates over it would exhaust the
    // list during one busy minute and leave nothing for when capacity returns.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/free-models')) {
          return new Response(JSON.stringify({ free: [{ model: 'nvidia/a', free: true }] }), {
            status: 200,
          })
        }
        return new Response(JSON.stringify({ error: 'too many requests' }), { status: 429 })
      }),
    )
    const events = await collect(runAgent([], 'hello', unpinned))

    expect(events.some((e) => e.type === 'downgrade')).toBe(false)
    expect(events.at(-1)?.type).toBe('error')
    expect(events.at(-1)?.text).toContain('too many requests')
  })
})

describe('SYSTEM_PROMPT', () => {
  it('does not tell the model a human will confirm the charge', () => {
    // Measured behaviour, not style: saying the user will be asked makes the model
    // narrate the request and stop — it treats "I asked" as the completed action and
    // never emits the tool call. The confirmation is real, it just happens outside the
    // model's turn.
    const lowered = SYSTEM_PROMPT.toLowerCase()
    expect(lowered).not.toContain('will be asked')
    expect(lowered).not.toContain('ask the user for permission')
    expect(lowered).not.toContain('user will confirm')
  })

  it('tells the model to search before concluding an API does not exist', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('search_apis before')
  })
})

/**
 * A 402 in the chat path.
 *
 * The bug these cover, reported from the deployed site: picking a paid chat model rendered
 * the entire x402 challenge into the transcript — `accepts`, `payTo`, base64 and all — where
 * a price should have been. It read as a broken app, and there was nothing to act on.
 */
const CHALLENGE = {
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '5282',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0xDC59fa7b64988B846e76eC9849bb68f889071506',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
    // The gateway quotes Solana alongside Base. An EVM wallet cannot sign it.
    {
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '5282',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      payTo: '596XUXmD8PXxvrxXUfqYH4qAozYDqqMwmHQ1C7BuDZ3E',
    },
  ],
  x402Version: 2,
}

function stub402ThenOk(frames: string[]) {
  let n = 0
  const mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    n++
    const headers = (init?.headers ?? {}) as Record<string, string>
    // Second call is only served when it actually carries the payment, so a test cannot
    // pass by retrying without one.
    if (n === 1 || headers['X-PAYMENT'] === undefined) {
      return new Response(JSON.stringify(CHALLENGE), { status: 402 })
    }
    return sseResponse(frames)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('paid chat models', () => {
  it('reports the price instead of the raw challenge when there is no wallet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(CHALLENGE), { status: 402 })),
    )
    const history: ChatMessage[] = []
    const events = await collect(
      runAgent(history, 'hi', { ...baseOpts, anonymous: true, model: 'openai/gpt-4o-mini' }),
    )

    const errors = events.filter((e) => e.type === 'error')
    const notices = events.filter((e) => e.type === 'notice')
    // The failing behaviour: a raw challenge body arriving as an error.
    for (const e of errors) {
      expect(e.text ?? '').not.toContain('accepts')
      expect(e.text ?? '').not.toContain('payTo')
    }
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toContain('paid model')
    // Names the way out. A price with no next step is only half an answer.
    expect(notices[0].text).toContain('auto/free')
  })

  it('does not retire a paid model as unavailable', async () => {
    // A 402 means the model is working exactly as intended. Treating it as unservable would
    // silently answer from a free model instead of the one the user picked.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(CHALLENGE), { status: 402 })),
    )
    const events = await collect(
      runAgent([], 'hi', { ...baseOpts, anonymous: true, model: 'openai/gpt-4o-mini' }),
    )
    expect(events.filter((e) => e.type === 'downgrade')).toHaveLength(0)
  })

  it('pays and retries on the same model when a wallet can sign', async () => {
    const mock = stub402ThenOk([
      frame({ choices: [{ delta: { content: 'paid answer' } }] }),
      'data: [DONE]\n\n',
    ])
    const payForChat = vi.fn(
      async (_c: { accepts?: Array<Record<string, unknown>> }, _m: string) => 'BASE64PAYLOAD',
    )

    const events = await collect(
      runAgent([], 'hi', { ...baseOpts, model: 'openai/gpt-4o-mini', payForChat }),
    )

    expect(payForChat).toHaveBeenCalledTimes(1)
    // The challenge is handed over whole: the signature is made over the gateway's own
    // payTo and network, and re-deriving those from a price would be inventing them.
    expect(payForChat.mock.calls[0][0]).toMatchObject({ accepts: expect.any(Array) })
    expect(payForChat.mock.calls[0][1]).toBe('openai/gpt-4o-mini')

    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
    expect(text).toBe('paid answer')

    // Retried on the SAME model, with the payment attached.
    const second = mock.mock.calls[1]
    expect(JSON.parse(String((second[1] as RequestInit).body)).model).toBe('openai/gpt-4o-mini')
    expect(((second[1] as RequestInit).headers as Record<string, string>)['X-PAYMENT']).toBe(
      'BASE64PAYLOAD',
    )
  })

  it('reports a cancellation, not an error, when the user declines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(CHALLENGE), { status: 402 })),
    )
    const events = await collect(
      runAgent([], 'hi', { ...baseOpts, model: 'openai/gpt-4o-mini', payForChat: async () => null }),
    )
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
    const notices = events.filter((e) => e.type === 'notice')
    expect(notices.some((n) => (n.text ?? '').toLowerCase().includes('cancel'))).toBe(true)
  })

  it('does not ask for a second signature when the payment is refused', async () => {
    // A second 402 means settlement failed. Re-signing would ask the user to authorise
    // another transfer for a call that already did not go through.
    const payForChat = vi.fn(
      async (_c: { accepts?: Array<Record<string, unknown>> }, _m: string) => 'PAYLOAD',
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(CHALLENGE), { status: 402 })),
    )
    const events = await collect(
      runAgent([], 'hi', { ...baseOpts, model: 'openai/gpt-4o-mini', payForChat }),
    )
    expect(payForChat).toHaveBeenCalledTimes(1)
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].text).toContain('did not accept the payment')
    expect(errors[0].text ?? '').not.toContain('accepts')
  })
})
