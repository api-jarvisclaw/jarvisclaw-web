import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The landing page's colour, and the contrast floor it may not cross.
 *
 * Asked for: "配色可以大胆点 炫彩一点". Measured before changing anything, because "more
 * colourful" without a denominator is a matter of taste and this one had a factual answer.
 * Counting every element's computed fill on both rendered homepages at 1440px:
 *
 *                    main site   ducat (before)   ducat (after)
 *   distinct fills   28          7                7
 *   gradients        9           0                7
 *   gradient text    0           0                5 elements
 *
 * The finding: ducat already DECLARED the main site's whole chromatic vocabulary —
 * --accent-2, --accent-3, --glow-brand and --mesh-* are byte-identical to its light theme —
 * and the landing page used none of it. --gradient-wordmark was declared, documented with a
 * contrast figure, and referenced NOWHERE in the repo. So the change spends colour that was
 * already paid for rather than inventing a palette.
 *
 * Two things this deliberately does NOT do, both recorded in page.css for the same reason:
 * cards stay flat (a page of tinted panels is what "too AI" meant here, and the gradient card
 * variants had produced a pink tint), and every mix into a near-neutral goes through oklab
 * rather than oklch, because a neutral has no defined hue and oklch interpolation invents one.
 *
 * Read as source text: what matters is what the CSS asks for. jsdom resolves color-mix(),
 * oklch() and var() to nothing useful, so a render test here would pass on either version. The
 * contrast numbers quoted below were measured separately in a real browser against a local
 * build of dist, in BOTH themes, by painting each colour through a 1x1 canvas and computing the
 * WCAG ratio — the light-only pass reported "no failures" while the dark theme had two.
 */
