/**
 * The tools the agent can run, and what each one costs the user.
 *
 * Cost tier is the axis that matters for consent, and it is deliberately not the same
 * as "does this need a credential":
 *
 *   free         — costs nothing and needs nothing. Runs without asking, always.
 *   paid         — spends real USDC per call. Gated by the spend policy.
 *
 * A tool that cannot be run anonymously is not a separate tier: it is simply a paid
 * tool whose price the catalogue reports, and the gate that stops it is the same one.
 */

import {
  DEFAULT_BASE_URL,
  getJson,
  postJson,
  type Credential,
  type ToolSchema,
} from './gateway'

export type CostTier = 'free' | 'paid'

export interface ToolContext {
  baseUrl: string
  cred: Credential
  signal?: AbortSignal
  /**
   * Asks the user to approve a charge. Returning false must abort the call, not
   * proceed unpriced — the whole point of the gate.
   */
  confirmSpend: (req: { tool: string; description: string; usd: number }) => Promise<boolean>
  /**
   * True when this session has no way to pay — no wallet and no API key.
   *
   * A paid tool still RUNS in this state, up to the point of pricing: it looks the API up, reports
   * the name and the exact price, and says what would unlock it. That is what the gateway itself
   * does (402 with a price body) and what Franklin does, and it is strictly more useful than the
   * tool being absent — the model learns the capability exists and can tell the user what it costs
   * rather than concluding the product cannot do it.
   */
  anonymous?: boolean
}

export interface ToolResult {
  /** What is fed back to the model. */
  output: string
  /** What was actually spent, in USD. Zero for a free tool. */
  spentUsd: number
  /** Set when the user declined, so the UI can say so rather than showing an error. */
  declined?: boolean
  /**
   * Set when the call could not be paid for at all — no wallet, no key.
   *
   * Distinct from `declined`, which is a decision about this moment and may be reversed a minute
   * later. This is a property of the session, so a second attempt cannot succeed either, and the
   * agent loop uses it to stop retrying for the rest of the message.
   */
  unpayable?: boolean
}

export interface Tool {
  schema: ToolSchema
  tier: CostTier
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

/** Reads a string argument the model may have omitted or sent as the wrong type. */
function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  // Models frequently send numbers as strings; rejecting those would fail a call the
  // model got semantically right.
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

interface RawCatalogueRow {
  resource_id?: number
  id?: number
  name?: string
  description?: string
  category?: string
  method?: string
  path?: string
  display_price?: number
  sell_price?: number
}

/**
 * search_apis — free.
 *
 * The catalogue search is public: no credential, no charge. That is what lets the
 * agent look around before the user has any wallet at all, which is the whole
 * anonymous-first flow.
 *
 * The parameter is `q`. `keyword` is silently ignored by the endpoint, which returns
 * an unfiltered page — a successful-looking response full of irrelevant rows.
 */
const searchApis: Tool = {
  tier: 'free',
  schema: {
    type: 'function',
    function: {
      name: 'search_apis',
      description:
        'Search the catalogue of 4000+ callable APIs by natural-language query (free, no charge). ' +
        'Returns each result with its real per-call price. Search before assuming an API does or ' +
        'does not exist — but do not search twice for the same thing; a reworded query returns the ' +
        'same rows.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the API should do, in plain words.' },
          limit: { type: 'number', description: 'How many results to return (default 8).' },
        },
        required: ['query'],
      },
    },
  },
  async run(args, ctx) {
    const query = str(args, 'query')
    const limit = num(args, 'limit') ?? 8
    const params = new URLSearchParams({ q: query, page: '1', page_size: String(limit) })
    const data = await getJson<{ data?: { items?: RawCatalogueRow[] } | RawCatalogueRow[] }>(
      `/api/marketplace/apis?${params}`,
      { baseUrl: ctx.baseUrl, cred: ctx.cred, signal: ctx.signal },
    )
    const payload = data.data
    const rows = Array.isArray(payload) ? payload : (payload?.items ?? [])
    if (rows.length === 0) {
      return { output: `No APIs matched "${query}".`, spentUsd: 0 }
    }
    const lines = rows.slice(0, limit).map((r) => {
      const id = r.resource_id ?? r.id
      const price = r.display_price ?? r.sell_price ?? 0
      return [
        `id=${id}`,
        `name=${r.name ?? 'unknown'}`,
        `price=$${price.toFixed(6)}/call`,
        r.category ? `category=${r.category}` : '',
        r.description ? `about=${r.description.slice(0, 200)}` : '',
      ]
        .filter(Boolean)
        .join(' | ')
    })
    return { output: lines.join('\n'), spentUsd: 0 }
  },
}

