/**
 * The gateway calls this app makes, and the rules that are easy to get wrong.
 *
 * Everything here talks to the JarvisClaw gateway directly from the browser, with no proxy
 * of ours in between and no server-side secret to protect.
 *
 * The CORS picture is narrower than it looks, and this comment used to state it wrongly.
 * `access-control-allow-origin: *` is returned only for ANONYMOUS requests to the public
 * surfaces. The moment a request carries a credential — Authorization, X-PAYMENT — the
 * gateway falls through to an origin whitelist, and this page's origin has to be on it.
 * Getting that wrong is not a subtle failure: every credentialed request was blocked by the
 * browser before it was sent, so both the API key box and wallet payments were dead.
 * See api-server#528 and CORS_ALLOWED_ORIGINS on the gateway host.
 */

/**
 * The gateway.
 *
 * Not user-editable. Which host a page that signs payments talks to is infrastructure, not
 * a preference — an input for it invites pointing this app at someone else's host, and the
 * deployed CSP would refuse any other origin regardless. `VITE_GATEWAY_URL` overrides it at
 * build time for local development against a dev gateway.
 */
export const DEFAULT_BASE_URL =
  (import.meta.env?.VITE_GATEWAY_URL as string | undefined) ?? 'https://api.jarvisclaw.ai'

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
  /**
   * A gateway API key.
   *
   * Retained for local development only — the UI no longer collects one. It cannot work
   * from a deployed browser page anyway: `Authorization` was absent from the gateway's
   * Access-Control-Allow-Headers, so a keyed request was blocked by CORS before it left the
   * page. Paid calls in the browser go through a wallet signature instead (lib/wallet.ts).
   */
  apiKey?: string
  /**
   * A base64 x402 payment payload, sent as X-PAYMENT.
   *
   * One signature authorises one call: it names the amount, recipient and expiry, and the
   * gateway settles exactly that. It is therefore never reused across requests — a reused
   * signature is a replay, and the gateway has already seen one payment serve two calls.
   */
  payment?: string
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

/**
 * True when a failure means "this model cannot stream", as opposed to anything else.
 *
 * Reported from the live gateway as a plain sentence — `Streaming not supported for this model.
 * Set stream: false` — with no distinct error code, so it has to be matched on the message the
 * same way `isModelUnavailable` is.
 *
 * ## Why this is retried rather than surfaced
 *
 * A user asked "北京时间" and was shown that sentence, in English, as the assistant's reply. Three
 * things are wrong with that and only the last is cosmetic: the request had already been PAID for,
 * the instruction ("set stream: false") is addressed to whoever wrote the client rather than to the
 * person reading it, and it is untranslated in a UI that otherwise reads Chinese.
 *
 * The 402 quote cannot prevent it — measured, `stream: true` and `stream: false` are quoted at the
 * same $0.001 — so this is another "the charge is approved and then the call fails" case, and the
 * only place left to handle it is after the failure.
 *
 * Deliberately NOT a list of models. I know of no reliable enumeration: the obvious candidate
 * (`auto/search`, whose handler writes plain JSON and cannot emit SSE) answers 200 to `stream:
 * true` on the live gateway, resolved to gemini-3.5-flash rather than reaching that handler at all.
 * A hardcoded list built from one sample would be wrong for the models it omits and would rot as
 * routing changes. Reacting to what the gateway actually says covers every model, including ones
 * added later.
 *
 * ## Deliberately NARROW, and one measurement is why
 *
 * `openai/text-embedding-3-small` on this endpoint answers 400 "The requested operation is
 * unsupported." — no mention of streaming, and it is tempting to widen the pattern to catch it.
 * That would be wrong: measured, it returns the SAME 400 with `stream: false`. The problem is that
 * an embedding model is not a chat model at all, so a retry would spend a second charge, fail
 * again, and replace the real reason with a misleading one.
 *
 * The rule this settles: only retry a message that says the STREAM is the problem. A message that
 * merely says something is unsupported has not told us that, and the gateway's own wording is the
 * only evidence available before paying — the 402 quote is identical in every one of these cases.
 */
export function isStreamingUnsupported(err: unknown): boolean {
  if (!(err instanceof GatewayError)) return false
  const m = err.message.toLowerCase()
  return (
    (m.includes('streaming') || m.includes('stream')) &&
    (m.includes('not supported') || m.includes('not available') || m.includes('unsupported'))
  )
}

