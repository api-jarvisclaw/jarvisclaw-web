import { SlidersHorizontalIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  GENERATION_CHOICES,
  imageAcceptsQuality,
  videoLimitsFor,
  speechVoicesFor,
  speechSpeedsFor,
  type GenerationKind,
  type GenerationOptions as Options,
} from '../lib/modality'
import { useT } from './LocaleContext'

/**
 * The knobs for a generation: image size and quality, video length, speech voice and speed.
 *
 * ## "Checked against a live 402 quote" was not a check
 *
 * That is what this comment used to claim, and TWO of these controls did nothing:
 *
 *   - video duration was sent as `duration`. The upstream reads `duration_seconds` and silently
 *     ignored the rest, so every video was 5 seconds whatever the button said;
 *   - image quality offered `standard` and `hd`. The upstream answers 400 to `hd` — that half of
 *     the control made a paid call FAIL after the charge was approved.
 *
 * A 402 quote cannot see either, because the payment gate sits in front of the upstream and the
 * price does not vary with these fields anyway. The quote is identical at 1024 and 1792, at every
 * quality, at n=1 and n=4, and at 5s versus 10s of video — so it is the same 402 whether the
 * parameter is honoured, ignored, or about to be rejected. Verified now by real paid calls on UAT,
 * reading the artifact itself: the mp4's mvhd atom for duration, the PNG's IHDR for size, the
 * response's echoed `quality`, and the length of `data` for n.
 *
 * Speech price is the exception and it is not a knob — it scales with how much text you type. The
 * footnote says so, because "why did my 10 second video cost the same" is a fair question and the
 * honest answer is "it does"
 */
