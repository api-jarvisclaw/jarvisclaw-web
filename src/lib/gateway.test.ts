import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  authHeaders,
  streamChat,
  GatewayError,
  isRateLimited,
  isStreamingUnsupported,
} from './gateway'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authHeaders', () => {
  it('sends NO Authorization header when there is no key', () => {
    // The anonymous free tier recognises a request by the absence of any auth header.
    // A placeholder — "Bearer anonymous", "Bearer none", even "Bearer " — is treated as
    // a real credential, fails to resolve, and answers 401. This is the single rule
    // that makes the zero-config first run work at all.
    const headers = authHeaders({})
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('treats a blank or whitespace key as no key', () => {
    expect(authHeaders({ apiKey: '' })).not.toHaveProperty('Authorization')
    expect(authHeaders({ apiKey: '   ' })).not.toHaveProperty('Authorization')
  })

  it('sends a bearer token when a key is present', () => {
    expect(authHeaders({ apiKey: 'sk-abc' }).Authorization).toBe('Bearer sk-abc')
  })

  it('trims a pasted key', () => {
    // Copying a key out of a dashboard commonly brings whitespace with it, and the
    // gateway would reject the padded value.
    expect(authHeaders({ apiKey: '  sk-abc\n' }).Authorization).toBe('Bearer sk-abc')
  })
})

/** Builds a fetch stub that streams the given SSE text in the given byte-chunks. */
function stubStream(chunks: string[]) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200 })),
  )
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

