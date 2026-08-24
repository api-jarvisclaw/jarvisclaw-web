import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * Text-on-fill contrast, pinned.
 *
 * This exists because I shipped white text on the brand gradient and it measured 2.7:1 —
 * under the 4.5:1 minimum, on Send, Approve, and every user bubble, i.e. the three things
 * a visitor reads most. Nothing caught it: the build is clean, the tokens matched the
 * console exactly, and it looks confident in a screenshot. A gradient is the easy way to
 * miss this, because the readable end reassures you about the end that is not.
 *
 * The check is deliberately arithmetic rather than a browser measurement. Playwright can
 * measure the real pixels (probe/ does that), but it needs a built bundle and a server,
 * so it cannot fail a unit-test run — and this is the kind of regression that arrives with
 * an innocent palette tweak.
 */

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function token(name: string): string {
  // Last definition wins, matching the cascade for repeated custom properties.
  const matches = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))]
  if (matches.length === 0) throw new Error(`token ${name} not found in styles.css`)
  return matches[matches.length - 1][1].trim()
}

/** oklch(L C H) -> sRGB 0..255, via Oklab and linear sRGB. */
function oklchToSrgb(css: string): [number, number, number] {
  const nums = css.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i)
  if (!nums) throw new Error(`not an oklch colour: ${css}`)
  const L = Number(nums[1])
  const C = Number(nums[2])
  const hDeg = Number(nums[3])

  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]

  return lin.map((v) => {
    const enc = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, enc)) * 255)
  }) as [number, number, number]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(fg: string, bg: string): number {
  const a = relativeLuminance(oklchToSrgb(fg)) + 0.05
  const b = relativeLuminance(oklchToSrgb(bg)) + 0.05
  return Math.max(a, b) / Math.min(a, b)
}

/** Both stops of --gradient-brand. Text has to survive the worse one. */
function gradientStops(): string[] {
  const stops = [...token('--gradient-brand').matchAll(/oklch\([^)]*\)/g)].map((m) => m[0])
  expect(stops.length).toBeGreaterThanOrEqual(2)
  return stops
}

describe('text on the brand gradient', () => {
  it('is readable against every stop, not just the flattering one', () => {
    // The bug this pins: a gradient's light end and dark end give very different ratios,
    // and checking the darker one alone passes a label nobody can read at the other.
    const fg = token('--on-brand')
    for (const stop of gradientStops()) {
      expect(contrast(fg, stop)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('would reject white, which is what shipped and failed', () => {
    // Guards the fix rather than the symptom: white looks like the obvious choice on a
    // saturated fill, so the next person to reach for it should see this fail. Asserting
    // that at least one stop refuses white is the real claim — the gradient's light end
    // is exactly where white gives out.
    const worst = Math.min(...gradientStops().map((s) => contrast('oklch(1 0 0)', s)))
    expect(worst).toBeLessThan(4.5)
  })
})

describe('body text', () => {
  it('reads against the page background', () => {
    expect(contrast(token('--foreground'), token('--background'))).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps muted text above the minimum too', () => {
    // Muted is the token most likely to be nudged darker "to calm it down", and it carries
    // real content here: the hero paragraph, the sidebar labels, the spend hints.
    expect(
      contrast(token('--muted-foreground'), token('--background')),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the money colours legible on the card surface', () => {
    // A charge and a refusal are the two lines a user must never misread.
    expect(contrast(token('--highlight'), token('--card'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('--success'), token('--card'))).toBeGreaterThanOrEqual(4.5)
  })
})
