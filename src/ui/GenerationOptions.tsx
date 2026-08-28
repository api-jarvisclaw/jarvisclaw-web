import { SlidersHorizontalIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  GENERATION_CHOICES,
  type GenerationKind,
  type GenerationOptions as Options,
} from '../lib/modality'
import { useT } from './LocaleContext'

/**
 * The knobs for a generation: image size and quality, video length, speech voice and speed.
 *
 * Every control here maps to a field the gateway's DTO actually reads, and every value was
 * checked against a live 402 quote. That check is the difference between an option and a
 * decoration: a control the gateway silently drops is worse than no control, because the user
 * believes they changed something.
 *
 * One thing this panel deliberately does NOT do is imply that a bigger choice costs more.
 * Measured on the live gateway: the quote is identical at 1024 and 1792, at standard and hd, at
 * n=1 and n=4, and even at 5s versus 10s of video. Speech is the exception and it is not a knob —
 * its price scales with how much text you type. The footnote says so, because "why did my 10
 * second video cost the same" is a fair question and the honest answer is "it does".
 */
export function GenerationOptions({
  mode,
  options,
  onChange,
}: {
  mode: GenerationKind
  options: Options
  onChange: (next: Options) => void
}) {
  const t = useT()
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
                label="Size"
                values={GENERATION_CHOICES.image.size}
                current={options.size ?? '1024x1024'}
                onPick={(size) => onChange({ ...options, size: String(size) })}
              />
              <Choices
                label="Quality"
                values={GENERATION_CHOICES.image.quality}
                current={options.quality ?? 'standard'}
                onPick={(quality) => onChange({ ...options, quality: String(quality) })}
              />
              <Choices
                label="Count"
                values={GENERATION_CHOICES.image.n}
                current={options.n ?? 1}
                onPick={(n) => onChange({ ...options, n: Number(n) })}
              />
            </>
          )}

          {mode === 'video' && (
            <Choices
              label="Length"
              values={GENERATION_CHOICES.video.duration}
              current={options.duration ?? 5}
              format={(v) => `${v}s`}
              onPick={(duration) => onChange({ ...options, duration: Number(duration) })}
            />
          )}

          {mode === 'speech' && (
            <>
              <Choices
                label="Voice"
                values={GENERATION_CHOICES.speech.voice}
                current={options.voice ?? 'default'}
                onPick={(voice) => onChange({ ...options, voice: String(voice) })}
              />
              <Choices
                label="Speed"
                values={GENERATION_CHOICES.speech.speed}
                current={options.speed ?? 1}
                format={(v) => `${v}×`}
                onPick={(speed) => onChange({ ...options, speed: Number(speed) })}
              />
            </>
          )}

          <p className="genopts-note">
            {mode === 'speech'
              ? 'Speech is priced by how much text you send, not by these settings. The exact price is quoted before anything is spent.'
              : 'These do not change the price — the quote is the same either way. You always see it before anything is spent.'}
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
    if (o.quality && o.quality !== 'standard') parts.push(o.quality)
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
