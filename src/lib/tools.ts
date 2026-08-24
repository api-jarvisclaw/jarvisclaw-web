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
}

export interface ToolResult {
  /** What is fed back to the model. */
  output: string
  /** What was actually spent, in USD. Zero for a free tool. */
  spentUsd: number
  /** Set when the user declined, so the UI can say so rather than showing an error. */
  declined?: boolean
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
        'Search the catalogue of 4000+ callable APIs by natural-language query. ' +
        'Free — always search before assuming an API does or does not exist.',
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
      description: 'List the language models this gateway serves, with their prices. Free.',
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
      description:
        'Call one of the catalogue APIs by its id. Costs real money per call — ' +
        'search first, and prefer the cheapest API that answers the question.',
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
 * The schemas to advertise for this session.
 *
 * An anonymous session is offered only the free tools. Advertising call_api to a
 * caller who has no wallet invites the model to plan around a tool whose every
 * invocation must then be refused — the model reads that as its own failure and
 * retries, which spends free-tier turns going nowhere.
 */
export function toolSchemas(opts: { anonymous: boolean }): ToolSchema[] {
  return Object.values(tools)
    .filter((t) => !opts.anonymous || t.tier === 'free')
    .map((t) => t.schema)
}

export function toolNames(opts: { anonymous: boolean }): string[] {
  return Object.entries(tools)
    .filter(([, t]) => !opts.anonymous || t.tier === 'free')
    .map(([name]) => name)
}

export { DEFAULT_BASE_URL }