export function GenerationOptions({
  mode,
  model,
  options,
  onChange,
}: {
  mode: GenerationKind
  /**
   * The resolved model, because the video limits differ per model and offering the union means
   * offering values that 400 after the charge is approved. Sora takes only 4/8/12 seconds and no
   * resolution at all; seedance-2.5 reaches 30s; only 2.0 reaches 4K.
   */
  model?: string
  options: Options
  onChange: (next: Options) => void
}) {
  const t = useT()
  const limits = videoLimitsFor(model ?? '')
  const voices = speechVoicesFor(model ?? '')
  const speeds = speechSpeedsFor(model ?? '')
  const acceptsQuality = imageAcceptsQuality(model ?? '')
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Music used to take nothing beyond a prompt, which was wrong: `instrumental` and `lyrics` are
  // documented and were never offered.

  const summary = describe(mode, options)

  return (
    <div className="genopts" ref={boxRef}>
      <button
        className={open ? 'mode-btn mode-btn-active' : 'mode-btn'}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t('Generation options')}
      >
        <SlidersHorizontalIcon className="mode-glyph" size={15} aria-hidden="true" />
        {summary}
      </button>

      {open && (
        // Opens upward for the same reason the model picker does: the composer sits at the
        // bottom of the viewport and a downward menu would be off-screen.
        <div className="genopts-menu">
          {mode === 'image' && (
            <>
              <Choices
                label={t('Size')}
                values={GENERATION_CHOICES.image.size}
                current={options.size ?? '1024x1024'}
                onPick={(size) => onChange({ ...options, size: String(size) })}
              />
              {/* Hidden for models that refuse the field, the same per-model treatment the video
                  and speech controls already get.
                  gpt-image-2 answers 400 to `quality` outright — "it is priced per size at its
                  default tier" — and this app defaults it to 'auto', so offering the control
                  would let someone set a value that guarantees a 400. Showing a knob whose only
                  effect is to break the call is worse than not showing it. */}
              {acceptsQuality && (
                <Choices
                  label={t('Quality')}
                  values={GENERATION_CHOICES.image.quality}
                  current={options.quality ?? 'auto'}
                  onPick={(quality) => onChange({ ...options, quality: String(quality) })}
                />
              )}
              <Choices
                label={t('Count')}
                values={GENERATION_CHOICES.image.n}
                current={options.n ?? 1}
                onPick={(n) => onChange({ ...options, n: Number(n) })}
              />
              {/* Measured against the returned bytes: jpeg really comes back as ffd8, png as
                  89504e47. Offered because a jpeg is roughly a quarter of the size, which matters
                  for a file the user is going to download. */}
              <Choices
                label={t('Format')}
                values={GENERATION_CHOICES.image.outputFormat}
                current={options.outputFormat ?? 'png'}
                onPick={(f) =>
                  onChange({
                    ...options,
                    outputFormat: String(f),
                    // A transparent jpeg is not a thing, so switching away from png drops it rather
                    // than sending a combination the upstream would have to resolve for us.
                    background:
                      String(f) !== 'png' && options.background === 'transparent'
                        ? 'auto'
                        : options.background,
                  })
                }
              />
              <Choices
                label={t('Background')}
                values={
                  // `transparent` is withheld rather than shown-and-rejected when the format cannot
                  // carry it: an option that silently does nothing is the defect this panel just
                  // had two of.
                  (options.outputFormat ?? 'png') === 'png'
                    ? GENERATION_CHOICES.image.background
                    : GENERATION_CHOICES.image.background.filter((b) => b !== 'transparent')
                }
                current={options.background ?? 'auto'}
                onPick={(b) => onChange({ ...options, background: String(b) })}
              />
              {(options.outputFormat ?? 'png') === 'jpeg' && (
                // Only for jpeg, and only then. Measured monotonic: 20 -> 396 KB, 60 -> 521 KB,
                // 100 -> 564 KB.
                <Choices
                  label={t('Compression')}
                  values={GENERATION_CHOICES.image.outputCompression}
                  current={options.outputCompression ?? 80}
                  format={(v) => `${v}%`}
                  onPick={(c) => onChange({ ...options, outputCompression: Number(c) })}
                />
              )}
            </>
          )}

          {mode === 'edit' && (
            <>
              {/* The source image, and the ONLY control here that is not optional.
                  The gateway will not catch its absence: measured, /v1/images/edits returns the
                  same 402 with the image, without it, and under four different field spellings.
                  So an edit with nothing attached is quoted, PAID FOR, and only then refused —
                  money gone, nothing produced. This control is what prevents that, which is why
                  it sits at the top and why the send path checks it again. */}
              <SourceImage
                current={options.sourceImage}
                onPick={(sourceImage) => onChange({ ...options, sourceImage })}
              />
              <Choices
                label={t('Size')}
                values={GENERATION_CHOICES.image.size}
                current={options.size ?? '1024x1024'}
                onPick={(size) => onChange({ ...options, size: String(size) })}
              />
              <Choices
                label={t('Count')}
                values={GENERATION_CHOICES.image.n}
                current={options.n ?? 1}
                onPick={(n) => onChange({ ...options, n: Number(n) })}
              />
            </>
          )}

          {mode === 'video' && (
            <>
              <Choices
                label={t('Length')}
                values={limits.durations}
                current={options.duration ?? 5}
                format={(v) => `${v}s`}
                onPick={(duration) => onChange({ ...options, duration: Number(duration) })}
              />
              {/* 480p settles at exactly half the default's price — measured, 284,370 against
                  568,240 — so unlike the other controls this one DOES change what you pay. Said
                  plainly in the footnote below rather than left for someone to notice on a receipt. */}
              <Choices
                label={t('Resolution')}
                values={limits.resolutions}
                current={options.resolution ?? 'default'}
                onPick={(r) => onChange({ ...options, resolution: String(r) })}
              />
              {/* Seven documented values, and the single most useful control here for anyone posting
                  to a phone-shaped feed. 9:16 was unreachable before. */}
              <Choices
                label={t('Shape')}
                values={limits.aspectRatios}
                current={options.aspectRatio ?? 'default'}
                onPick={(a) => onChange({ ...options, aspectRatio: String(a) })}
              />
              {/* Seedance scores text-to-video by default, and there was no way to ask for silence.
                  Only sent when switched OFF — see buildBody: forcing `true` would turn on audio for
                  an image-seeded clip the upstream had decided should be silent. */}
              <Choices
                label={t('Audio')}
                values={['on', 'off'] as const}
                current={options.generateAudio === false ? 'off' : 'on'}
                // The chip labels go through t() too. Without `format` they render as literal
                // "on"/"off" — English words on a Chinese panel, and the guard flagged them as keys
                // nothing asks for, which is the same signal from the other side.
                format={(v) => t(v)}
                onPick={(v) => onChange({ ...options, generateAudio: v !== 'off' })}
              />
            </>
          )}

          {mode === 'speech' && (
            <>
              {/* Scoped to the model's own family, because a cross-family name does NOT 400 — it
                  settles the payment and THEN gets refused: "upstream 402 after payment — USDC
                  already settled on-chain and cannot be reversed". Measured with
                  elevenlabs/flash-v2.5 + alloy. Every other wrong option here costs a failed call;
                  this one costs the charge too.

                  Hidden entirely for models that ignore `voice` (seed-audio steers delivery from the
                  prompt text) rather than shown as a control that does nothing. */}
              {voices.length > 0 && (
                <Choices
                  label={t('Voice')}
                  values={voices.map((v) => v.id)}
                  current={options.voice ?? voices[0].id}
                  format={(id) => voices.find((v) => v.id === id)?.label ?? String(id)}
                  onPick={(voice) => onChange({ ...options, voice: String(voice) })}
                />
              )}
              <Choices
                label={t('Speed')}
                values={speeds}
                current={options.speed ?? 1}
                format={(v) => `${v}×`}
                onPick={(speed) => onChange({ ...options, speed: Number(speed) })}
              />
              {/* The upstream serves six audio formats and this UI offered none, so every clip was
                  mp3 whether or not that was wanted. mp3 stays the default: it is what the in-page
                  player is guaranteed to decode. */}
              <Choices
                label={t('Format')}
                values={GENERATION_CHOICES.speech.responseFormat}
                current={options.responseFormat ?? 'mp3'}
                onPick={(f) => onChange({ ...options, responseFormat: String(f) })}
              />
            </>
          )}

          {mode === 'music' && (
            <>
              {/* Documented and never offered. `instrumental` and `lyrics` cannot be combined — the
                  upstream 400s on the pair — so picking one clears the other here rather than
                  sending a conflict we already know fails. */}
              <Choices
                label={t('Vocals')}
                values={['sung', 'instrumental'] as const}
                current={options.instrumental ? 'instrumental' : 'sung'}
                format={(v) => t(v)}
                onPick={(v) =>
                  onChange({
                    ...options,
                    instrumental: v === 'instrumental',
                    lyrics: v === 'instrumental' ? undefined : options.lyrics,
                  })
                }
              />
              {!options.instrumental && (
                <div className="genopts-row">
                  <span className="genopts-label">{t('Lyrics')}</span>
                  {/* Left empty means the model writes its own, which is the documented default and
                      what someone wants on a first try. */}
                  <textarea
                    className="genopts-text"
                    rows={3}
                    value={options.lyrics ?? ''}
                    placeholder={t('leave empty and the model writes them')}
                    onChange={(e) => onChange({ ...options, lyrics: e.target.value })}
                  />
                </div>
              )}
            </>
          )}

          <p className="genopts-note">
            {mode === 'speech'
              ? t('Speech is priced by how much text you send, not by these settings. The exact price is quoted before anything is spent.')
              : mode === 'video'
                ? // Measured: 480p settles at half. Saying "these do not change the price" here
                  // would be false, and the one place it matters is the one place it is checked.
                  t('Length does not change the price, but 480p costs about half. The exact amount is quoted before anything is spent.')
                : t('These do not change the price — the quote is the same either way. You always see it before anything is spent.')}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * The source image for an edit mode, read locally into a `data:` URL.
 *
 * ## Why the bytes are inlined rather than uploaded first
 *
 * The image has to be part of the QUOTED body, because a payment is signed against a URL and an
 * amount and then spent on the body we send. Uploading somewhere first would mean the quote
 * covered a request that referenced a file the gateway may not be able to read — and the gateway
 * cannot tell us, since it prices /v1/images/edits identically with the image, without it, and
 * under four different field spellings.
 *
 * ## The size cap is not defensive
 *
 * A `data:` URL of a phone photo is several megabytes of base64 in a JSON body, and this app has
 * already lost user data once to exactly that shape: seven inlined speech clips filled the
 * origin's 4 MB localStorage, after which every conversation write failed SILENTLY and a refresh
 * discarded everything since. The turn does not persist this field, but the cap keeps the request
 * itself sane and gives a reason the user can act on rather than a failure they cannot see.
 */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024

function SourceImage({
  current,
  onPick,
}: {
  current?: string
  onPick: (dataUrl: string | undefined) => void
}) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const read = (file: File) => {
    setProblem(null)
    if (!file.type.startsWith('image/')) {
      setProblem(t('That file is not an image.'))
      return
    }
    if (file.size > MAX_SOURCE_BYTES) {
      // Named in MB because "4194304 bytes" is not something anyone can act on.
      setProblem(t('That image is over 4 MB. Pick a smaller one.'))
      return
    }
    const reader = new FileReader()
    // onerror as well as onload: a file that vanishes or cannot be read otherwise leaves the
    // panel looking like it accepted something, and the next thing the user does is pay.
    reader.onerror = () => setProblem(t('That image could not be read.'))
    reader.onload = () => {
      const out = reader.result
      if (typeof out === 'string') onPick(out)
      else setProblem(t('That image could not be read.'))
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="genopts-row">
      <span className="genopts-label">{t('Source image')}</span>
      <div className="genopts-choices">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) read(file)
            // Cleared so choosing the SAME file twice fires onChange again. Without this a
            // user who picked the wrong image, then re-picked the right one, could find the
            // second attempt silently ignored.
            e.target.value = ''
          }}
        />
        {current ? (
          <>
            {/* The chosen image itself, not a filename. This is the one control whose value
                the user cannot otherwise verify before paying. */}
            <img className="genopts-thumb" src={current} alt={t('Source image')} />
            <button className="genopts-chip" onClick={() => inputRef.current?.click()}>
              {t('Replace')}
            </button>
            <button className="genopts-chip" onClick={() => onPick(undefined)}>
              {t('Remove')}
            </button>
          </>
        ) : (
          <button className="genopts-chip" onClick={() => inputRef.current?.click()}>
            {t('Choose an image…')}
          </button>
        )}
      </div>
      {problem && <span className="genopts-problem">{problem}</span>}
    </div>
  )
}

