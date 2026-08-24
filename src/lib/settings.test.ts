import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SETTINGS,
  LIMITS,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from './settings'
import { PER_SIGNATURE_CAP_USDC } from './wallet'

/** A localStorage that behaves, so the tests exercise the real read/write path. */
function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const mock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
  vi.stubGlobal('localStorage', mock)
  return store
}

beforeEach(() => {
  stubStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeSettings', () => {
  it('keeps values that are already sane', () => {
    expect(normalizeSettings({ perCallUsd: 0.2, sessionUsd: 5, perSignatureUsd: 2 })).toEqual({
      perCallUsd: 0.2,
      sessionUsd: 5,
      perSignatureUsd: 2,
    })
  })

  it('rejects NaN rather than clamping it', () => {
    // The important case, and not a theoretical one: a NaN threshold makes every comparison
    // against it false, which silently DISABLES the gate instead of tightening it. Clamping
    // cannot catch this because NaN fails min and max alike.
    const s = normalizeSettings({ perCallUsd: Number.NaN, sessionUsd: Number.NaN, perSignatureUsd: Number.NaN })
    expect(s).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects a non-numeric string the same way', () => {
    const s = normalizeSettings({ perCallUsd: 'lots' as unknown as number })
    expect(s.perCallUsd).toBe(DEFAULT_SETTINGS.perCallUsd)
  })

  it('caps the signature limit at the wallet’s own hard ceiling', () => {
    // A page reachable by anyone must not be able to authorise an arbitrary transfer because
    // someone typed an extra zero, or because localStorage was tampered with.
    //
    // Asserted against PER_SIGNATURE_CAP_USDC, NOT against LIMITS.perSignatureUsd.max. The
    // first version compared the result to the very bound it was testing, so widening that
    // bound to 1e12 kept the test green — a test that reads its own subject as the expected
    // value can never fail. The wallet's cap is the independent fact worth pinning.
    const s = normalizeSettings({ perSignatureUsd: 100_000 })
    expect(s.perSignatureUsd).toBeLessThanOrEqual(PER_SIGNATURE_CAP_USDC)
  })

  it('states the bounds as literals, so widening one is a deliberate edit', () => {
    // The bounds themselves, spelled out. Without this, raising a max is a one-character
    // change that no test notices.
    expect(LIMITS.sessionUsd.max).toBe(500)
    expect(LIMITS.perCallUsd.max).toBe(50)
  })

  it('never lets the panel offer a cap signPayment would refuse', () => {
    // This caught a real disagreement: the panel allowed up to $50 while signPayment refuses
    // above PER_SIGNATURE_CAP_USDC ($5). A user could set $20, watch it save, and then hit
    // "refusing to sign" — a setting that appears to take effect and silently cannot.
    expect(LIMITS.perSignatureUsd.max).toBe(PER_SIGNATURE_CAP_USDC)
  })

  it('refuses a zero or negative session budget', () => {
    // Zero would refuse every charge including ones the user just approved, which reads as
    // the console being broken rather than as a budget being set.
    expect(normalizeSettings({ sessionUsd: 0 }).sessionUsd).toBe(LIMITS.sessionUsd.min)
    expect(normalizeSettings({ sessionUsd: -5 }).sessionUsd).toBe(LIMITS.sessionUsd.min)
  })

  it('allows a per-call limit of zero, which means ask about everything', () => {
    // Not clamped away: "ask me about every charge" is a legitimate preference, and it is the
    // conservative direction. Only the session budget has a non-zero floor.
    expect(normalizeSettings({ perCallUsd: 0, sessionUsd: 1 }).perCallUsd).toBe(0)
  })

  it('lowers a per-call limit above the session budget', () => {
    // Otherwise the per-call gate is dead: nothing can be individually big enough to prompt
    // about before the session budget refuses it outright.
    const s = normalizeSettings({ perCallUsd: 10, sessionUsd: 2 })
    expect(s.perCallUsd).toBe(2)
    expect(s.sessionUsd).toBe(2)
  })

  it('survives junk instead of throwing', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS)
  })

  it('defaults the signature cap to the wallet module’s own constant', () => {
    // Two sources of truth for a safety limit is one too many; the default must be the value
    // signPayment enforces, not a copy that can drift from it.
    expect(DEFAULT_SETTINGS.perSignatureUsd).toBe(PER_SIGNATURE_CAP_USDC)
  })
})

describe('load and save', () => {
  it('round-trips a change', () => {
    saveSettings({ perCallUsd: 0.25, sessionUsd: 10, perSignatureUsd: 3 })
    expect(loadSettings()).toEqual({ perCallUsd: 0.25, sessionUsd: 10, perSignatureUsd: 3 })
  })

  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('normalises what it reads back, not just what it writes', () => {
    // The stored value may have been hand-edited, or written by an older version. Trusting it
    // is how a tampered entry raises a spending ceiling.
    stubStorage({
      'jarvisclaw.settings.v1': JSON.stringify({ perSignatureUsd: 999999, sessionUsd: 'huge' }),
    })
    const s = loadSettings()
    expect(s.perSignatureUsd).toBeLessThanOrEqual(LIMITS.perSignatureUsd.max)
    expect(s.sessionUsd).toBe(DEFAULT_SETTINGS.sessionUsd)
  })

  it('falls back to defaults on corrupt JSON', () => {
    stubStorage({ 'jarvisclaw.settings.v1': '{not json' })
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('does not throw when storage is unavailable', () => {
    // Private mode with site data blocked throws on access. A console that cannot save a
    // preference must still be a console.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(() => loadSettings()).not.toThrow()
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow()
  })

  it('stores no credential of any kind', () => {
    // The safety argument for persisting limits at all: a stored limit widens what MAY be
    // approved and can never approve anything itself. Anything spendable in here would break
    // that, so the written shape is pinned to exactly the three thresholds.
    saveSettings({ perCallUsd: 0.1, sessionUsd: 2, perSignatureUsd: 1 })
    const raw = localStorage.getItem('jarvisclaw.settings.v1') ?? ''
    // An exact key allowlist, not a scan for suspicious words. A scan is both weaker and
    // wrong here: `perSignatureUsd` legitimately contains "signature", so a word blocklist
    // fails on a correct value while still missing any key nobody thought to blocklist.
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'perCallUsd',
      'perSignatureUsd',
      'sessionUsd',
    ])
    // Every stored value must be a plain number. A string here would be the only way
    // something spendable could ride along.
    for (const v of Object.values(JSON.parse(raw) as Record<string, unknown>)) {
      expect(typeof v).toBe('number')
    }
  })
})
