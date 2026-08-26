import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgent, SYSTEM_PROMPT, type AgentEvent } from './agent'
import type { ChatMessage } from './gateway'
import { toolNames, toolSchemas, tools, type ToolContext } from './tools'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Not doing six tool calls for a one-sentence question.
 *
 * The reported case: "北京时间是几点？然后用英文怎么说？" produced five `search_apis` calls, one
 * `list_models`, a long reasoning block, and then a wrong answer — "I don't have access to a
 * real-time clock API". Three separate defects behind it:
 *
 *   1. the prompt's first rule was "always search before saying an API does not exist", with nothing
 *      counterweighting it, so a question answerable from the model's own knowledge became a
 *      catalogue hunt;
 *   2. an anonymous session is not offered `call_api` at all, so it can search the catalogue and
 *      never invoke anything in it — and nothing told the model that, so it searched for a
 *      capability it had no way to use and then invented a reason it had failed;
 *   3. nothing stopped a reworded retry of a search that had already come back empty.
 *
 * The catalogue does have a clock (id 447, $0.006, current local time by city). It could not have
 * been called from that session either way, which is what makes the wrong answer worse than the
 * wasted steps: the product looked less capable than it is.
 */

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function sse(frames: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(encoder.encode(f))
        c.close()
      },
    }),
    { status: 200 },
  )
}

/** One scripted model turn per entry; catalogue fetches are served separately. */
function stubTurns(turns: string[][]) {
  let i = 0
  const searches: string[] = []
  const mock = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/marketplace/apis')) {
      searches.push(new URL(url).searchParams.get('q') ?? '')
      return new Response(JSON.stringify({ data: { items: [], total: 0 } }), { status: 200 })
    }
    const t = turns[Math.min(i, turns.length - 1)]
    i++
    return sse(t)
  })
  vi.stubGlobal('fetch', mock)
  return { mock, searches }
}

/** A model turn that asks for one `search_apis` call. */
function searchTurn(id: string, query: string): string[] {
  return [
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: { name: 'search_apis', arguments: JSON.stringify({ query }) },
              },
            ],
          },
        },
      ],
    }),
  ]
}