describe('streamChat', () => {
  it('accumulates assistant text and reports the model that answered', async () => {
    stubStream([
      frame({ model: 'nvidia/nemotron-3-super-120b', choices: [{ delta: { content: 'Hel' } }] }),
      frame({ choices: [{ delta: { content: 'lo' } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ])

    const seen: string[] = []
    const res = await streamChat({ messages: [] }, (d) => {
      if (d.content) seen.push(d.content)
    })

    expect(res.content).toBe('Hello')
    expect(seen).toEqual(['Hel', 'lo'])
    expect(res.finishReason).toBe('stop')
    // auto/free resolves per request, so the concrete model is only knowable from the
    // response. Reporting the requested name instead would tell the user "auto/free"
    // answered, which names no model at all.
    expect(res.model).toBe('nvidia/nemotron-3-super-120b')
  })

  it('keeps reasoning separate from the answer', async () => {
    // Several free models emit most of their output as reasoning_content. Folding it
    // into content would show the user the model's scratchpad as the answer.
    stubStream([
      frame({ choices: [{ delta: { reasoning_content: 'The user wants' } }] }),
      frame({ choices: [{ delta: { content: 'Hi' } }] }),
    ])

    const res = await streamChat({ messages: [] }, () => {})
    expect(res.reasoning).toBe('The user wants')
    expect(res.content).toBe('Hi')
  })

  it('reassembles a frame split across byte chunks', async () => {
    // A chunk boundary can fall anywhere, including inside a JSON payload. Parsing per
    // chunk instead of per frame drops whatever straddled the split.
    const whole = frame({ choices: [{ delta: { content: 'split-safe' } }] })
    const cut = Math.floor(whole.length / 2)
    stubStream([whole.slice(0, cut), whole.slice(cut)])

    const res = await streamChat({ messages: [] }, () => {})
    expect(res.content).toBe('split-safe')
  })

  it('assembles a tool call whose name and arguments arrive in separate frames', async () => {
    stubStream([
      frame({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search_apis' } }] } },
        ],
      }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"gas"}' } }] } }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])

    const res = await streamChat({ messages: [] }, () => {})
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0].function.name).toBe('search_apis')
    expect(JSON.parse(res.toolCalls[0].function.arguments)).toEqual({ query: 'gas' })
  })

  it('keeps two parallel tool calls apart by index', async () => {
    // Appending in arrival order rather than by index interleaves the two argument
    // strings into one corrupt pair — and the corruption looks like a model error.
    stubStream([
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'search_apis', arguments: '{"q":"one"' } },
                { index: 1, id: 'b', function: { name: 'list_models', arguments: '{"free_only"' } },
              ],
            },
          },
        ],
      }),
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: ':true}' } },
                { index: 0, function: { arguments: '}' } },
              ],
            },
          },
        ],
      }),
    ])

    const res = await streamChat({ messages: [] }, () => {})
    expect(res.toolCalls.map((c) => c.function.name)).toEqual(['search_apis', 'list_models'])
    expect(JSON.parse(res.toolCalls[0].function.arguments)).toEqual({ q: 'one' })
    expect(JSON.parse(res.toolCalls[1].function.arguments)).toEqual({ free_only: true })
  })

  it('does not remap index 0 onto the array position', async () => {
    // `index ?? i` rather than `index || i`: index 0 is falsy, so the || form would
    // send every index-0 fragment to whichever array slot it happened to occupy, and
    // two calls in one frame would merge.
    stubStream([
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'b', function: { name: 'list_models', arguments: '{}' } },
                { index: 0, id: 'a', function: { name: 'search_apis', arguments: '{"q":"x"}' } },
              ],
            },
          },
        ],
      }),
    ])

    const res = await streamChat({ messages: [] }, () => {})
    expect(res.toolCalls).toHaveLength(2)
    expect(res.toolCalls[0].function.name).toBe('search_apis')
    expect(res.toolCalls[1].function.name).toBe('list_models')
  })

  it('skips one malformed frame instead of losing the whole answer', async () => {
    stubStream([
      frame({ choices: [{ delta: { content: 'be' } }] }),
      'data: {not json at all\n\n',
      frame({ choices: [{ delta: { content: 'fore' } }] }),
    ])

    const res = await streamChat({ messages: [] }, () => {})
    expect(res.content).toBe('before')
  })

  it('reads a final frame that arrives with no trailing blank line', async () => {
    stubStream([`data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`])
    const res = await streamChat({ messages: [] }, () => {})
    expect(res.content).toBe('tail')
  })

  it('drops a tool call that never received a name', async () => {
    // A nameless call cannot be dispatched, and forwarding it would have the agent
    // answer a tool_call_id for a tool that does not exist.
    stubStream([frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x' }] } }] })])
    const res = await streamChat({ messages: [] }, () => {})
    expect(res.toolCalls).toHaveLength(0)
  })

  it('surfaces the gateway rate limit as its own condition', async () => {
    // The free tier is limited per IP, and 429 is not a bug — the UI has to say
    // "wait a moment", not "something went wrong".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'too many requests' }), { status: 429 })),
    )
    const err = await streamChat({ messages: [] }, () => {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(isRateLimited(err)).toBe(true)
  })

  it('reports the gateway error message rather than the status alone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }),
      ),
    )
    const err = (await streamChat({ messages: [] }, () => {}).catch((e: unknown) => e)) as GatewayError
    expect(err.message).toBe('model not found')
  })

  it('omits the tools field entirely when there are none', async () => {
    // An empty tools array is not the same as no tools: some upstreams reject `[]`, and
    // the anonymous session legitimately has a non-empty list while a bare chat has none.
    let sentBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = String(init?.body ?? '')
        return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 })
      }),
    )

    await streamChat({ messages: [], tools: [] }, () => {})
    expect(JSON.parse(sentBody)).not.toHaveProperty('tools')
  })
})

/**
 * A model that cannot stream must be retried, not reported.
 *
 * The defect: a user asked "北京时间" and the assistant's reply was the sentence "Streaming not
 * supported for this model. Set stream: false" — in English, in a Chinese UI, instructing the
 * reader to change a JSON field they never wrote, for a call that had ALREADY BEEN PAID for. The
 * 402 quote cannot catch it: measured on the live gateway, `stream: true` and `stream: false` are
 * both quoted at $0.001, so the price is identical whether the call is about to work or fail.
 */
