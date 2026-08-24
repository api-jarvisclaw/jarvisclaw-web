/**
 * The gateway calls this app makes, and the rules that are easy to get wrong.
 *
 * Everything here talks to the JarvisClaw gateway directly from the browser. That
 * works because the gateway answers CORS with `access-control-allow-origin: *` and
 * exposes the x402 headers, so no proxy of our own is needed and no server-side
 * secret exists to protect.
 */

/** Default gateway. Overridable so a self-hosted instance can be pointed at. */
export const DEFAULT_BASE_URL = 'https://api.jarvisclaw.ai'

/**
 * The virtual model that routes to whatever is free right now.
 *
 * Not a real model id: the gateway resolves it per request from the models whose
 * ratio AND price are both zero, intersected with the channels actually enabled. A
 * hardcoded free-model list here would rot the moment an upstream retires one, which
 * is what happened to the gateway's own hardcoded table.
 */
export const FREE_MODEL = 'auto/free'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Present on an assistant turn that wants tools run. */
  tool_calls?: ToolCall[]
  /** Required on a tool result, and must match the call it answers. */
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface Credential {
  /** A gateway API key. Absent means anonymous — see authHeaders. */
  apiKey?: string
}

/**
 * True when a failure means "that model is not servable", as opposed to a transport or
 * auth problem.
 *
 * This is the condition that makes a fallback worth attempting, and it needs matching
 * on the MESSAGE because the gateway reports it as a generic wrapped upstream status
 * (`bad_response_status_code`) rather than a distinct code. Observed live: `auto/free`
 * resolved to a model whose upstream answered "Unknown model: …", while that same model
 * requested by name worked — so the name a virtual model resolves to can be unservable
 * even when the model itself is fine.
 */
export function isModelUnavailable(err: unknown): boolean {
  if (!(err instanceof GatewayError)) return false
  const m = err.message.toLowerCase()
  return (
    m.includes('unknown model') ||
    m.includes('model not found') ||
    m.includes('no available channel') ||
    m.includes('capacity exhausted') ||
    m.includes('无可用渠道')
  )
}

interface RawFreeModel {
  model?: string
  free?: boolean
}

/**
 * The models the GATEWAY currently reports as costing nothing, cheapest-first order as
 * given.
 *
 * Read live rather than hardcoded. A list of free model names in this file would rot
 * exactly the way the gateway's own hardcoded free tier did — upstreams retire models
 * and reprice them, and a stale name here would quote "free" for a model that now bills.
 *
 * `auto/free` and the other virtual names are dropped: they are priced at zero and so
 * appear in this list, but falling back from `auto/free` to `auto/free` retries the
 * failure that started it.
 */
export async function listFreeModels(opts: RequestOptions = {}): Promise<string[]> {
  const data = await getJson<{ free?: RawFreeModel[] }>('/api/discovery/free-models', opts)
  return (data.free ?? [])
    .filter((m) => m.free === true && typeof m.model === 'string' && m.model !== '')
    .map((m) => m.model as string)
    .filter((name) => !name.startsWith('auto'))
}

/**
 * Headers for a gateway call.
 *
 * The anonymous free tier recognises a request by the ABSENCE of any auth header. A
 * placeholder value — `Bearer anonymous`, an empty string, the literal "none" — is
 * treated as a real credential, fails to resolve, and answers 401. So an
 * unauthenticated call must send no Authorization header at all rather than an empty
 * one, and this is the single place that decides it.
 */
export function authHeaders(cred: Credential): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cred.apiKey && cred.apiKey.trim() !== '') {
    headers.Authorization = `Bearer ${cred.apiKey.trim()}`
  }
  return headers
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

/** True when a failure is the gateway declining the credential we sent (or lack of one). */
export function isAuthError(err: unknown): boolean {
  return err instanceof GatewayError && (err.status === 401 || err.status === 403)
}

/** True when a failure is the gateway asking for payment before it will answer. */
export function isPaymentRequired(err: unknown): boolean {
  return err instanceof GatewayError && err.status === 402
}