const anon = {
  baseUrl: 'https://gw.test',
  cred: {},
  anonymous: true,
  model: 'test/model',
  confirmSpend: async () => false,
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('the free session is told the price, not that the capability is missing', () => {
  it('frames the limit as a price and forbids denying a catalogued capability', async () => {
    /**
     * These two assertions replaced their own opposites, and the reversal is the point.
     *
     * The first version of this test asserted the prompt said "CANNOT call any external API" — the
     * wrong lesson drawn from the right measurement. Verified against Franklin's live gateway: a
     * walletless request to a paid endpoint returns 402 WITH the price
     * (`/v1/search` → `{"amount":"0.2625","perSourceCost":0.025}`), not a refusal. So the honest
     * framing is "it costs this much and you cannot pay yet", and the failure to prevent is the model
     * telling a user the product cannot do something it can.
     */
    stubTurns([[frame({ choices: [{ delta: { content: 'ok' } }] })]])
    const history: ChatMessage[] = []
    await collect(runAgent(history, 'hello', anon))

    const prompt = String(history[0].content)
    expect(prompt).toMatch(/cannot complete a paid call/)
    expect(prompt).toMatch(/Never tell the user a capability does not exist/)
    expect(prompt).toMatch(/connecting a wallet or signing in/)
    // The old absolute must not come back: it is what made the model invent reasons.
    expect(prompt).not.toMatch(/CANNOT call any external API/)
  })

  it('keeps the catalogue rule for every session, paying or not', async () => {
    // Also reversed. The rule used to be withheld from anonymous sessions, which is precisely what
    // Franklin's source calls anti-positioning — an agent that answers from training data instead of
    // reaching for the catalogue it is built on.
    for (const anonymous of [true, false]) {
      stubTurns([[frame({ choices: [{ delta: { content: 'ok' } }] })]])
      const history: ChatMessage[] = []
      await collect(runAgent(history, 'hello', { ...anon, anonymous }))
      expect(String(history[0].content)).toMatch(
        /Use search_apis before saying an API does not exist/,
      )
    }
  })

  it('leaves the paying session prompt free of the cannot-pay note', async () => {
    stubTurns([[frame({ choices: [{ delta: { content: 'ok' } }] })]])
    const history: ChatMessage[] = []
    await collect(runAgent(history, 'hello', { ...anon, anonymous: false }))
    expect(String(history[0].content)).not.toMatch(/cannot complete a paid call/)
    expect(String(history[0].content)).toBe(SYSTEM_PROMPT)
  })

  it('tells every session to answer directly when it already knows', async () => {
    // The counterweight that was missing. Checked for both session kinds because the overthinking is
    // not specific to the anonymous one — it was just worst there.
    for (const anonymous of [true, false]) {
      stubTurns([[frame({ choices: [{ delta: { content: 'ok' } }] })]])
      const history: ChatMessage[] = []
      await collect(runAgent(history, 'hello', { ...anon, anonymous }))
      expect(String(history[0].content)).toMatch(/Answer directly when you already know/)
    }
  })

  it('replaces the prompt when a wallet arrives mid-conversation', async () => {
    /**
     * Connecting a wallet flips `anonymous`, which changes the advertised tools. If the original
     * prompt stayed, a now-payment-capable session would still be told it cannot call anything — and
     * the tool list would contradict its own instructions, which models resolve by ignoring the
     * tools.
     */
    stubTurns([[frame({ choices: [{ delta: { content: 'ok' } }] })]])
    const history: ChatMessage[] = []
    await collect(runAgent(history, 'first', anon))
    expect(String(history[0].content)).toMatch(/cannot complete a paid call/)

    stubTurns([[frame({ choices: [{ delta: { content: 'ok' } }] })]])
    await collect(runAgent(history, 'second', { ...anon, anonymous: false }))
    expect(String(history[0].content)).not.toMatch(/cannot complete a paid call/)
    // Still exactly one system message — replaced, not prepended.
    expect(history.filter((m) => m.role === 'system')).toHaveLength(1)
  })
})

describe('every tool is offered to every session', () => {
  it('advertises call_api even with no way to pay', () => {
    /**
     * The change this whole file exists for. `call_api` used to be filtered out of an anonymous
     * session, and the measured cost was the model telling a user "I don't have access to a real-time
     * clock API" while the catalogue held one at id 447 for $0.006.
     *
     * Franklin, verified live: all 53 of its tools are visible to a walletless session, and its
     * `ActivateTool` split gates on call frequency and cost, never on ability to pay — its own source
     * calls the alternative anti-positioning.
     */
    const anonNames = toolNames({ anonymous: true })
    const paidNames = toolNames({ anonymous: false })
    expect(anonNames).toContain('call_api')
    expect(anonNames).toEqual(paidNames)
    expect(toolSchemas({ anonymous: true })).toHaveLength(toolSchemas({ anonymous: false }).length)
  })

  it('puts the price in each tool description', () => {
    // Franklin's convention: 'Neural web search via Exa ($0.01/call)'. A model choosing between tools
    // should see the cost at the point of choosing rather than discovering it from the result.
    const byName = new Map(
      toolSchemas({ anonymous: true }).map((s) => [s.function.name, s.function.description]),
    )
    expect(byName.get('search_apis')).toMatch(/free, no charge/i)
    expect(byName.get('list_models')).toMatch(/free, no charge/i)
    const callApi = byName.get('call_api') ?? ''
    expect(callApi).toMatch(/PAID/)
    // A concrete range, not just the word "paid" — the model needs a magnitude to reason about.
    expect(callApi).toMatch(/\$0\.\d+/)
    // And it must say what happens without a credential, so the model reports rather than concludes.
    expect(callApi).toMatch(/returns the price instead of calling/)
  })
})

describe('a paid call with no wallet reports the price', () => {
  const priced: ToolContext = {
    baseUrl: 'https://gw.test',
    cred: {},
    anonymous: true,
    confirmSpend: async () => {
      throw new Error('confirmSpend must not be called when the session cannot pay')
    },
  }

  function stubCatalogue(row: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: row }), { status: 200 })),
    )
  }

  it('names the API, its price, and how to unlock it', async () => {
    stubCatalogue({ resource_id: 447, name: 'Timezone Lookup', display_price: 0.00575 })
    const res = await tools.call_api.run({ id: 447 }, priced)

    expect(res.spentUsd).toBe(0)
    expect(res.unpayable).toBe(true)
    expect(res.output).toContain('Timezone Lookup')
    expect(res.output).toContain('0.005750')
    expect(res.output).toMatch(/connecting a wallet or signing in/)
    // The instruction that prevents the observed failure: the model must not report the capability as
    // absent when it has just been handed the API's name and price.
    expect(res.output).toMatch(/Tell the user the API exists/)
  })

  it('is not marked as declined', async () => {
    // `declined` means the user refused, which may be reversed a minute later. This is a property of
    // the session — conflating them would either cache a refusal that should not stick, or fail to
    // stop a retry that cannot succeed.
    stubCatalogue({ resource_id: 1, name: 'Anything', display_price: 0.01 })
    const res = await tools.call_api.run({ id: 1 }, priced)
    expect(res.declined).toBeUndefined()
  })

  it('never prompts for approval it cannot honour', async () => {
    // `confirmSpend` throws in this context. Asking someone to approve a charge they have no means to
    // pay is a dialog that can only end in disappointment.
    stubCatalogue({ resource_id: 2, name: 'Something', display_price: 0.02 })
    await expect(tools.call_api.run({ id: 2 }, priced)).resolves.toBeTruthy()
  })
})