const page = readFileSync(new URL('./page.css', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} is missing — the assertion below would be vacuous`)
    .toBeGreaterThan(-1)
  // Comments stripped: a not.toContain cannot tell an explanation from a declaration, and the
  // comments here name the old values on purpose.
  return css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Where the `.dark` RULE begins.
 *
 * Not `indexOf('.dark')`: the file's own header comment discusses `.dark` in prose at line 5, so
 * a bare search returned that instead and the "light half" slice came back empty — two
 * assertions failed against correct css. Anchored on the rule's opening brace.
 */
function darkBlockStart(): number {
  // Matched with a regex anchored at line start, so CRLF vs LF in the checkout cannot decide
  // whether this guard works.
  const at = styles.search(/^\.dark \{/m)
  expect(at, 'the .dark rule is missing').toBeGreaterThan(-1)
  return at
}

describe('the page actually spends its palette', () => {
  it('paints a hero mesh in the brand’s three hues', () => {
    const mesh = block(page, '.page-hero::before')
    // Blue, violet, cyan — the same three the main site layers behind its own hero.
    expect(mesh).toContain('258')
    expect(mesh).toContain('300')
    expect(mesh).toContain('210')
    expect((mesh.match(/radial-gradient/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the mesh behind the content and out of the way of clicks', () => {
    // The prompt box sits in the middle of this. A decorative layer that eats a click on the
    // page's one interactive element would be a functional regression dressed as styling.
    const mesh = block(page, '.page-hero::before')
    expect(mesh).toContain('z-index: -1')
    expect(mesh).toContain('pointer-events: none')
  })

  it('finally uses --gradient-wordmark, which nothing referenced before', () => {
    expect(page).toContain('var(--gradient-wordmark)')
  })

  it('fills the CTA with the brand gradient over a solid fallback', () => {
    const cta = block(page, '.page-cta')
    expect(cta).toContain('background-image: var(--gradient-brand)')
    // Underneath, so a browser that drops the gradient shows a brand button rather than a
    // transparent one.
    expect(cta).toContain('background-color: var(--primary)')
  })

  it('uses --on-brand for ink on that gradient, not --primary-foreground', () => {
    // --on-brand exists because this fill flips lightness between themes. Using
    // --primary-foreground would put white ink on the dark theme's BRIGHT gradient.
    const cta = block(page, '.page-cta')
    expect(cta).toContain('color: var(--on-brand)')
  })
})

describe('gradient text can never render invisible', () => {
  /**
   * background-clip: text fails in exactly one direction: without support, `color: transparent`
   * leaves nothing on screen. So the solid colour is declared FIRST and only overridden inside
   * @supports. A headline or a set of figures that can vanish is worse than one without a
   * gradient.
   */
  for (const sel of ['.page-hero h1 em', '.page-figures dt']) {
    it(`${sel} declares a solid colour before the @supports override`, () => {
      const solidAt = page.indexOf(`${sel} {`)
      const supportsAt = page.indexOf('@supports (background-clip: text)', solidAt)
      expect(solidAt, `${sel} is missing`).toBeGreaterThan(-1)
      expect(supportsAt, `${sel} has no @supports guard`).toBeGreaterThan(solidAt)
      const solid = block(page, sel)
      expect(solid).toMatch(/color: var\(--(accent-2-text|foreground)\)/)
      // The bare rule must NOT be the transparent one.
      expect(solid).not.toContain('color: transparent')
    })
  }
})

describe('the contrast floor', () => {
  it('drops the cyan wordmark stop to the measured 4.5:1 threshold', () => {
    // L 0.55 measured 4.12:1 against this theme's background — a fail for normal text, on the
    // stop the headline's first characters land on. 0.52 measured 4.63:1 and is the lightest
    // stop that clears the floor.
    expect(styles).toContain('oklch(0.52 0.13 208)')
    expect(styles).not.toContain('oklch(0.55 0.13 208)')
  })

  it('fixes --accent-2-text, which had never been measured', () => {
    // 88% toward black measured 4.34:1. The value came from the dark theme's mirror rule, where
    // mixing toward WHITE at 88% moves away from the background rather than toward it.
    const light = styles.slice(0, darkBlockStart())
    expect(light).toContain('--accent-2-text: color-mix(in oklch, var(--accent-2) 78%, black)')
    expect(light).not.toContain('var(--accent-2) 88%, black')
  })

  it('derives the step markers from per-theme tokens, not from literals', () => {
    /**
     * The failure this pins. The first version hard-coded oklch stops mixed toward black, which
     * is right on the light page and wrong on the dark one — measured 2.65:1 and 2.29:1 against
     * oklch(0.12), because "mix toward black" moves a colour TOWARD a dark background. Only the
     * dark pass caught it; the light pass reported no failures.
     */
    expect(block(page, '.page-steps > :nth-child(2) .page-step-n'))
      .toContain('color: var(--primary)')
    expect(block(page, '.page-steps > :nth-child(3) .page-step-n'))
      .toContain('color: var(--accent-3-text)')
    // No raw oklch literal may reappear in either rule.
    for (const sel of [
      '.page-steps > :nth-child(2) .page-step-n',
      '.page-steps > :nth-child(3) .page-step-n',
    ]) {
      expect(block(page, sel)).not.toMatch(/oklch\(/)
    }
  })

  it('defines --accent-3-text in BOTH themes', () => {
    // A token defined only on light is the same defect as a literal: correct in one theme,
    // broken in the other, and the dark theme is the one nobody looks at.
    const darkAt = darkBlockStart()
    expect(styles.slice(0, darkAt)).toContain('--accent-3-text:')
    expect(styles.slice(darkAt)).toContain('--accent-3-text:')
    // And in opposite directions, which is the entire point of the pair.
    expect(styles.slice(0, darkAt)).toMatch(/--accent-3-text:[^;]*black/)
    expect(styles.slice(darkAt)).toMatch(/--accent-3-text:[^;]*white/)
  })
})

describe('what the page deliberately does not do', () => {
  it('keeps the cards flat', () => {
    // The control on "be bolder". A page of tinted panels is what "too AI" meant here, and the
    // gradient card variants in styles.css mix a chromatic glow into a neutral — which is what
    // produced a pink tint once already.
    const card = block(page, '.page-card')
    expect(card).toContain('background: var(--card)')
    expect(card).not.toContain('gradient')
  })

  it('mixes into near-neutrals through oklab, never oklch', () => {
    // A neutral has no defined hue, so oklch interpolation invents one — the pink-band bug. The
    // band tint is the mix that touches a neutral, so it is the one that must be oklab.
    const band = block(page, '.page-band-alt')
    expect(band).toContain('in oklab')
    expect(band).not.toContain('in oklch')
  })

  it('keeps the band tint faint enough to read as paper, not as a panel', () => {
    const band = block(page, '.page-band-alt')
    const pct = Number(band.match(/var\(--glow-brand\)\s+(\d+)%/)?.[1] ?? '0')
    expect(pct).toBeGreaterThan(0)
    expect(pct).toBeLessThanOrEqual(10)
  })
})
