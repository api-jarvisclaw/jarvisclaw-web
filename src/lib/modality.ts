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

/**
 * The choices the UI offers, per mode.
 *
 * Kept beside the DTO mapping above so a control cannot exist for a field the body never sends.
 * Sizes and qualities are the OpenAI-compatible set the ImageRequest DTO accepts; voices are the
 * OpenAI-compatible names, which is what the audio DTO's `voice` field expects.
 */
export const GENERATION_CHOICES = {
  image: {
    size: ['1024x1024', '1792x1024', '1024x1792'],
    /**
     * The upstream's own value list, and NOT DALL·E's `standard`/`hd`.
     *
     * `hd` was offered here and is rejected outright — the upstream answers 400 with
     * "Invalid value: 'hd'. Supported values are: 'low', 'medium', 'high', and 'auto'." So half
     * this control was not a decoration but a way to make a paid call fail after the user had
     * already approved the charge.
     *
     * Measured on UAT: low -> 206,502 bytes, medium -> 183,433, auto -> 185,433 (and the response
     * echoes `quality`, so the effect is confirmed rather than inferred). `auto` reports back as
     * `low`, which is the upstream's own choice and why it is offered as a distinct option rather
     * than presented as a quality level.
     */
    quality: ['auto', 'low', 'medium', 'high'],
    n: [1, 2, 4],
    /** Measured: the returned bytes really are a JPEG (ffd8) or a PNG (89504e47). */
    outputFormat: ['png', 'jpeg'],
    /** `transparent` needs png; a transparent jpeg is not a thing. */
    background: ['auto', 'opaque', 'transparent'],
    /** JPEG only. Measured monotonic: 20 -> 396 KB, 60 -> 521 KB, 100 -> 564 KB. */
    outputCompression: [40, 60, 80, 100],
  },
  video: {
    /**
     * Fallback only. The real limits are PER MODEL — see VIDEO_LIMITS.
     *
     * `[5, 10]` was here and it was a guess. I then replaced it with `[4, 5, 6, 8, 10, 12]`, inferred
     * from what the prompt library's authors write, which was a better guess and still a guess: the
     * documented ceiling for seedance-2.0 is 15, not 12, and Sora 2 accepts only 4/8/12 — a set no
     * single list can express.
     */
    duration: [4, 5, 8, 10, 12],
    resolution: ['default', '480p', '720p', '1080p'],
    aspectRatio: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  },
  // NOTE: image.quality above is the upstream's OWN value list, not DALL·E's.
  speech: {
    /**
     * The upstream offers 37 voices. Six were listed here — the original OpenAI set — so the other
     * 31 were unreachable from this UI.
     *
     * Not all 37 are listed, and that is a judgement rather than an oversight: the tail includes
     * dated snapshots (`megan-wetherall-2025-03-07`) that duplicate an undated name, and a menu of
     * 37 is a menu nobody reads. These are the distinct, undated ones. The full list, from the
     * upstream's own 400: alloy, echo, fable, onyx, nova, shimmer, coral, verse, ballad, ash, sage,
     * marin, cedar, amuch, aster, brook, clover, dan, elan, marilyn, meadow, jazz, rio, breeze,
     * cove, ember, fathom, glimmer, harp, juniper, maple, orbit, vale, megan-wetherall, jade-hardy,
     * + two dated variants.
     */
    voice: [
      'alloy',
      'echo',
      'fable',
      'onyx',
      'nova',
      'shimmer',
      'coral',
      'verse',
      'ballad',
      'ash',
      'sage',
      'marin',
      'cedar',
      'juniper',
      'maple',
      'ember',
    ],
    speed: [0.75, 1, 1.25, 1.5],
    /** Measured from the upstream's own 400. mp3 is the default and what the player expects. */
    responseFormat: ['mp3', 'wav', 'opus', 'aac', 'flac'],
  },
} as const