describe('an identical tool call is not run twice', () => {
  it('serves a repeated search from the first result', async () => {
    const { searches } = stubTurns([
      searchTurn('c1', 'current time'),
      // Same query, reworded only in case and spacing — which is exactly how the observed retries
      // differed from each other.
      searchTurn('c2', 'Current  Time'),
      [frame({ choices: [{ delta: { content: 'done' } }] })],
    ])

    const events = await collect(runAgent([], 'what time is it', anon))

    // One network search for two requested calls.
    expect(searches).toEqual(['current time'])
    // Both calls still reported to the UI: hiding the second would make the transcript disagree with
    // what the model actually did.
    expect(events.filter((e) => e.type === 'tool-start')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'tool-end')).toHaveLength(2)
    // The run still reaches an answer rather than stalling on the deduplicated call.
    expect(events.at(-1)?.type).toBe('done')
  })

  it('tells the model the repeat changed nothing', async () => {
    stubTurns([
      searchTurn('c1', 'current time'),
      searchTurn('c2', 'current time'),
      [frame({ choices: [{ delta: { content: 'done' } }] })],
    ])
    const history: ChatMessage[] = []
    await collect(runAgent(history, 'what time is it', anon))

    const toolMessages = history.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    // The second answer carries the original result AND an explicit instruction. The result is
    // repeated rather than replaced by an error, because an error invites another wording while the
    // same data plus a note is what lets the model conclude.
    expect(String(toolMessages[1].content)).toMatch(/identical call you already made/)
    expect(String(toolMessages[1].content)).toMatch(/No APIs matched/)
  })

  it('charges once when a paid tool is called twice the same way', async () => {
    // A correctness property, not only a speed one: the cache means a duplicated paid call cannot
    // spend twice.
    stubTurns([
      searchTurn('c1', 'x'),
      searchTurn('c2', 'x'),
      [frame({ choices: [{ delta: { content: 'done' } }] })],
    ])
    const events = await collect(runAgent([], 'q', anon))
    const spends = events.filter((e) => e.type === 'tool-end').map((e) => e.spentUsd ?? 0)
    expect(spends).toHaveLength(2)
    expect(spends[1]).toBe(0)
  })

  it('does not cache across user messages', async () => {
    // A later message is a fresh question and the catalogue may genuinely have changed. Caching
    // across messages would make the second ask unanswerable without reloading.
    // Four scripted turns, because two messages each take two: the search, then the answer. Scripting
    // only two made the second message reuse the last entry — a plain answer with no search — so the
    // test failed on its own stub rather than on the cache.
    const { searches } = stubTurns([
      searchTurn('c1', 'current time'),
      [frame({ choices: [{ delta: { content: 'done' } }] })],
      searchTurn('c2', 'current time'),
      [frame({ choices: [{ delta: { content: 'done again' } }] })],
    ])
    const history: ChatMessage[] = []
    await collect(runAgent(history, 'first', anon))
    await collect(runAgent(history, 'second', anon))
    expect(searches).toEqual(['current time', 'current time'])
  })
})
