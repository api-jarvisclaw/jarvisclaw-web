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

/**
 * Isolates one theme's declarations.
 *
 * There are now two palettes — `:root` for light and `.dark` for dark — and this was the trap.
 * The original reader took the LAST definition of a token, which is correct for a single-theme
 * file and silently wrong for two: every check would have measured the dark values only, and the
 * light theme (the DEFAULT, which is what most visitors see) would have gone untested while the
 * suite stayed green.
 */
function themeBlock(theme: 'light' | 'dark'): string {
  const selector = theme === 'light' ? ':root' : '\\.dark'
  const matches = [...css.matchAll(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'))]
  if (matches.length === 0) throw new Error(`no ${theme} block found in styles.css`)
  // Concatenated because a theme may be declared across more than one block.
  return matches.map((m) => m[1]).join('\n')
}

function token(name: string, theme: 'light' | 'dark' = 'dark'): string {
  const block = themeBlock(theme)
  const matches = [...block.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))]
  if (matches.length === 0) {
    // Falling back to the light block is correct rather than lenient: .dark only redeclares what
    // differs, so a token it omits is genuinely inherited from :root.
    if (theme === 'dark') return token(name, 'light')
    throw new Error(`token ${name} not found in the ${theme} block of styles.css`)
  }
  // Resolved here rather than at each call site, so a token expressed as a mix is measurable
  // exactly like a literal one. Returns the value unchanged when it is not a mix.
  return resolveMix(matches[matches.length - 1][1].trim(), theme)
}

/**
 * Resolves a `color-mix(in oklch, var(--x) N%, white|black)` into a plain oklch colour.
 *
 * Needed because the per-theme status-text tokens are expressed as mixes, and those are exactly
 * the values that have to be measured — the raw status colours are chosen to work as fills, not
 * as text. Interpolating in Oklab is what the browser does for `in oklch`, so mixing lightness
 * and chroma linearly toward L=1 (white) or L=0 (black) matches it closely enough for a
 * threshold check; the numbers below were cross-checked against the browser's own rendering via
 * probe/theme_compare.py.
 */
function resolveMix(value: string, theme: 'light' | 'dark'): string {
  const m = value.match(/color-mix\(in oklch,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*(white|black)\)/i)
  if (!m) return value
  const base = oklchParts(token(m[1], theme))
  const weight = Number(m[2]) / 100
  const towardL = m[3].toLowerCase() === 'white' ? 1 : 0
  return `oklch(${base.L * weight + towardL * (1 - weight)} ${base.C * weight} ${base.H})`
}

function oklchParts(css: string): { L: number; C: number; H: number } {
  const nums = css.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i)
  if (!nums) throw new Error(`not an oklch colour: ${css}`)
  return { L: Number(nums[1]), C: Number(nums[2]), H: Number(nums[3]) }
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
function gradientStops(theme: Theme): string[] {
  const stops = [...token('--gradient-brand', theme).matchAll(/oklch\([^)]*\)/g)].map((m) => m[0])
  expect(stops.length).toBeGreaterThanOrEqual(2)
  return stops
}

type Theme = 'light' | 'dark'

/**
 * Every check runs against BOTH themes.
 *
 * Not thoroughness for its own sake — the light theme is the DEFAULT and was added last, so it is
 * the one with no history of being looked at. A suite that only measured dark would have been
 * green while the palette most visitors see went unchecked.
 */
const THEMES: Theme[] = ['light', 'dark']

describe.each(THEMES)('text on the brand gradient (%s)', (theme) => {
  it('is readable against every stop, not just the flattering one', () => {
    // The bug this pins: a gradient's light end and dark end give very different ratios,
    // and checking the darker one alone passes a label nobody can read at the other.
    const fg = token('--on-brand', theme)
    for (const stop of gradientStops(theme)) {
      expect(contrast(fg, stop)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('the ink on the gradient is flipped per theme', () => {
  it('uses dark ink on dark’s bright fill and light ink on light’s deep fill', () => {
    // The two themes need OPPOSITE ink, and picking one for both is the mistake this catches.
    // Dark's gradient is bright (L .62-.7) so it needs dark ink; light's is deep (L .45-.55) so
    // it needs near-white. Asserting the wrong ink FAILS on each is what pins the flip.
    const darkInkOnLightFill = Math.min(
      ...gradientStops('light').map((s) => contrast(token('--on-brand', 'dark'), s)),
    )
    const lightInkOnDarkFill = Math.min(
      ...gradientStops('dark').map((s) => contrast(token('--on-brand', 'light'), s)),
    )
    expect(darkInkOnLightFill).toBeLessThan(4.5)
    expect(lightInkOnDarkFill).toBeLessThan(4.5)
  })
})

describe.each(THEMES)('text on a filled button (%s)', (theme) => {
  it('reads against the flat --primary fill', () => {
    // This pair now carries every primary button AND the user's own chat bubble. They used to
    // be filled with --gradient-brand and inked with --on-brand, which the tests above cover;
    // moving them to a flat fill would have moved them OUT of every contrast check, so the
    // pair that replaced it is measured here. A restraint pass that quietly drops a
    // readability guarantee is not an improvement.
    expect(
      contrast(token('--primary-foreground', theme), token('--primary', theme)),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('needs opposite ink per theme, like the gradient does', () => {
    // Light's --primary is deep (L .5) and needs near-white ink; dark's is bright (L .68) and
    // needs near-black. Asserting the swapped ink fails is what pins the flip, rather than
    // letting one theme's value satisfy both.
    const other: Theme = theme === 'light' ? 'dark' : 'light'
    expect(
      contrast(token('--primary-foreground', other), token('--primary', theme)),
    ).toBeLessThan(4.5)
  })
})

describe.each(THEMES)('body text (%s)', (theme) => {
  it('reads against the page background', () => {
    expect(
      contrast(token('--foreground', theme), token('--background', theme)),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps muted text above the minimum too', () => {
    // Muted is the token most likely to be nudged "to calm it down", and it carries real
    // content here: the hero paragraph, the sidebar labels, the spend hints.
    expect(
      contrast(token('--muted-foreground', theme), token('--background', theme)),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the money colours legible on the card surface', () => {
    // A charge and a refusal are the two lines a user must never misread. These use the
    // per-theme *-text tokens rather than the raw fill colours, because a status colour picked
    // to work as a swatch is not the same one that reads as text.
    expect(
      contrast(token('--highlight-text', theme), token('--card', theme)),
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrast(token('--success-text', theme), token('--card', theme)),
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrast(token('--destructive-text', theme), token('--card', theme)),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps sidebar text legible on the sidebar surface', () => {
    // The sidebar has its own background token, so a palette that works on --background can
    // still fail here — and the wallet address and balance live in it.
    expect(
      contrast(token('--sidebar-foreground', theme), token('--sidebar', theme)),
    ).toBeGreaterThanOrEqual(4.5)
  })
})