describe('a model that refuses streaming', () => {
  it('recognises the refusal, and only that', () => {
    const refusal = new GatewayError(
      'Streaming not supported for this model. Set stream: false',
      400,
    )
    expect(isStreamingUnsupported(refusal)).toBe(true)
    // Wording varies across upstreams; the classifier reads the message because the gateway
    // reports no distinct code for it.
    expect(isStreamingUnsupported(new GatewayError('stream is unsupported here', 400))).toBe(true)

    // The falsifier: unrelated failures must NOT be swallowed into a silent retry. A classifier
    // that matched too widely would turn an auth error or a dead model into a second charge and a
    // second failure, with the real reason never shown.
    for (const other of [
      'Unknown model: zai/glm-4-flash',
      'insufficient balance: need at least $0.50',
      'rate limited, try again',
      'the gateway answered 500',
      /**
       * MEASURED, and the reason this classifier stays narrow.
       *
       * `openai/text-embedding-3-small` answers exactly this on /v1/chat/completions, and it is
       * tempting to treat "unsupported" as a streaming refusal. It is not: the SAME 400 comes back
       * with `stream: false`, because an embedding model is not a chat model at all. Retrying would
       * spend a second charge, fail again, and hide the real reason.
       */
      'The requested operation is unsupported.',
    ]) {
      expect(isStreamingUnsupported(new GatewayError(other, 400)), other).toBe(false)
    }
    // Not every thrown value is a GatewayError.
    expect(isStreamingUnsupported(new Error('Streaming not supported'))).toBe(false)
  })

  it('retries without streaming and delivers the answer through onDelta', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { stream?: boolean }
        calls.push(body.stream ? 'stream' : 'complete')
        if (body.stream) {
          return new Response(
            JSON.stringify({
              error: { message: 'Streaming not supported for this model. Set stream: false' },
            }),
            { status: 400 },
          )
        }
        return new Response(
          JSON.stringify({
            model: 'gemini-3.5-flash',
            choices: [
              {
                message: { content: '北京时间是 21:13。', reasoning_content: 'checking the clock' },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200 },
        )
      }),
    )

    const deltas: string[] = []
    const result = await streamChat({ messages: [{ role: 'user', content: '北京时间' }] }, (d) => {
      if (d.content) deltas.push(d.content)
    })

    // Retried once, unstreamed — not reported to the user as an error.
    expect(calls).toEqual(['stream', 'complete'])
    expect(result.content).toBe('北京时间是 21:13。')
    // Read under BOTH spellings: `reasoning` and `reasoning_content` are each used by models we
    // serve, and reading one only would put a model's thinking into the void.
    expect(result.reasoning).toBe('checking the clock')
    // The UI renders from deltas, so a fallback that only returned a value would leave an empty
    // bubble until the promise settled.
    expect(deltas).toEqual(['北京时间是 21:13。'])
    expect(result.model).toBe('gemini-3.5-flash')
  })

  it('carries tool calls through the fallback', async () => {
    // Without this, a non-streaming model that asked for a tool would look like it answered in
    // prose, and the agent loop would end the turn — a silent wrong answer rather than a visible
    // error, which is worse than the message this replaces.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { stream?: boolean }
        if (body.stream) {
          return new Response(
            JSON.stringify({ error: { message: 'Streaming not supported for this model' } }),
            { status: 400 },
          )
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'search_apis', arguments: '{"query":"time"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200 },
        )
      }),
    )

    const result = await streamChat({ messages: [{ role: 'user', content: 'hi' }] }, () => {})
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.name).toBe('search_apis')
    expect(result.finishReason).toBe('tool_calls')
  })

  it('does not retry a failure that is not about streaming', async () => {
    // One call, and the real error surfaces. A retry here would charge twice and hide the cause.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Unknown model: zai/glm-4-flash' } }), {
          status: 400,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamChat({ messages: [{ role: 'user', content: 'hi' }] }, () => {}),
    ).rejects.toThrow(/unknown model/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
