import { SlidersHorizontalIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  GENERATION_CHOICES,
  videoLimitsFor,
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

  // Music takes nothing beyond a prompt, so the button would open an empty panel.
  if (mode === 'music') return null

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
              <Choices
                label={t('Quality')}
                values={GENERATION_CHOICES.image.quality}
                current={options.quality ?? 'auto'}
                onPick={(quality) => onChange({ ...options, quality: String(quality) })}
              />
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
              <Choices
                label={t('Voice')}
                values={GENERATION_CHOICES.speech.voice}
                current={options.voice ?? 'default'}
                onPick={(voice) => onChange({ ...options, voice: String(voice) })}
              />
              <Choices
                label={t('Speed')}
                values={GENERATION_CHOICES.speech.speed}
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
