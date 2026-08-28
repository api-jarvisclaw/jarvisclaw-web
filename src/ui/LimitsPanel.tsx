import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useState } from 'react'

import { LIMITS, type Settings } from '../lib/settings'
import { useT } from './LocaleContext'

/**
 * The spend limits, editable.
 *
 * These were constants, which is why the console could only nag or block: someone who wanted
 * fewer prompts had no way to say so, and someone who wanted a bigger budget had to reload
 * into the same $1.00.
 *
 * The wording matters as much as the inputs. Each row says what the number DOES, because
 * "per-call limit" and "session budget" are different kinds of gate — one asks, one stops —
 * and a user who thinks both merely ask will set the second one wrong.
 */
export function LimitsPanel({
  settings,
  onChange,
}: {
  settings: Settings
  onChange: (next: Settings) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)

  return (
    <section>
      <button
        className="section-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <h2>{t('Limits')}</h2>
        {open ? (
          <ChevronUpIcon className="caret" size={14} aria-hidden="true" />
        ) : (
          <ChevronDownIcon className="caret" size={14} aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="panel">
          <Row
            label="Ask above"
            hint="Charges at or under this run without asking. Raise it to stop being prompted for small calls."
            value={settings.perCallUsd}
            bounds={LIMITS.perCallUsd}
            // 0.001, not 0.01: a chat step costs about $0.001, so cent-granularity would make
            // the most common charge size unreachable with the spinner and would fail HTML
            // validation for a typed sub-cent value.
            step={0.001}
            onCommit={(perCallUsd) => onChange({ ...settings, perCallUsd })}
          />
          <Row
            label="Stop at"
            hint="Total for this session. Not a prompt — nothing is spent past it."
            value={settings.sessionUsd}
            bounds={LIMITS.sessionUsd}
            step={0.5}
            onCommit={(sessionUsd) => onChange({ ...settings, sessionUsd })}
          />
          <Row
            label="Max per signature"
            hint="Refuses to sign more than this in one payment, whatever the price says."
            value={settings.perSignatureUsd}
            bounds={LIMITS.perSignatureUsd}
            step={0.5}
            onCommit={(perSignatureUsd) => onChange({ ...settings, perSignatureUsd })}
          />

          {/*
            Stated because it is the one thing a limits panel might be assumed to change and
            cannot. Every payment is signed in the wallet, per call — one x402 signature
            authorises exactly one request. Raising a limit removes OUR prompt, never the
            wallet's, and implying otherwise would be promising away someone's last
            confirmation before money moves.
          */}
          <p className="panel-note">
            {t("Your wallet still asks you to sign every payment. These limits control this page's own prompts and its spending ceiling.")}
          </p>
        </div>
      )}
    </section>
  )
}

/**
 * A dollar amount, at the precision it actually has.
 *
 * `toFixed(2)` was wrong here and not merely ugly: it rendered a stored 0.001 as "0.00", and
 * zero means "ask about everything" — the exact opposite of the setting. Charges on this page
 * are routinely sub-cent (a chat step is about $0.001), so two decimals cannot express the
 * useful range. Plain `String` fixed that but showed 1 as "1", which reads as unset next to a
 * dollar sign. So: at least two decimals, more only when the value needs them.
 */
export function format(value: number): string {
  if (!Number.isFinite(value)) return '0.00'
  const two = value.toFixed(2)
  return Number(two) === value ? two : String(value)
}

function Row({
  label,
  hint,
  value,
  bounds,
  step,
  onCommit,
}: {
  label: string
  hint: string
  value: number
  bounds: { min: number; max: number }
  step: number
  onCommit: (v: number) => void
}) {
  // Kept as a string while editing. A number-typed state would fight the user mid-keystroke:
  // clearing the box to retype gives "", which coerces to 0 and would silently commit a limit
  // of zero — the exact setting that asks about every charge.
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? format(value)

  const commit = () => {
    if (draft === null) return
    const n = Number(draft)
    // An unreadable entry reverts rather than commits. Committing NaN would disable the gate:
    // every comparison against it is false.
    if (Number.isFinite(n)) {
      onCommit(Math.min(bounds.max, Math.max(bounds.min, n)))
    }
    setDraft(null)
  }

  return (
    <div className="limit-row">
      <label className="limit-head">
        <span className="limit-label">{label}</span>
        <span className="limit-input">
          <span aria-hidden="true">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={bounds.min}
            max={bounds.max}
            step={step}
            value={shown}
            aria-label={`${label} in US dollars`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
        </span>
      </label>
      <p className="limit-hint">{hint}</p>
    </div>
  )
}