/**
 * list_models — free.
 *
 * Reads the PUBLIC discovery endpoint, not `/v1/models`. The OpenAI-compatible list
 * requires a credential and answers 401 without one, so using it here would break the
 * anonymous path; discovery also carries per-token prices, which means "free" comes
 * from the gateway rather than from a list in this file that would drift.
 */
const listModels: Tool = {
  tier: 'free',
  schema: {
    type: 'function',
    function: {
      name: 'list_models',
      description:
        'List the language models this gateway serves, with their per-token prices (free, no charge).',
      parameters: {
        type: 'object',
        properties: {
          free_only: { type: 'boolean', description: 'Only models that cost nothing.' },
        },
      },
    },
  },
  async run(args, ctx) {
    // Field names are the endpoint's own, verified against prod: the model id is
    // `model` (not `id`), prices are per MILLION tokens, and `free` is computed by the
    // gateway. Trusting the gateway's flag rather than deriving it from the prices
    // keeps "free" meaning what the biller means by it.
    const data = await getJson<{
      data?: Array<{
        model?: string
        free?: boolean
        input_per_m_token_usd?: number
        output_per_m_token_usd?: number
      }>
    }>('/api/discovery/models', { baseUrl: ctx.baseUrl, cred: ctx.cred, signal: ctx.signal })
    const rows = data.data ?? []
    const freeOnly = args.free_only === true
    const shown = rows.filter((m) => !freeOnly || m.free === true).slice(0, 40)
    if (shown.length === 0) {
      return {
        output: freeOnly
          ? 'No zero-cost models are available right now.'
          : 'No models found.',
        spentUsd: 0,
      }
    }
    return {
      output: shown
        .map((m) =>
          m.free
            ? `${m.model} (free)`
            : `${m.model} in=$${m.input_per_m_token_usd}/M out=$${m.output_per_m_token_usd}/M`,
        )
        .join('\n'),
      spentUsd: 0,
    }
  },
}

/**
 * call_api — paid.
 *
 * The only tool that spends money, so it is the only one behind the confirm gate.
 * The price is read from the catalogue BEFORE the call rather than reported after:
 * a charge the user is told about afterwards is not a charge they consented to.
 */
const callApi: Tool = {
  tier: 'paid',
  schema: {
    type: 'function',
    function: {
      name: 'call_api',
      // The price is in the description, following Franklin — its tools read
      // 'Neural web search via Exa ($0.01/call)'. A model choosing between tools should see the
      // cost at the point of choosing, not discover it from the result.
      description:
        'Call one of the catalogue APIs by its id. PAID: the price is per call and varies by API ' +
        '(typically $0.001–$0.05; search_apis reports each one exactly). The user is shown the ' +
        'price and asked to approve before any charge. If this session has no wallet or key, this ' +
        'returns the price instead of calling — report that to the user rather than concluding the ' +
        'capability does not exist.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'The resource id from search_apis.' },
          payload: {
            type: 'object',
            description: 'Arguments for the API, as its documentation describes them.',
          },
        },
        required: ['id'],
      },
    },
  },
  async run(args, ctx) {
    const id = num(args, 'id')
    if (id === undefined) {
      return { output: 'call_api needs a numeric id from search_apis.', spentUsd: 0 }
    }

    // Price first. Quoting from the catalogue means the number shown to the user is
    // the number the gateway will charge, rather than an estimate made here.
    let priceUsd = 0
    let name = `API ${id}`
    try {
      const detail = await getJson<{ data?: RawCatalogueRow }>(`/api/marketplace/apis/${id}`, {
        baseUrl: ctx.baseUrl,
        cred: ctx.cred,
        signal: ctx.signal,
      })
      priceUsd = detail.data?.display_price ?? detail.data?.sell_price ?? 0
      name = detail.data?.name ?? name
    } catch {
      // A failed price lookup must not become a silent unpriced call. Falling through
      // with priceUsd=0 would ask the user to approve "$0.000000" for a call that
      // does cost something, so the call is refused instead.
      return {
        output:
          `Could not read the price for API ${id}, so it was not called. ` +
          `Charging without a confirmed price is not allowed.`,
        spentUsd: 0,
      }
    }

    /**
     * No way to pay: report the price instead of the capability being absent.
     *
     * Deliberately AFTER the price lookup, so the answer names the API and its exact cost. That is
     * the whole difference between this and hiding the tool — the model can now say "this exists,
     * it costs $0.006, connect a wallet" instead of "I don't have access to a clock API", which is
     * what it said when the tool was hidden and which was false.
     *
     * Mirrors the gateway's own 402, which carries a price body rather than a bare refusal, and
     * Franklin's — verified live: /v1/search answers 402 with amount, per-source cost and max
     * results, to a request bearing no credential at all.
     *
     * No `confirmSpend` prompt here: asking someone to approve a charge they have no means to pay
     * is a dialog that can only end in disappointment.
     */
    if (ctx.anonymous) {
      return {
        output:
          `${name} (id ${id}) costs $${priceUsd.toFixed(6)} per call and this session cannot pay ` +
          `for it — there is no wallet connected and no API key. Tell the user the API exists, name ` +
          `it and its price, and say that connecting a wallet or signing in with a JarvisClaw ` +
          `account unlocks it. Answer whatever part of their question you can without it. ` +
          `Do not call call_api again in this session.`,
        spentUsd: 0,
        // Not `declined`: the user refused nothing. Marked unpayable so the agent loop can stop
        // offering the tool for the rest of this message.
        unpayable: true,
      }
    }

    const approved = await ctx.confirmSpend({
      tool: 'call_api',
      description: `${name} (id ${id})`,
      usd: priceUsd,
    })
    if (!approved) {
      return {
        output: `The user declined to spend $${priceUsd.toFixed(6)} on ${name}. Do not retry it.`,
        spentUsd: 0,
        declined: true,
      }
    }

    const payload =
      typeof args.payload === 'object' && args.payload !== null ? args.payload : {}
    const body = await postJson<unknown>(
      `/v1/marketplace/api/${id}`,
      payload,
      { baseUrl: ctx.baseUrl, cred: ctx.cred, signal: ctx.signal },
    )
    return { output: JSON.stringify(body).slice(0, 4000), spentUsd: priceUsd }
  },
}