/** Defaults, chosen to match what the endpoints do when the field is omitted. */
/**
 * What each video model actually accepts, from BlockRun's own API reference.
 *
 * ## Why this is per-model and not one list
 *
 * Because the limits genuinely differ, and offering the union means offering values that 400 —
 * after the user has approved the charge, which is the defect this whole pass exists to remove:
 *
 *   - Sora 2 takes ONLY 4, 8 or 12 seconds, and ignores resolution entirely
 *   - Grok takes 1–15 and 480p/720p (1080p on 1.5 only), and has no `adaptive` aspect ratio
 *   - Seedance's ceiling is 12s (1.5-pro), 15s (2.0 / 2.0-fast / 2.0-mini) or 30s (2.5)
 *   - Seedance 2.0 alone reaches 4K; 2.0-fast and 2.5 stop at 720p
 *
 * ## Documented, and partly measured
 *
 * The ranges are the vendor's. Two points are confirmed against real paid calls, which is worth
 * separating because the docs and the running service have disagreed before:
 *
 *   - `duration_seconds: 10` -> a 10.05s file (mp4 mvhd atom)
 *   - `resolution: 480p` -> settles at exactly half the default's price (284,370 vs 568,240)
 *
 * The rest of the values here are read from the reference and NOT individually exercised — the UAT
 * upstream balance ran out partway through. A 400 on one of them would be a docs/service
 * disagreement rather than a bug in this table, and `videoLimitsFor` is where to fix it.
 */
export const VIDEO_LIMITS: Record<
  string,
  { durations: readonly number[]; resolutions: readonly string[]; aspectRatios: readonly string[] }
> = {
  // Sora ignores resolution and the reference-media params entirely, and its duration set is
  // three exact values rather than a range.
  'azure/sora-2': {
    durations: [4, 8, 12],
    resolutions: ['default'],
    aspectRatios: ['default'],
  },
  'bytedance/seedance-1.5-pro': {
    durations: [4, 5, 6, 8, 10, 12],
    resolutions: ['default', '480p', '720p', '1080p'],
    aspectRatios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  },
  'bytedance/seedance-2.0': {
    durations: [4, 5, 6, 8, 10, 12, 15],
    // 2.0 is the only tier that reaches 4K.
    resolutions: ['default', '480p', '720p', '1080p', '4K'],
    aspectRatios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  },
  'bytedance/seedance-2.0-fast': {
    durations: [4, 5, 6, 8, 10, 12, 15],
    resolutions: ['default', '480p', '720p'],
    aspectRatios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  },
  'bytedance/seedance-2.0-mini': {
    durations: [4, 5, 6, 8, 10, 12, 15],
    resolutions: ['default', '480p', '720p', '1080p'],
    aspectRatios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  },
  'bytedance/seedance-2.5': {
    durations: [4, 5, 6, 8, 10, 12, 15, 20, 30],
    resolutions: ['default', '480p', '720p'],
    aspectRatios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  },
  'xai/grok-imagine-video': {
    durations: [1, 2, 4, 6, 8, 10, 12, 15],
    // Grok renders and bills 480p when resolution is omitted, so `default` is not a distinct option.
    resolutions: ['480p', '720p'],
    // No `adaptive`, no 21:9.
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  },
  'xai/grok-imagine-video-1.5': {
    durations: [1, 2, 4, 6, 8, 10, 12, 15],
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  },
}

