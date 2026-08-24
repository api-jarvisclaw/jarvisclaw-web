import { describe, expect, it, vi, afterEach } from 'vitest'

import { authHeaders, streamChat, GatewayError, isRateLimited } from './gateway'

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
