/**
 * Spend limits the user sets, persisted across sessions.
 *
 * The limits were constants: ask above $0.05, stop at $1.00, refuse any signature above $5.
 * Reasonable defaults, but a console whose budget nobody can change is a console that either
 * nags or blocks — and the user hit both, being asked to confirm even a FREE search.
 *
 * What is stored here, and what deliberately is not:
 *
 *   stored      — the three thresholds. They are preferences, not credentials, and losing
 *                 them on reload is what made the nagging feel unfixable.
 *   NOT stored  — anything that could spend on its own. No key, no signature, no wallet
 *                 authorisation. A saved limit widens what MAY be approved; it can never
 *                 approve anything by itself, because every charge still needs the wallet's
 *                 own signature prompt, which this page cannot suppress.
 *
 * That distinction is the whole safety argument for persisting them: the worst a tampered
 * localStorage value can do is raise a threshold the wallet will still ask about.
 */

import { PER_SIGNATURE_CAP_USDC } from './wallet'

const KEY = 'jarvisclaw.settings.v1'

export interface Settings {
  /** Charges at or below this run without an in-app prompt. */
  perCallUsd: number
  /** Total for one session, after which nothing more is spent. */
  sessionUsd: number
  /** Refuse to sign anything above this, whatever the gateway quoted. */
  perSignatureUsd: number
}

export const DEFAULT_SETTINGS: Settings = {
  perCallUsd: 0.05,
  sessionUsd: 1.0,
  perSignatureUsd: PER_SIGNATURE_CAP_USDC,
}

/**
 * Hard bounds on what a user may set.
 *
 * Not paternalism — two specific failures:
 *
 *   - a per-call limit of 0 asks about every charge including sub-cent ones, which is the
 *     nagging this change exists to remove;
 *   - an unbounded signature cap turns one fat-fingered zero into a real transfer, and the
 *     cap is the last line of defence before the wallet prompt.
 *
 * The ceiling is deliberately not "whatever they type". Someone who genuinely wants to spend
 * $500 in one signature should do it from the CLI with a funded wallet, not from a web page
 * they may have opened from a link.
 */
export const LIMITS = {
  perCallUsd: { min: 0, max: 50 },
  sessionUsd: { min: 0.01, max: 500 },
  /**
   * Bounded by the wallet module's own cap, not by a number chosen here.
   *
   * A test caught this disagreeing: the ceiling was 50 while `signPayment` refuses anything
   * above PER_SIGNATURE_CAP_USDC ($5). Someone could then set $20 in the panel, watch it save,
   * and get "refusing to sign" on the first payment that used it — a setting that appears to
   * take effect and silently cannot. Deriving the bound is what keeps the two from drifting.
   */
  perSignatureUsd: { min: 0.01, max: PER_SIGNATURE_CAP_USDC },
} as const

function clampField(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  // NaN fails every comparison, so it must be caught explicitly rather than clamped — a
  // NaN threshold would make every comparison against it false and silently disable the gate.
  if (!Number.isFinite(n)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, n))
}

/**
 * Coerces anything into usable settings.
 *
 * Applied to stored values AND to live edits, so a hand-edited localStorage entry and a typo
 * in the input take the same path. Returning defaults for junk rather than throwing keeps a
 * corrupt entry from making the console unusable.
 */
export function normalizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>
  const next: Settings = {
    perCallUsd: clampField(r.perCallUsd, LIMITS.perCallUsd, DEFAULT_SETTINGS.perCallUsd),
    sessionUsd: clampField(r.sessionUsd, LIMITS.sessionUsd, DEFAULT_SETTINGS.sessionUsd),
    perSignatureUsd: clampField(
      r.perSignatureUsd,
      LIMITS.perSignatureUsd,
      DEFAULT_SETTINGS.perSignatureUsd,
    ),
  }

  // A per-call limit above the session budget is not an error, but it does make the per-call
  // gate meaningless: nothing can be individually large enough to ask about before the
  // session budget refuses it outright. Lowered rather than rejected, so the setting the user
  // typed still means what it says.
  if (next.perCallUsd > next.sessionUsd) {
    next.perCallUsd = next.sessionUsd
  }
  return next
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return { ...DEFAULT_SETTINGS }
    return normalizeSettings(JSON.parse(raw))
  } catch {
    // Unavailable or corrupt store. Defaults keep the console working; the alternative is a
    // page that will not load because a preference could not be read.
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeSettings(s)))
  } catch {
    // A full or blocked store must not interrupt a working session. The value still applies
    // in memory for this tab.
  }
}