/**
 * Speech voices, PER MODEL FAMILY — and this one costs real money to get wrong.
 *
 * ## The measurement that made this non-negotiable
 *
 * `elevenlabs/flash-v2.5` with `voice: alloy` did not return a 400. It returned:
 *
 *     upstream 402 after payment — USDC already settled on-chain and cannot be reversed
 *
 * The payment settles, the upstream refuses the voice, and the money is gone. Every other wrong
 * parameter in this file costs a failed call; this one costs the charge as well. So the voice list
 * cannot be a union, and cannot be a guess.
 *
 * ## Two families, mutually exclusive
 *
 *   - ElevenLabs models take aliases (`sarah`, `george`) or a raw `voice_id`. Their roster comes from
 *     GET /api/v1/audio/voices on the upstream — 22 voices, of which only 8 have an alias; the rest
 *     are reachable by id only. Our gateway does not proxy that endpoint (404), so the list is
 *     transcribed here rather than fetched.
 *   - OpenAI models take their own 37 names (`alloy`, `coral`, …), measured from the upstream's 400.
 *
 * Cross-family names are not merely invalid, they are the expensive case above.
 *
 * ## bytedance/seed-audio-1.0 ignores voice entirely
 *
 * Documented: you steer delivery inside the prompt text. Offering a voice picker for it would be a
 * control that does nothing — the defect this whole pass exists to remove — so it gets an empty list
 * and the UI hides the row.
 */
