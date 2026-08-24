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

export type GenerationKind = 'image' | 'video' | 'music' | 'speech'

export interface GenerationSpec {
  kind: GenerationKind
  path: string
  /** Default model, chosen because it is verified servable — see MODEL NOTES below. */
  defaultModel: string
  label: string
  /** What the price is charged per, for the consent dialog's wording. */
  unit: string
  /**
   * The JSON field this endpoint reads the prompt from.
   *
   * `/v1/audio/speech` takes `input`, not `prompt`. Sending `prompt` there produces a 400
   * that says nothing about the missing field, so this is not a stylistic difference: it is
   * the whole reason a speech call succeeds or fails.
   */
  promptField: 'prompt' | 'input'
}

/**
 * MODEL NOTES — every default here was confirmed to return a 402 quote against the live
 * gateway. That check is not optional: the catalogue lists names the gateway cannot serve.
 * `auto/music` and `ali/qwen-image` are both advertised in /api/discovery/models and both
 * answer 400 "not accepted as-is", so picking a plausible-looking name from the catalogue
 * is how a button ends up broken for everyone.
 */
/**
 * Models the gateway advertises but cannot serve on their own endpoint.
 *
 * These are worse than merely broken, which is why they are named here rather than left to
 * fail: `auto/tts` answers 400 on /v1/audio/speech while quoting 402 on /v1/chat/completions.
 * So the failure mode is not an error — it is a paid chat call that talks ABOUT speech instead
 * of producing it. Measured on all four virtuals (2026-08-24): every one 400s on the endpoint
 * its name implies.
 */
export const UNSERVABLE_VIRTUALS = ['auto/image', 'auto/video', 'auto/music', 'auto/tts']

export const GENERATIONS: Record<GenerationKind, GenerationSpec> = {
  image: {
    kind: 'image',
    path: '/v1/images/generations',
    defaultModel: 'openai/gpt-image-2',
    label: 'Image',
    unit: 'image',
    promptField: 'prompt',
  },
  video: {
    kind: 'video',
    path: '/v1/videos/generations',
    // Not seedance-2.0 ($1.14): the mini at $0.40 is the kinder default for someone
    // pressing a button to see what happens. The picker can still reach the others.
    defaultModel: 'bytedance/seedance-2.0-mini',
    label: 'Video',
    unit: 'video',
    promptField: 'prompt',
  },
  music: {
    kind: 'music',
    path: '/v1/audio/generations',
    defaultModel: 'minimax/music-2.5+',
    label: 'Music',
    unit: 'track',
    promptField: 'prompt',
  },
  /**
   * Text-to-speech. Added because its absence cost a real user real money:
   *
   * asked to speak a phrase, the agent had no speech endpoint to reach, so `auto/tts` was
   * sent to /v1/chat/completions — where it is a PAID CHAT MODEL that quotes $0.001 and
   * answers in words. Five agent steps, five wallet signatures, $0.068 spent, and the reply
   * was a suggestion to use the browser's Web Speech API. The correct call is one signature
   * for $0.002 against this endpoint.
   *
   * `elevenlabs/turbo-v2.5` rather than `auto/tts`: measured, auto/tts answers 400 HERE
   * while quoting happily on chat. That asymmetry is exactly the trap above.
   */
  speech: {
    kind: 'speech',
    path: '/v1/audio/speech',
    defaultModel: 'elevenlabs/turbo-v2.5',
    label: 'Speech',
    unit: 'clip',
    promptField: 'input',
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
  const spec = GENERATIONS[kind]
  if (kind === 'video') {
    // duration is not optional in the video DTO's semantics: the price depends on it, so
    // omitting it would quote one thing and bill another.
    return { model, prompt, duration: 5 }
  }
  // Keyed off the spec rather than hardcoded, so adding an endpoint cannot silently reuse
  // the wrong field name. /v1/audio/speech reads `input` and 400s on `prompt`.
  return { model, [spec.promptField]: prompt }
}

/**
 * The generation mode a chosen model belongs to, or null when it is a chat model.
 *
 * This is the wiring that was missing, and its absence is what turned a request to speak
 * a phrase into five paid chat calls. The picker happily offers audio and image models, but
 * nothing connected "the user chose a voice model" to "call the voice endpoint" — so a
 * non-text model was sent to /v1/chat/completions, which quotes and bills it as chat.
 *
 * Modality alone is not enough to pick the endpoint: `audio` covers both music generation
 * (/v1/audio/generations, per track) and speech (/v1/audio/speech, per clip), and they are
 * different endpoints with different bodies and different prices. Music models are named
 * for it, so they are matched by name and everything else audio-shaped is speech.
 */
export function modeForModel(model: string, modality: string): GenerationKind | null {
  switch (modality) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return /music|suno/i.test(model) ? 'music' : 'speech'
    default:
      return null
  }
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
    // Speech upstreams have used `audio` for the same inlined bytes that image upstreams
    // call `b64_json`. Read rather than assumed: a paid clip that renders blank because the
    // field had a different name is the outcome this whole function exists to prevent.
    if (typeof first.audio === 'string') return { kind, b64: first.audio }
  }
  for (const key of ['url', 'video_url', 'audio_url', 'result_url', 'image_url']) {
    const v = body[key]
    if (typeof v === 'string') return { kind, url: v }
  }
  for (const key of ['b64_json', 'audio', 'audio_base64', 'audioContent']) {
    const v = body[key]
    if (typeof v === 'string' && v !== '') return { kind, b64: v }
  }
  if (typeof data === 'object' && data !== null) {
    const nested = data as Record<string, unknown>
    for (const key of ['video_url', 'audio_url', 'url']) {
      const v = nested[key]
      if (typeof v === 'string') return { kind, url: v }
    }
    for (const key of ['b64_json', 'audio', 'audio_base64']) {
      const v = nested[key]
      if (typeof v === 'string' && v !== '') return { kind, b64: v }
    }
  }
  return { kind, raw: JSON.stringify(body).slice(0, 400) }
}

/**
 * The mime type for an inlined base64 payload, by mode.
 *
 * Previously every b64 result was rendered as `data:image/png`, which is right for an image
 * and silently broken for a clip: an <audio> element handed an image mime type shows a dead
 * player, so a paid speech call would look like it produced nothing.
 */
export function mediaMimeType(kind: GenerationKind): string {
  switch (kind) {
    case 'image':
      return 'image/png'
    case 'video':
      return 'video/mp4'
    default:
      return 'audio/mpeg'
  }
}