export const tools: Record<string, Tool> = {
  search_apis: searchApis,
  list_models: listModels,
  call_api: callApi,
}

/**
 * What the model must be told it CANNOT do, so it stops trying.
 *
 * Measured failure this addresses: asked to speak a phrase, the model searched the catalogue,
 * found paid TTS APIs, could not call them, and then answered with a suggestion to use the
 * browser's Web Speech API — after four paid chat steps. It had no way to know that the page
 * itself has a Speech button that does exactly this for $0.002.
 *
 * So the instruction is not "you cannot make audio". It is "the page can, and you should say
 * so instead of spending turns finding out you can't".
 */
export const MODALITY_HINT = [
  'Media generation is NOT available to you as a tool. The page has its own buttons for it:',
  'Image, Video, Music and Speech, below the message box. Each one quotes a price and takes',
  'one wallet signature.',
  'So if the user asks for a picture, a video, music, or for something to be spoken aloud:',
  'tell them to press that button, in one short sentence. Do not search the catalogue for it,',
  'do not call an API for it, and do not offer code that does it in their browser instead.',
].join(' ')

/**
 * The schemas to advertise. Every tool, to every session.
 *
 * This used to hide `call_api` from an anonymous session, on the reasoning that advertising a tool
 * whose every invocation must be refused invites the model to plan around it. That reasoning was
 * wrong, and the cost was measured: asked "北京时间是几点", a free session ran five `search_apis`
 * calls, one `list_models`, and answered "I don't have access to a real-time clock API" — while the
 * catalogue holds one at id 447 for $0.006. Hiding the tool did not stop the model planning around
 * it; it stopped the model learning that the capability exists, so it invented a reason instead and
 * made the product look less capable than it is.
 *
 * VERIFIED against Franklin, which is the reference here — requests sent to its gateway with no
 * wallet, no key and no headers at all:
 *
 *   free model      → 200, answers normally
 *   paid model      → 402 {"price":{"amount":"0.002000","currency":"USD"}}
 *   /v1/exa/search  → 402, with the endpoint's full description in the body
 *   /v1/search      → 402 {"amount":"0.2625","perSourceCost":0.025,"maxResults":10}
 *
 * So a paid API is reachable without a wallet; what it reaches is a priced 402, not an invisible
 * door. Franklin's own 53 tools are all visible to a walletless session — its `ActivateTool` split
 * gates on call frequency and cost (a $0.40 GPU sandbox is hidden; paid market-data tools are in the
 * always-on core), never on whether the user can pay. Its source names our exact failure:
 *
 *   "earlier releases kept only file/shell/search in core, which made mid-tier models answer
 *    stock / market questions from 2022 training data instead of calling TradingMarket. That's
 *    anti-positioning for an agent whose whole brand is 'spends USDC for real market data.'"
 *
 * The `opts` parameter is kept so callers do not all have to change, and because a future
 * frequency-based split would use it. Both are unused today, hence the underscore.
 */
export function toolSchemas(_opts: { anonymous: boolean }): ToolSchema[] {
  return Object.values(tools).map((t) => t.schema)
}

export function toolNames(_opts: { anonymous: boolean }): string[] {
  return Object.keys(tools)
}

export { DEFAULT_BASE_URL }