export const SPEECH_VOICES: Record<string, readonly { id: string; label: string }[]> = {
  // ElevenLabs: the 8 aliased voices, then the id-only ones. Labels carry the upstream's own
  // one-line character description, which is the only way to choose without listening to all 22.
  elevenlabs: [
    { id: 'sarah', label: 'Sarah — mature, reassuring' },
    { id: 'george', label: 'George — warm storyteller' },
    { id: 'roger', label: 'Roger — laid-back, resonant' },
    { id: 'laura', label: 'Laura — quirky, enthusiast' },
    { id: 'charlie', label: 'Charlie — deep, energetic' },
    { id: 'callum', label: 'Callum — husky trickster' },
    { id: 'river', label: 'River — relaxed, neutral' },
    { id: 'harry', label: 'Harry — fierce' },
    { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian — deep, comforting' },
    { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel — steady broadcaster' },
    { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice — clear educator' },
    { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica — playful, warm' },
    { id: 'pFZP5JQG7iQjIQuC4Bku', label: 'Lily — velvety' },
    { id: 'cjVigY5qzO86Huf0OWal', label: 'Eric — smooth, trustworthy' },
  ],
  // OpenAI: measured from the upstream's own 400. The full 37 include dated snapshots that duplicate
  // an undated name; these are the distinct ones.
  openai: [
    { id: 'alloy', label: 'alloy' },
    { id: 'echo', label: 'echo' },
    { id: 'fable', label: 'fable' },
    { id: 'onyx', label: 'onyx' },
    { id: 'nova', label: 'nova' },
    { id: 'shimmer', label: 'shimmer' },
    { id: 'coral', label: 'coral' },
    { id: 'verse', label: 'verse' },
    { id: 'ballad', label: 'ballad' },
    { id: 'ash', label: 'ash' },
    { id: 'sage', label: 'sage' },
    { id: 'marin', label: 'marin' },
    { id: 'cedar', label: 'cedar' },
    { id: 'juniper', label: 'juniper' },
    { id: 'maple', label: 'maple' },
    { id: 'ember', label: 'ember' },
  ],
}

/** Which voice family a speech model belongs to, or null when it takes no voice at all. */
export function speechFamilyOf(model: string): 'elevenlabs' | 'openai' | null {
  const m = model.toLowerCase()
  if (m.includes('elevenlabs')) return 'elevenlabs'
  // Gemini TTS models take OpenAI-style names through this gateway; grouped with openai until
  // measured otherwise rather than given a family of their own on a guess.
  if (m.includes('openai') || m.includes('gemini')) return 'openai'
  // seed-audio ignores `voice` (documented), and auto/tts resolves upstream to an unknown model —
  // in both cases sending a voice risks the paid-then-refused case above.
  return null
}

/** The voices one model accepts. Empty means the model takes no voice and the row is hidden. */
export function speechVoicesFor(model: string): readonly { id: string; label: string }[] {
  const family = speechFamilyOf(model)
  return family ? SPEECH_VOICES[family] : []
}

/**
 * Speed range, which also differs by family.
 *
 * ElevenLabs documents 0.7–1.2; the OpenAI path accepts up to 4.0 (measured: "Expected a value <=
 * 4.0, but got 99"). Offering 1.5× to an ElevenLabs model would be a rejected call.
 */
export function speechSpeedsFor(model: string): readonly number[] {
  return speechFamilyOf(model) === 'elevenlabs' ? [0.7, 0.85, 1, 1.1, 1.2] : [0.75, 1, 1.25, 1.5]
}

/**
 * The limits for one model, falling back to the widest SAFE set rather than the union.
 *
 * `auto/video` resolves upstream to whichever model the gateway picks, so its options have to be
 * ones every candidate accepts — an intersection, not a union. Offering 30s under `auto/video` would
 * 400 whenever it resolved to anything but 2.5.
 */
export function videoLimitsFor(model: string): {
  durations: readonly number[]
  resolutions: readonly string[]
  aspectRatios: readonly string[]
} {
  const exact = VIDEO_LIMITS[model]
  if (exact) return exact
  // Unknown or virtual (`auto/video`): the conservative intersection. 4/8/12 are the only durations
  // every model above accepts, and Sora takes no resolution at all.
  return {
    durations: [4, 8, 12],
    resolutions: ['default', '480p', '720p'],
    aspectRatios: ['default', '16:9', '9:16', '1:1'],
  }
}

export const DEFAULT_OPTIONS: Record<GenerationKind, GenerationOptions> = {
  image: { size: '1024x1024', quality: 'auto', n: 1 },
  video: { duration: 5 },
  music: {},
  speech: { speed: 1 },
}

export interface GenerationResult {
  kind: GenerationKind
  /** Direct media URL when the upstream returns one. */
  url?: string
  /** base64 payload, for upstreams that inline the bytes instead. */
  b64?: string
  /** Set when the call is queued and the media has to be collected later. */
  job?: AsyncJob
  /** Set when the response carried none of the above, so the UI can say so. */
  raw?: string
}

/**
 * A queued generation. The POST is a receipt, not the media.
 *
 * This is what a video call actually returns, and not knowing that cost a user $0.83 for
 * nothing:
 *
 *   POST /v1/videos/generations -> {"id":"…","status":"queued","poll_url":"/v1/videos/generations/…"}
 *
 * `extractMedia` found no url and no b64 in that, fell through to its raw branch, and the
 * page said "the call completed but returned no media we could read". It had completed —
 * the queueing had. The video itself was generated seconds later by the gateway's own
 * background poller and stored under this id, where nothing ever went to look for it.
 *
 * So the receipt is now a first-class result rather than an unreadable one. Anything that
 * charges money and answers asynchronously has to be modelled as asynchronous, because the
 * alternative is a charge whose product exists and is unreachable.
 */
export interface AsyncJob {
  id: string
  /** Absolute URL to poll. Relative paths from the gateway are resolved on the way in. */
  pollUrl: string
}

/** A poll's outcome. `pending` is not a failure — a video legitimately takes minutes. */
export type PollState =
  | { state: 'pending'; message?: string }
  | { state: 'done'; media: GenerationResult }
  | { state: 'failed'; message: string; retryable: boolean }

/** Atomic USDC (6dp) -> dollars. */
function atomicToUsd(amount: string): number {
  const n = Number(amount)
  return Number.isFinite(n) ? n / 1_000_000 : NaN
}

/**
 * Per-generation options the user can set.
 *
 * Every field here maps to a real field on the gateway's request DTO — `size`/`quality`/`n` on
 * ImageRequest, `duration`/`width`/`height` on VideoRequest, `voice`/`speed` on the audio one.
 * Nothing is invented for the UI's benefit: an option that the gateway drops is worse than no
 * option, because the user believes they changed something.
 *
 * MEASURED, and it changes what can honestly be promised: the 402 quote does NOT move with any
 * of these. Same price at 1024 and 1792, at standard and hd, at n=1 and n=2, and — surprisingly
 * — at 5s and 10s of video. Speech is the one exception, and it is not an option at all: its
 * price scales with the LENGTH OF THE TEXT ($0.002 for "hello", $0.0388 for ~700 characters).
 * So the UI must not imply that picking a bigger size costs more, and must not imply speech is
 * flat-rate.
 */
export interface GenerationOptions {
  /** Image: `1024x1024`, `1792x1024`, … */
  size?: string
  /** Image: `auto` | `low` | `medium` | `high` — the upstream's own list, not DALL·E's. */
  quality?: string
  /** Image: how many to make. */
  n?: number
  /** Image: `png` | `jpeg`. Measured: the returned bytes really do change signature. */
  outputFormat?: string
  /** Image: `transparent` | `opaque` | `auto`. Transparency needs png. */
  background?: string
  /**
   * Image: JPEG compression, 0–100.
   *
   * Only meaningful with `output_format: jpeg`. Measured monotonic: 20 -> 396 KB, 60 -> 521 KB,
   * 100 -> 564 KB on one prompt.
   */
  outputCompression?: number
  /** Video: seconds. Sent as `duration_seconds` — see buildBody. */
  duration?: number
  /**
   * Video: `480p` … `4K`, or `default` to let the upstream choose (it defaults to 720p on Seedance).
   *
   * Measured to halve the price at 480p, which is how we know it lands. `default` sends nothing
   * rather than sending the string "default".
   */
  resolution?: string
  /** Video: `adaptive` | `16:9` | `9:16` | `1:1` | `4:3` | `3:4` | `21:9`. Per-model — see VIDEO_LIMITS. */
  aspectRatio?: string
  /**
   * Video: whether the model generates a soundtrack.
   *
   * Seedance only, and it defaults to true for text-to-video. Offered because a silent clip and a
   * scored one are different products, and the default is not obvious from the UI.
   */
  generateAudio?: boolean
  /** Video: reproducibility seed. Seedance only. */
  seed?: number
  /** Speech: a named voice. The upstream offers 37; see GENERATION_CHOICES. */
  voice?: string
  /** Speech: playback rate, 0.25–4.0. */
  speed?: number
  /** Speech: `mp3` | `aac` | `opus` | `flac` | `pcm` | `wav`. */
  responseFormat?: string
  /**
   * Music: no vocals.
   *
   * Cannot be combined with `lyrics` — the upstream 400s on the pair, so the UI clears one when the
   * other is set rather than sending a conflict it already knows will fail.
   */
  instrumental?: boolean
  /**
   * Music: your own lyrics.
   *
   * Omitting this with `instrumental: false` makes the model write its own, which is the documented
   * default and usually what someone wants first.
   *
   * NOT offered: `duration_seconds`. It is documented as ignored — "MiniMax ignores this — output is
   * always ~3 min" — and a length control that does nothing is exactly what this pass removed from
   * the video panel.
   */
  lyrics?: string
}

function buildBody(
  kind: GenerationKind,
  prompt: string,
  model: string,
  options: GenerationOptions = {},
): Record<string, unknown> {
  const spec = GENERATIONS[kind]
  // Keyed off the spec rather than hardcoded, so adding an endpoint cannot silently reuse
  // the wrong field name. /v1/audio/speech reads `input` and 400s on `prompt`.
  const body: Record<string, unknown> = { model, [spec.promptField]: prompt }

  if (kind === 'image') {
    if (options.size) body.size = options.size
    if (options.quality) body.quality = options.quality
    // Guarded, not passed through: n=0 would ask for nothing and still be charged, and a
    // non-integer is rejected by the DTO's *uint.
    if (Number.isInteger(options.n) && (options.n as number) > 0) body.n = options.n
    if (options.outputFormat) body.output_format = options.outputFormat
    if (options.background) body.background = options.background
    /**
     * Only with jpeg, and only in range.
     *
     * The upstream rejects a non-integer outright ("expected an integer, but got a string"), and
     * sending a compression level alongside `output_format: png` asks it to compress a format that
     * does not take a quality level — so it is gated on the format rather than sent hopefully.
     */
    if (
      options.outputFormat === 'jpeg' &&
      Number.isInteger(options.outputCompression) &&
      (options.outputCompression as number) >= 0 &&
      (options.outputCompression as number) <= 100
    ) {
      body.output_compression = options.outputCompression
    }
  }

  if (kind === 'video') {
    /**
     * `duration_seconds`, NOT `duration`.
     *
     * This was `duration` and it was silently ignored for every video ever generated here. The
     * field name is the whole defect: the gateway forwards the video body untouched
     * (PassThroughBodyEnabled), so the wrong name travels all the way to the upstream, which drops
     * it and uses its own default.
     *
     * Measured on UAT with real paid calls, reading the mp4's own mvhd atom rather than trusting
     * any response field:
     *
     *     duration: 10          -> 5.06s   (ignored)
     *     length: 10            -> 5.06s   (ignored)
     *     seconds: 10           -> HTTP 500
     *     duration_seconds: 10  -> 10.05s  ✓
     *
     * Nothing upstream of this could have caught it. The price is identical at 5s and 10s, so the
     * 402 quote is the same either way; the request is a 200 either way; and the job completes
     * either way. The ONLY observable difference is the length of the file the user paid for.
     */
    body.duration_seconds =
      Number.isFinite(options.duration) && (options.duration as number) > 0 ? options.duration : 5
    /**
     * `default` means "send nothing", not the literal string.
     *
     * The upstream validates this field and 400s on a value it does not recognise, so passing
     * "default" through would fail the call — after the charge was approved, which is the shape of
     * defect this whole pass is about.
     */
    if (options.resolution && options.resolution !== 'default') {
      body.resolution = options.resolution
    }
    if (options.aspectRatio && options.aspectRatio !== 'default') {
      body.aspect_ratio = options.aspectRatio
    }
    /**
     * Sent only when the user turned it OFF.
     *
     * `generate_audio` defaults to true for text-to-video and false for image-conditioned, so
     * sending `true` unconditionally would silently switch on audio for an image-seeded clip that
     * the upstream had decided should be silent. Omitting it keeps the upstream's own rule.
     */
    if (options.generateAudio === false) body.generate_audio = false
    // An integer, and 0 is a legitimate seed — hence the explicit Number.isInteger rather than a
    // truthiness check, which would drop it.
    if (Number.isInteger(options.seed)) body.seed = options.seed
  }

  if (kind === 'music') {
    if (options.instrumental) body.instrumental = true
    // Only when there are no vocals to write lyrics for. Sending both is a documented 400.
    else if (options.lyrics && options.lyrics.trim() !== '') body.lyrics = options.lyrics.trim()
  }

  if (kind === 'speech') {
    if (options.voice) body.voice = options.voice
    // Bounded to the range the upstream accepts — measured: "Expected a value <= 4.0, but got 99".
    // An out-of-range speed is a 400 on a call the user has already been quoted for.
    if (Number.isFinite(options.speed) && (options.speed as number) >= 0.25 && (options.speed as number) <= 4) {
      body.speed = options.speed
    }
    if (options.responseFormat) body.response_format = options.responseFormat
  }

  return body
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
  opts: RequestOptions & { model?: string; options?: GenerationOptions } = {},
): Promise<{ challenge: Challenge; usd: number; url: string; body: Record<string, unknown> }> {
  const spec = GENERATIONS[kind]
  const url = `${opts.baseUrl ?? DEFAULT_BASE_URL}${spec.path}`
  // The options are part of the QUOTED body, so the price returned is the price for exactly
  // this request. Quoting a bare body and then sending a different one is how a signature ends
  // up paying for something the gateway never priced.
  const body = buildBody(kind, prompt, opts.model ?? spec.defaultModel, opts.options)

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
  opts: RequestOptions & {
    cred: Credential
    model?: string
    url?: string
    body?: Record<string, unknown>
    options?: GenerationOptions
  },
): Promise<GenerationResult> {
  const spec = GENERATIONS[kind]
  // Re-uses the exact URL and body the challenge was issued for when given them. A payment
  // signed for one body and spent on another is a signature the facilitator may settle
  // while the gateway serves something else.
  const url = opts.url ?? `${opts.baseUrl ?? DEFAULT_BASE_URL}${spec.path}`
  const body = opts.body ?? buildBody(kind, prompt, opts.model ?? spec.defaultModel, opts.options)

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
  // A queued job is checked FIRST, and the order matters. A receipt carries an `id` and a
  // `poll_url` and no media at all, so every media lookup below misses and the function
  // used to end at its raw fallback — reporting an unreadable response for a call that had
  // in fact succeeded in starting. Recognising the receipt is what turns a dead end into a
  // wait.
  const job = extractJob(body)
  if (job) return { kind, job }

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
 * How long each kind is waited for before the UI stops asking.
 *
 * These bound the CLIENT's patience, not the job's. The gateway keeps polling upstream for
 * its own 900s and stores the result either way, so giving up here loses nothing permanently
 * — the media stays retrievable from the same id afterwards, which is why the UI keeps the
 * job on screen with a Check-again button instead of discarding it.
 *
 * A deadline is mandatory rather than defensive: the status route answers "in_progress" for
 * ids that do not exist, so "poll until it stops being pending" is a loop with no exit.
 */
export const POLL_DEADLINE_MS: Record<GenerationKind, number> = {
  // Videos are the slow one and the reason this exists — the $0.83 clip that appeared to
  // return nothing. Upstream takes minutes; the gateway allows itself 900s.
  video: 300_000,
  image: 120_000,
  music: 300_000,
  // Speech is synchronous today (bytes come back inline). Kept short so that if a channel
  // ever queues it, the wait ends rather than hanging.
  speech: 60_000,
}

/** Gap between polls. Matches the gateway's own 5s upstream cadence; the read is free. */
export const POLL_INTERVAL_MS = 5_000

/**
 * Waits for a queued job, reporting progress, until it finishes or the deadline passes.
 *
 * `onTick` exists so the UI can show elapsed time rather than a spinner with no end in
 * sight. Waiting minutes for a video is fine; waiting minutes with no indication that
 * anything is happening is what makes a user reload the page and lose the job id.
 */
export async function awaitJob(
  kind: GenerationKind,
  job: AsyncJob,
  opts: RequestOptions & {
    onTick?: (elapsedMs: number, message?: string) => void
    deadlineMs?: number
  } = {},
): Promise<PollState> {
  const deadline = opts.deadlineMs ?? POLL_DEADLINE_MS[kind]
  const started = Date.now()
  let last: PollState = { state: 'pending' }

  for (;;) {
    const elapsed = Date.now() - started
    if (elapsed >= deadline) {
      // Not reported as a failure: the job is very likely still running, and calling it
      // failed would tell the user their money is gone when the media is probably minutes
      // away. The UI keeps the id and offers to check again.
      return {
        state: 'pending',
        message: last.state === 'pending' ? last.message : undefined,
      }
    }

    last = await pollJob(kind, job, opts)
    if (last.state !== 'pending') return last

    opts.onTick?.(Date.now() - started, last.message)
    await sleep(POLL_INTERVAL_MS, opts.signal)
  }
}

/** A cancellable delay. Rejects on abort so a closed tab or a new prompt stops the loop. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Reads a queued-job receipt, or null when the body is not one.
 *
 * Deliberately strict about what counts as a receipt. A `status` of `completed` with a
 * `poll_url` is a finished job that happens to name its own address, and treating that as
 * pending would make the UI wait for something already in its hands. Equally, an `id` alone
 * is not a receipt — every OpenAI-shaped response has one.
 */
export function extractJob(body: Record<string, unknown>): AsyncJob | null {
  const id = typeof body.id === 'string' ? body.id : ''
  const pollUrl = typeof body.poll_url === 'string' ? body.poll_url : ''
  const status = typeof body.status === 'string' ? body.status : ''
  if (id === '' || status === 'completed' || status === 'failed') return null

  // A relative poll_url is resolved against the gateway, and the fallback is constructed
  // from the id rather than abandoned: the gateway's own status routes are exactly
  // /v1/{videos,images,audio}/generations/:id, so a receipt without a usable poll_url is
  // still pollable. Losing the media because a field was missing is the failure this
  // whole path exists to prevent.
  if (pollUrl === '') return status === 'queued' || status === 'in_progress' ? { id, pollUrl: '' } : null
  return { id, pollUrl }
}

/**
 * The absolute URL to poll for a job of this kind.
 *
 * The id is percent-encoded because job ids are provider-prefixed and contain a colon
 * (`minimax:music_ae260…`). Left raw, the colon makes the path ambiguous and the poll
 * misses the route the gateway told us to use.
 */
export function pollUrlFor(kind: GenerationKind, job: AsyncJob, baseUrl = DEFAULT_BASE_URL): string {
  if (job.pollUrl !== '') {
    return job.pollUrl.startsWith('http') ? job.pollUrl : `${baseUrl}${job.pollUrl}`
  }
  const path = kind === 'image' ? '/v1/images/generations' : kind === 'video' ? '/v1/videos/generations' : '/v1/audio/generations'
  return `${baseUrl}${path}/${encodeURIComponent(job.id)}`
}

/**
 * Polls a queued job once.
 *
 * Polling is free and needs no credential — the gateway's status routes are deliberately
 * unauthenticated (job ids are unguessable UUIDs) and priced at zero, because a poll that
 * charged would bill the same generation twice. Measured: it once did, at $0.46 a read.
 *
 * MEASURED AND IMPORTANT — the gateway answers `200 {"status":"in_progress"}` for ANY id,
 * including ids that never existed. I checked with a freshly minted random UUID and got a
 * cheerful "Video is still generating". So a poll can never prove a job is real, and a
 * client that waits for a terminal state will wait forever on a typo. That is precisely why
 * the caller must impose its own deadline rather than trusting the stream of `pending`s.
 */
export async function pollJob(
  kind: GenerationKind,
  job: AsyncJob,
  opts: RequestOptions = {},
): Promise<PollState> {
  const url = pollUrlFor(kind, job, opts.baseUrl ?? DEFAULT_BASE_URL)
  const res = await fetch(url, { method: 'GET', signal: opts.signal })
  if (!res.ok) {
    // A transport hiccup mid-generation is not a failed job, and calling it one would throw
    // away a video that is still coming. Reported as pending so the caller's deadline — not
    // one bad response — decides when to give up.
    return { state: 'pending', message: `the gateway answered ${res.status} while checking` }
  }

  const body = (await res.json()) as Record<string, unknown>
  const status = typeof body.status === 'string' ? body.status : ''

  if (status === 'failed') {
    // The gateway's failure envelope carries a human-readable `message` and a `retryable`
    // flag, so the reason is passed through rather than replaced with a generic error. It
    // also means "rejected by a content filter" reads differently from "provider timed out",
    // which is the difference between rewriting a prompt and pressing the button again.
    const message =
      (typeof body.message === 'string' && body.message !== '' && body.message) ||
      (typeof body.error === 'string' && body.error !== '' && body.error) ||
      'the provider reported a failure'
    return { state: 'failed', message, retryable: body.retryable !== false }
  }

  const media = extractMedia(kind, body)
  if (media.url || media.b64) return { state: 'done', media }

  return {
    state: 'pending',
    message: typeof body.message === 'string' ? body.message : undefined,
  }
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