/** True when a failure is the free tier's per-IP rate limit. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof GatewayError && err.status === 429
}

interface RequestOptions {
  baseUrl?: string
  cred?: Credential
  signal?: AbortSignal
}

async function readError(res: Response): Promise<GatewayError> {
  const text = await res.text().catch(() => '')
  let body: unknown = text
  let message = text
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string }
    body = parsed
    if (typeof parsed.error === 'string') message = parsed.error
    else if (parsed.error?.message) message = parsed.error.message
  } catch {
    // Not JSON — the raw text is the best message available.
  }
  return new GatewayError(message || `HTTP ${res.status}`, res.status, body)
}

/** GET a JSON endpoint. */
export async function getJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch((opts.baseUrl ?? DEFAULT_BASE_URL) + path, {
    method: 'GET',
    headers: authHeaders(opts.cred ?? {}),
    signal: opts.signal,
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

/** POST a JSON body to a JSON endpoint. */
export async function postJson<T>(
  path: string,
  payload: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await fetch((opts.baseUrl ?? DEFAULT_BASE_URL) + path, {
    method: 'POST',
    headers: authHeaders(opts.cred ?? {}),
    body: JSON.stringify(payload),
    signal: opts.signal,
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

export interface ChatDelta {
  /** Assistant text meant for the user. */
  content?: string
  /**
   * The model's own thinking, which several free models emit as a separate field.
   * Kept apart from `content` so it can be collapsed rather than read as the answer —
   * on some free models it is most of the output.
   */
  reasoning?: string
}

export interface ChatResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  /** Which concrete model answered. `auto/free` resolves per request, so this varies. */
  model: string
  finishReason: string
}

interface RawChoiceDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
}

/**
 * Stream one chat completion, calling `onDelta` as text arrives.
 *
 * Tool calls are accumulated rather than streamed out: a partially-received
 * `arguments` string is not valid JSON, so there is nothing a caller could do with
 * one except wait. They are returned whole when the stream ends.
 *
 * Chunks are assembled by INDEX, not by arrival order. The OpenAI streaming shape
 * sends a tool call's name in one chunk and its arguments across several more, all
 * tagged with the same index; appending in arrival order would interleave two
 * parallel calls into one corrupt pair.
 */
export async function streamChat(
  req: {
    messages: ChatMessage[]
    model?: string
    tools?: ToolSchema[]
    maxTokens?: number
  },
  onDelta: (delta: ChatDelta) => void,
  opts: RequestOptions = {},
): Promise<ChatResult> {
  const res = await fetch((opts.baseUrl ?? DEFAULT_BASE_URL) + '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(opts.cred ?? {}),
    signal: opts.signal,
    body: JSON.stringify({
      model: req.model ?? FREE_MODEL,
      messages: req.messages,
      stream: true,
      max_tokens: req.maxTokens ?? 1024,
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    }),
  })
  if (!res.ok) throw await readError(res)
  if (!res.body) throw new GatewayError('the gateway returned no response body', res.status)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()

  let content = ''
  let reasoning = ''
  let model = req.model ?? FREE_MODEL
  let finishReason = ''
  const partials = new Map<number, { id: string; name: string; args: string }>()

  // Frames are split on a blank line, and a chunk boundary can fall anywhere —
  // including inside a JSON payload. Whatever follows the last complete frame stays
  // in the buffer until the rest of it arrives.
  let buffer = ''

  const handleFrame = (frame: string) => {
    const dataLines = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
    if (dataLines.length === 0) return
    const payload = dataLines.join('')
    if (payload === '' || payload === '[DONE]') return

    let parsed: {
      model?: string
      choices?: Array<{ delta?: RawChoiceDelta; finish_reason?: string | null }>
    }
    try {
      parsed = JSON.parse(payload)
    } catch {
      // A frame we cannot parse is skipped rather than thrown: one malformed frame
      // must not discard an answer that is otherwise arriving fine.
      return
    }

    if (parsed.model) model = parsed.model
    const choice = parsed.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason

    const delta = choice.delta
    if (!delta) return

    if (delta.content) {
      content += delta.content
      onDelta({ content: delta.content })
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content
      onDelta({ reasoning: delta.reasoning_content })
    }
    for (const [i, call] of (delta.tool_calls ?? []).entries()) {
      // `index` is what ties a call's fragments together. It can legitimately be 0,
      // so `?? i` rather than `|| i` — the falsy form would remap index 0 onto the
      // array position and merge two calls.
      const idx = call.index ?? i
      const existing = partials.get(idx) ?? { id: '', name: '', args: '' }
      partials.set(idx, {
        id: call.id ?? existing.id,
        name: call.function?.name ?? existing.name,
        args: existing.args + (call.function?.arguments ?? ''),
      })
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) handleFrame(frame)
    }
    // A stream that ends without a trailing blank line leaves its last frame here.
    if (buffer.trim() !== '') handleFrame(buffer)
  } finally {
    reader.releaseLock()
  }

  const toolCalls: ToolCall[] = [...partials.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, p]) => ({
      // A synthesised id is a fallback, not the norm: the tool result must carry the
      // id of the call it answers, and a missing one would break that pairing.
      id: p.id || `call-${idx}`,
      type: 'function' as const,
      function: { name: p.name, arguments: p.args },
    }))
    .filter((call) => call.function.name !== '')

  return { content, reasoning, toolCalls, model, finishReason }
}