function Choices<T extends string | number>({
  label,
  values,
  current,
  format,
  onPick,
}: {
  label: string
  values: readonly T[]
  current: T | string | number
  format?: (v: T) => string
  onPick: (v: T) => void
}) {
  return (
    <div className="genopts-row">
      <span className="genopts-label">{label}</span>
      <div className="genopts-choices">
        {values.map((v) => (
          <button
            key={String(v)}
            className={v === current ? 'genopts-chip genopts-chip-active' : 'genopts-chip'}
            onClick={() => onPick(v)}
            aria-pressed={v === current}
          >
            {format ? format(v) : String(v)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The button's own label: the settings that are actually in play.
 *
 * Shown on the button rather than hidden behind it, because a collapsed panel that says only
 * "Options" gives no way to notice that a previous message left the count at 4.
 */
export function describe(mode: GenerationKind, o: Options): string {
  if (mode === 'image') {
    const parts = [o.size ?? '1024x1024']
    if (o.quality && o.quality !== 'auto') parts.push(o.quality)
    if (o.n && o.n > 1) parts.push(`×${o.n}`)
    return parts.join(' · ')
  }
  if (mode === 'video') return `${o.duration ?? 5}s`
  if (mode === 'speech') {
    const parts: string[] = []
    if (o.voice) parts.push(o.voice)
    if (o.speed && o.speed !== 1) parts.push(`${o.speed}×`)
    return parts.length > 0 ? parts.join(' · ') : 'Options'
  }
  return 'Options'
}