interface RawFreeModel {
  model?: string
  /**
   * Present on `cheap` rows, ABSENT on `free` rows. Not the free signal — see below.
   */
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
 *
 * Membership in the `free` array IS the free signal. This used to require `free === true`
 * on each row, and the endpoint does not send that field on free rows — it sends
 * `{model, pricing_type, note: "completely free"}`, while `free: false` appears on the
 * SEPARATE `cheap` array. So the filter matched nothing and this function returned an empty
 * list on every call, silently: the fallback chain had no models in it and a failed request
 * had nothing to retry with. Verified live against `/api/discovery/free-models` — 10 rows in
 * `free`, none carrying the field.
 *
 * A defensive `free !== false` is kept so a row the endpoint ever marks unfree is excluded
 * even if it appears here, but absence is treated as free because that is what the payload
 * means.
 */
export async function listFreeModels(opts: RequestOptions = {}): Promise<string[]> {
  const data = await getJson<{ free?: RawFreeModel[] }>('/api/discovery/free-models', opts)
  return (data.free ?? [])
    .filter((m) => m.free !== false && typeof m.model === 'string' && m.model !== '')
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
  if (cred.payment && cred.payment.trim() !== '') {
    // X-PAYMENT rather than PAYMENT-SIGNATURE: both are accepted, and this is the spelling
    // our own discovery document advertises.
    headers['X-PAYMENT'] = cred.payment.trim()
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

/**
 * The x402 challenge carried by a 402, or null if this is not one.
 *
 * Needed because a 402 body is a payment offer, not an error message. Without this the
 * whole challenge JSON was rendered into the transcript verbatim — a wall of `accepts`,
 * `payTo` and base64 in place of a price. The user saw it as a broken app, and there was
 * no way to act on it.
 */
export function paymentChallenge(err: unknown): { accepts?: Array<Record<string, unknown>> } | null {
  if (!(err instanceof GatewayError) || err.status !== 402) return null
  const body = err.body
  if (typeof body !== 'object' || body === null) return null
  const accepts = (body as { accepts?: unknown }).accepts
  return Array.isArray(accepts) ? (body as { accepts: Array<Record<string, unknown>> }) : null
}

/** True when a failure is the free tier's per-IP rate limit. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof GatewayError && err.status === 429
}

export interface RequestOptions {
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
  if (!res.ok) {
    const err = await readError(res)
    /**
     * A model that cannot stream is retried WITHOUT streaming rather than reported.
     *
     * Measured on the live gateway: the refusal arrives as "Streaming not supported for this
     * model. Set stream: false", and a user who asked "北京时间" was shown exactly that — an
     * English instruction aimed at a developer, as the assistant's answer, for a call they had
     * already paid for. The 402 quote is identical either way ($0.001 for both), so nothing
     * upstream of the failure can prevent it.
     *
     * The retry is not a second charge in the paid sense that matters here: the first request
     * never produced an answer, and the alternative is charging for nothing at all. Emitted
     * through the same `onDelta` so every caller — agent loop included — needs no change.
     */
    if (isStreamingUnsupported(err)) {
      return completeChat(req, onDelta, opts)
    }
    throw err
  }
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
      if (opts.signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        /**
         * Checked per FRAME, not only per chunk, and that is what makes an abort actually stop
         * the work.
         *
         * A caller can abort from inside `onDelta` — the runaway-reasoning guard in the agent
         * loop does exactly that. Aborting the fetch makes the next `reader.read()` reject, so
         * a stream that arrives in many small chunks stops promptly. But everything already
         * decoded is dispatched by this inner loop with no exit, so a single large chunk is
         * processed to its end no matter what the caller decided halfway through.
         *
         * That is not a hypothetical: the runaway response measured on the live console was
         * 229,295 characters, and how much of it lands in one chunk is up to the network. This
         * check makes the guard depend on the abort rather than on chunk sizes.
         */
        if (opts.signal?.aborted) break
        handleFrame(frame)
      }
    }
    // A stream that ends without a trailing blank line leaves its last frame here.
    if (!opts.signal?.aborted && buffer.trim() !== '') handleFrame(buffer)
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

/**
 * One non-streaming chat call, reported through the streaming interface.
 *
 * The fallback for a model that refuses `stream: true`. It returns the same `ChatResult` and calls
 * the same `onDelta`, so `streamChat` can switch to it mid-flight and no caller — the agent loop
 * included — has to know it happened.
 *
 * `onDelta` fires ONCE with the whole answer, which is the honest shape: there were no increments
 * to report. It is called rather than skipped because the UI renders from those deltas, and a
 * caller that only collected the return value would show an empty bubble until the promise settled.
 *
 * Tool calls are read here too. Without that, a non-streaming model would appear to have answered
 * in prose whenever it actually asked for a tool, and the agent loop would end its turn — the
 * failure being silent rather than visible, which is worse than the error this replaces.
 */
async function completeChat(
  req: { messages: ChatMessage[]; model?: string; tools?: ToolSchema[]; maxTokens?: number },
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
      stream: false,
      max_tokens: req.maxTokens ?? 1024,
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    }),
  })
  if (!res.ok) throw await readError(res)

  const body = (await res.json()) as {
    model?: string
    choices?: {
      message?: {
        content?: string
        reasoning?: string
        reasoning_content?: string
        tool_calls?: ToolCall[]
      }
      finish_reason?: string
    }[]
  }
  const choice = body.choices?.[0]
  const msg = choice?.message ?? {}
  const content = typeof msg.content === 'string' ? msg.content : ''
  // Both spellings: `reasoning` and `reasoning_content` are each used by models we serve, and
  // reading only one puts a model's thinking into the void.
  const reasoning =
    (typeof msg.reasoning === 'string' && msg.reasoning) ||
    (typeof msg.reasoning_content === 'string' && msg.reasoning_content) ||
    ''

  if (reasoning !== '') onDelta({ reasoning })
  if (content !== '') onDelta({ content })

  return {
    content,
    reasoning,
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    model: typeof body.model === 'string' && body.model !== '' ? body.model : req.model ?? FREE_MODEL,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
  }
}
