import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { LOCALES } from './i18n'
import { coverage, knownKeys, translate } from './strings'

/**
 * The guard that makes "the English text is the key" safe.
 *
 * That scheme has one real cost: rewording the English orphans its translation SILENTLY. The page
 * keeps working — the new key falls through to itself, which is correct English — so the Chinese
 * screen loses a line and nothing anywhere says so. Only a reader of Chinese would notice, and this
 * project has one.
 *
 * So this reads the source, collects every `t('…')` argument, and fails on any that strings.ts does
 * not know. It is the reason the scheme is defensible; deleting it in a cleanup would remove the
 * only thing standing between a reworded button and an untranslated one.
 */

/**
 * `fileURLToPath`, not `new URL(...).pathname`.
 *
 * On Windows the latter yields `/D:/…`, which `join` then turns into `D:\D:\…` — the directory scan
 * throws ENOENT and vitest reports "no tests" for the whole file. Green-looking output for a guard
 * that never executed, which is precisely the failure this guard exists to prevent.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(e.name) && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

/**
 * Every `t('…')` call in the source.
 *
 * Single and double quotes, and a `{'…'}` JSX form. NOT template literals: `t(`…${x}`)` cannot be
 * checked against a static table at all, which is why the interpolation in translate() uses named
 * `{vars}` instead. A template literal passed to `t` is a mistake this test cannot see, so it is
 * also asserted against below.
 */
/**
 * `(?!\1)` — anything that is not the OPENING quote, rather than neither quote character.
 *
 * `[^'"\\]` stopped at the apostrophe inside `t("Don't spend")` and captured `Don`, which is not a
 * catalogue key. The translation then read as an orphan, and the fix that suggests itself is
 * deleting it — untranslating the button that REFUSES a payment.
 */
const T_CALL = /\bt\(\s*(['"])((?:(?!\1)[^\\]|\\.)+?)\1/g
const T_TEMPLATE = /\bt\(\s*`/g

/**
 * Keys reached through a variable, which no static scan can see.
 *
 * `t(item.label)` in both nav bars looks up strings held in lib/nav.ts. The scan above cannot follow
 * that, so those keys would read as orphans in the catalogue and a reviewer would delete them —
 * untranslating the entire navigation on both bars, with every test still green.
 *
 * Listed here explicitly rather than by loosening the orphan check, because "we cannot see this one"
 * is a fact worth writing down once per case instead of a hole left open for all of them.
 */
const DYNAMIC_KEYS = [
  // lib/nav.ts labels, rendered as t(item.label).
  'How it works',
  'Compare',
  'Pricing',
  'Marketplace',
  'Gallery',
  'FAQ',
  'Docs',
  'Blog',
  'Platform',
]

function callsIn(text: string): string[] {
  const out: string[] = []
  // matchAll on a /g regex is stateful per call, so the literal is re-read each time rather than
  // shared — a shared lastIndex would make results depend on file order.
  for (const m of text.matchAll(new RegExp(T_CALL.source, 'g'))) {
    out.push(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"'))
  }
  return out
}

const files = sourceFiles(SRC).filter((f) => !f.endsWith('strings.ts'))

describe('the translation catalogue', () => {
  it('reads the source at all', () => {
    // The zero-sample trap this whole file could fall into: if the glob stops matching, every
    // assertion below passes over an empty list and reports a clean translation.
    expect(files.length).toBeGreaterThan(20)
  })

  it('knows every key the source asks for', () => {
    const known = new Set(knownKeys())
    const missing: string[] = []
    let calls = 0
    for (const f of files) {
      for (const key of callsIn(readFileSync(f, 'utf8'))) {
        calls++
        if (!known.has(key)) missing.push(`${f.slice(SRC.length)}: ${JSON.stringify(key)}`)
      }
    }
    // Stated so a passing run reports its denominator rather than just going green.
    expect(calls, 'no t() calls found — the matcher stopped working').toBeGreaterThan(10)
    expect(missing).toEqual([])
  })

  it('has no key the source never asks for', () => {
    // The other direction, and the one that rots quietly: a translated string left behind after its
    // component changed. Harmless on screen, but it makes the catalogue an unreliable record of what
    // is actually translated, and coverage numbers computed from it become fiction.
    const asked = new Set<string>(DYNAMIC_KEYS)
    for (const f of files) for (const k of callsIn(readFileSync(f, 'utf8'))) asked.add(k)
    const orphans = knownKeys().filter((k) => !asked.has(k))
    expect(orphans).toEqual([])
  })

  it('translates every label the nav bars render through a variable', () => {
    // DYNAMIC_KEYS is exempted from the orphan check above, so it needs its own gate — otherwise the
    // exemption becomes a place where a key can be listed and never translated. Read from nav.ts
    // rather than restated, so adding a nav item without translating it fails here.
    const nav = readFileSync(new URL('./nav.ts', import.meta.url), 'utf8')
    const labels = [...nav.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1])
    expect(labels.length, 'no nav labels found — the matcher stopped working').toBeGreaterThan(5)
    const known = new Set(knownKeys())
    expect(labels.filter((l) => !known.has(l))).toEqual([])
  })

  it('never passes a template literal to t()', () => {
    // A template literal cannot be looked up in a static table, and it defeats the guard above: the
    // call would translate nothing and this file could not tell. Interpolation goes through named
    // {vars} instead.
    const offenders = files.filter((f) => T_TEMPLATE.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([])
  })
})

describe('translate', () => {
  it('falls back to the key, which is the English copy', () => {
    // The property that makes a partial translation shippable. A dotted-key scheme would render
    // `nav.console.open` here — a visible defect where the fallback should be invisible.
    expect(translate('en', 'Open the console')).toBe('Open the console')
    expect(translate('zh', 'a string nobody has translated')).toBe('a string nobody has translated')
  })

  it('returns the translation when there is one', () => {
    expect(translate('zh', 'Open the console')).toBe('打开控制台')
  })

  it('interpolates named vars', () => {
    expect(translate('en', '{n} of {total}', { n: 3, total: 9 })).toBe('3 of 9')
  })

  it('leaves an unfilled placeholder alone rather than printing undefined', () => {
    expect(translate('en', '{n} of {total}', { n: 1 })).toBe('1 of {total}')
  })

  it('never throws for an unknown locale', () => {
    // Reached if a URL is hand-edited to a locale that was removed. Copy in the wrong language is
    // recoverable; a thrown error in a render is a blank page.
    expect(translate('de' as never, 'Open the console')).toBe('Open the console')
  })
})

describe('coverage', () => {
  it('translates a meaningful share of the UI into Chinese', () => {
    // A floor, not a target. Without it, a catalogue emptied by a bad merge still satisfies every
    // other test in this file — orphans none, missing none, and a completely English Chinese page.
    expect(coverage('zh')).toBeGreaterThan(60)
  })

  it('leaves English with no table, by design', () => {
    // English keys ARE the English copy, so a table would be a list of strings mapped to
    // themselves — one more place to drift out of step for no gain.
    expect(coverage('en')).toBe(0)
    expect(LOCALES).toContain('en')
  })
})
