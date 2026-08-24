import { authHeaders, DEFAULT_BASE_URL, type Credential, type RequestOptions } from './gateway'

/**
 * Image, video and music generation.
 *
 * These are separate from chat because they are separate endpoints with separate payloads
 * and separate billing units — per-image and per-video, not per-token. Measured against
 * the live gateway:
 *
 *   /v1/images/generations   openai/gpt-image-2        $0.064
 *   /v1/videos/generations   bytedance/seedance-2.0    $1.136
 *   /v1/audio/generations    minimax/music-2.5+        $0.159
 *
 * All three quote anonymously via 402, which is what lets the price be shown before
 * anything is spent. A video at over a dollar is exactly why the quote has to come first.
 */

export type GenerationKind = 'image' | 'video' | 'music'

export interface GenerationSpec {
  kind: GenerationKind
  path: string
  /** Default model, chosen because it is verified servable — see MODEL NOTES below. */
  defaultModel: string
  label: string
  /** What the price is charged per, for the consent dialog's wording. */
  unit: string
}

/**
 * MODEL NOTES — every default here was confirmed to return a 402 quote against the live
 * gateway. That check is not optional: the catalogue lists names the gateway cannot serve.
 * `auto/music` and `ali/qwen-image` are both advertised in /api/discovery/models and both
 * answer 400 "not accepted as-is", so picking a plausible-looking name from the catalogue
 * is how a button ends up broken for everyone.
 */
export const GENERATIONS: Record<GenerationKind, GenerationSpec> = {
  image: {
    kind: 'image',
    path: '/v1/images/generations',
    defaultModel: 'openai/gpt-image-2',
    label: 'Image',
    unit: 'image',
  },
  video: {
    kind: 'video',
    path: '/v1/videos/generations',
    // Not seedance-2.0 ($1.14): the mini at $0.40 is the kinder default for someone
    // pressing a button to see what happens. The picker can still reach the others.
    defaultModel: 'bytedance/seedance-2.0-mini',
    label: 'Video',
    unit: 'video',
  },
  music: {
    kind: 'music',
    path: '/v1/audio/generations',
    defaultModel: 'minimax/music-2.5+',
    label: 'Music',
    unit: 'track',
  },
}

export interface GenerationResult {
  kind: GenerationKind
  /** Direct media URL when the upstream returns one. */
  url?: string
  /** base64 payload, for upstreams that inline the bytes instead. */
  b64?: string
  /** Set when the response carried neither, so the UI can say so instead of showing nothing. */
  raw?: string
}

/** Atomic USDC (6dp) -> dollars. */
function atomicToUsd(amount: string): number {
  const n = Number(amount)
  return Number.isFinite(n) ? n / 1_000_000 : NaN
}

/**
 * Asks the gateway what this generation costs, without paying.
 *
 * An unpaid request answers 402 with the exact price for this exact call, which is far
 * better than a table: per-video pricing varies with duration and model, and a quoted
 * figure cannot drift from what settlement will charge.
 */
export async function quoteGeneration(
  kind: GenerationKind,
  prompt: string,
  opts: RequestOptions & { cred?: Credential; model?: string } = {},
): Promise<number> {
  const spec = GENERATIONS[kind]
  const res = await fetch(`${opts.baseUrl ?? DEFAULT_BASE_URL}${spec.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts.cred ?? {}) },
    body: JSON.stringify(buildBody(kind, prompt, opts.model ?? spec.defaultModel)),
    signal: opts.signal,
  })

  if (res.status === 402) {
    const body = (await res.json()) as { accepts?: Array<{ amount?: string }> }
    const amount = body.accepts?.[0]?.amount
    if (typeof amount !== 'string') throw new Error('the gateway quoted no price for this call')
    const usd = atomicToUsd(amount)
    if (!Number.isFinite(usd)) throw new Error('the gateway quoted an unreadable price')
    return usd
  }

  // A 400 here is usually a model the gateway advertises but cannot serve. Say that,
  // rather than repeating the gateway's cause-free wording — the actionable fix is
  // choosing another model, and nothing in the response says so.
  if (res.status === 400) {
    throw new Error(
      `${opts.model ?? spec.defaultModel} is listed but not currently servable — pick another model`,
    )
  }
  throw new Error(`the gateway answered ${res.status} when asked to price this ${spec.unit}`)
}

function buildBody(kind: GenerationKind, prompt: string, model: string): Record<string, unknown> {
  if (kind === 'video') {
    // duration is not optional in the video DTO's semantics: the price depends on it, so
    // omitting it would quote one thing and bill another.
    return { model, prompt, duration: 5 }
  }
  return { model, prompt }
}

/**
 * Runs the generation for real. Requires a credential: an anonymous caller can be quoted
 * but cannot pay, and the free tier covers text models only.
 */
export async function generate(
  kind: GenerationKind,
  prompt: string,
  opts: RequestOptions & { cred: Credential; model?: string },
): Promise<GenerationResult> {
  const spec = GENERATIONS[kind]
  const res = await fetch(`${opts.baseUrl ?? DEFAULT_BASE_URL}${spec.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts.cred) },
    body: JSON.stringify(buildBody(kind, prompt, opts.model ?? spec.defaultModel)),
    signal: opts.signal,
  })

  if (res.status === 402) {
    throw new Error('this needs a funded key — the free tier covers text models only')
  }
  if (!res.ok) {
    throw new Error(`${spec.label} generation failed (${res.status})`)
  }

  const body = (await res.json()) as Record<string, unknown>
  return extractMedia(kind, body)
}

/**
 * Pulls the media out of a response whose shape differs per upstream.
 *
 * Checked in order rather than assuming one: OpenAI-style image responses use
 * `data[0].url` or `data[0].b64_json`, video responses have carried a top-level `url` and
 * a nested `data.video_url`, and none of them is promised by the contract. When nothing
 * matches, the raw JSON is returned so the UI can show that instead of an empty box —
 * a silent blank is indistinguishable from a charge that produced nothing.
 */
export function extractMedia(kind: GenerationKind, body: Record<string, unknown>): GenerationResult {
  const data = body.data
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
    const first = data[0] as Record<string, unknown>
    if (typeof first.url === 'string') return { kind, url: first.url }
    if (typeof first.b64_json === 'string') return { kind, b64: first.b64_json }
    if (typeof first.video_url === 'string') return { kind, url: first.video_url }
    if (typeof first.audio_url === 'string') return { kind, url: first.audio_url }
  }
  for (const key of ['url', 'video_url', 'audio_url', 'result_url', 'image_url']) {
    const v = body[key]
    if (typeof v === 'string') return { kind, url: v }
  }
  if (typeof data === 'object' && data !== null) {
    const nested = data as Record<string, unknown>
    for (const key of ['video_url', 'audio_url', 'url']) {
      const v = nested[key]
      if (typeof v === 'string') return { kind, url: v }
    }
  }
  return { kind, raw: JSON.stringify(body).slice(0, 400) }
}
