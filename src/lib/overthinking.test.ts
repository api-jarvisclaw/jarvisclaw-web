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

  it('bans inventing live values, unconditionally', async () => {
    /**
     * The rule whose POSITION was the bug, twice.
     *
     * I first put it in `call_api`'s no-payment branch. Two things wrong with that, both measured:
     *
     *   it only fires if the model reaches that branch. The observed failure did not — one
     *   `search_apis`, no `call_api`, then "当前大约是下午 5:19" and "2025年5月29日", both invented on
     *   a day in 2026. A rule inside a tool cannot govern a turn that does not call the tool.
     *
     *   it has nothing to do with payment. A funded session whose call errors or times out invents the
     *   same value for the same reason — the model has no clock, so asked for one it produces a
     *   plausible number rather than a refusal.
     *
     * So it belongs in the prompt, for every session. Asserted for both, because scoping it to the
     * anonymous one would reproduce the second mistake.
     */
    for (const anonymous of [true, false]) {
      stubTurns([[frame({ choices: [{ delta: { content: 'ok' } }] })]])
      const history: ChatMessage[] = []
      await collect(runAgent(history, 'hello', { ...anon, anonymous }))
      const prompt = String(history[0].content)

      expect(prompt).toMatch(/NEVER state a value you did not retrieve/)
      expect(prompt).toMatch(/no clock/)
      // The categories, named. "Do not make things up" is advice the model already believes it
      // follows; what it does not recognise is that a hedged time is making something up.
      expect(prompt).toMatch(/current time or date/)
      // And the approximation loophole closed explicitly — this is the form the failure actually took.
      expect(prompt).toMatch(/Approximations are not exempt/)
      expect(prompt).toMatch(/roughly 5pm/)

      /**
       * The second loophole, and it needed its own sentence because the first rule did not
       * cover it.
       *
       * Measured live: asked for the bitcoin price the model refused correctly, then priced the
       * API at "约 0.14 元人民币". The catalogue is USD, so that took an exchange rate it never
       * retrieved — and got it wrong, since $0.00115 is under one jiao. The rule above bans
       * STATING a rate but says nothing about USING one, and a conversion feels like arithmetic
       * rather than invention.
       */
      expect(prompt).toMatch(/Do NOT convert a price into another currency/)
      expect(prompt).toMatch(/an exchange rate is live data you do not have/)

      /**
       * The brevity rule, which is the largest measured latency win and has nothing to do with
       * tool calls.
       *
       * Measured against the gateway on "解释一下 GIL": first REASONING frame at 1.3-1.8s, first
       * CONTENT frame at 23-91s, because the model writes 3,000-7,500 characters of deliberation
       * first. With this rule: 213 characters and 12.7s. Three runs each, same model.
       *
       * In the prompt rather than as `reasoning_effort: 'low'` — that measured weaker (572 chars,
       * 35.9s) and is not honoured uniformly across the free pool.
       */
      expect(prompt).toMatch(/Think briefly/)
      expect(prompt).toMatch(/do not deliberate at length/)
    }
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
  })

  it('forbids inventing the value it failed to fetch', async () => {
    /**
     * The assertion that came from a measured regression, and it replaced a weaker one.
     *
     * The first wording of this branch ended "Answer whatever part of their question you can without
     * it", which a free-tier model read as licence to answer the whole question from its own
     * knowledge. Live result on "北京时间是几点": "现在时间是 2024年12月30日 04:13" — invented, on a
     * day in 2026, from a tool result containing nothing but a price. It mentioned neither the price
     * nor the wallet.
     *
     * A confidently wrong value is worse than the "I don't have access to a clock API" this replaced:
     * that only made the product look limited, this hands the user false data they cannot check. So
     * the ban has to name the act — stating the value — rather than hint at it.
     */
    stubCatalogue({ resource_id: 447, name: 'Timezone Lookup', display_price: 0.00575 })
    const res = await tools.call_api.run({ id: 447 }, priced)

    expect(res.output).toMatch(/NOT CALLED/)
    expect(res.output).toMatch(/You received NO result/)
    expect(res.output).toMatch(/DO NOT state, guess or estimate/)
    expect(res.output).toMatch(/not even\s+approximately/)
    // The phrase that caused it must not come back.
    expect(res.output).not.toMatch(/Answer whatever part of their question you can/)
  })

  it('carries the price as data, not only as prose', async () => {
    // The model is the unreliable half — it dropped both the price and the wallet from its answer
    // once. The UI renders this so a user is told the capability exists whatever the model says.
    stubCatalogue({ resource_id: 447, name: 'Timezone Lookup', display_price: 0.00575 })
    const res = await tools.call_api.run({ id: 447 }, priced)

    expect(res.unpayableCall).toEqual({ name: 'Timezone Lookup', id: 447, priceUsd: 0.00575 })
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
