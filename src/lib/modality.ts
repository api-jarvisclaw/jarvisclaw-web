import { authHeaders, DEFAULT_BASE_URL, type Credential, type RequestOptions } from './gateway'
import type { Challenge } from './wallet'

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

function buildBody(kind: GenerationKind, prompt: string, model: string): Record<string, unknown> {
  if (kind === 'video') {
    // duration is not optional in the video DTO's semantics: the price depends on it, so
    // omitting it would quote one thing and bill another.
    return { model, prompt, duration: 5 }
  }
  return { model, prompt }
}

/**
 * Fetches the 402 challenge for a generation, so a wallet can sign exactly this call.
 *
 * Returns the whole challenge rather than just the price: the signature has to be made over
 * the gateway's own `accepts` entry — its payTo, asset and network — and re-deriving those
 * from a price would be inventing them.
 */
export async function challengeGeneration(
  kind: GenerationKind,
  prompt: string,
  opts: RequestOptions & { model?: string } = {},
): Promise<{ challenge: Challenge; usd: number; url: string; body: Record<string, unknown> }> {
  const spec = GENERATIONS[kind]
  const url = `${opts.baseUrl ?? DEFAULT_BASE_URL}${spec.path}`
  const body = buildBody(kind, prompt, opts.model ?? spec.defaultModel)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (res.status === 402) {
    const challenge = (await res.json()) as Challenge
    const amount = challenge.accepts?.[0]?.amount ?? challenge.accepts?.[0]?.maxAmountRequired
    const usd = typeof amount === 'string' ? atomicToUsd(amount) : NaN
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new Error('the gateway quoted no usable price for this call')
    }
    return { challenge, usd, url, body }
  }

  if (res.status === 400) {
    throw new Error(
      `${opts.model ?? spec.defaultModel} is listed but not currently servable — pick another model`,
    )
  }
  throw new Error(`the gateway answered ${res.status} when asked to price this ${spec.unit}`)
}

/**
 * Runs the generation, paying with a signature the caller already obtained.
 *
 * The signature is passed in rather than produced here: signing is the wallet's job and must
 * happen in response to the user's own click, and keeping the two apart is what lets the
 * price be shown and approved between them.
 */
export async function generate(
  kind: GenerationKind,
  prompt: string,
  opts: RequestOptions & { cred: Credential; model?: string; url?: string; body?: Record<string, unknown> },
): Promise<GenerationResult> {
  const spec = GENERATIONS[kind]
  // Re-uses the exact URL and body the challenge was issued for when given them. A payment
  // signed for one body and spent on another is a signature the facilitator may settle
  // while the gateway serves something else.
  const url = opts.url ?? `${opts.baseUrl ?? DEFAULT_BASE_URL}${spec.path}`
  const body = opts.body ?? buildBody(kind, prompt, opts.model ?? spec.defaultModel)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(opts.cred) },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (res.status === 402) {
    throw new Error(
      'the gateway did not accept the payment — connect a wallet with USDC on Base and try again',
    )
  }
  if (!res.ok) {
    throw new Error(`${spec.label} generation failed (${res.status})`)
  }

  const body_ = (await res.json()) as Record<string, unknown>
  return extractMedia(kind, body_)
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
