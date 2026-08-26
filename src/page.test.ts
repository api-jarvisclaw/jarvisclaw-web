import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The landing page's layout rules, pinned as source text.
 *
 * One bug is behind all of these, and it happened four times in one stylesheet: a section's children are
 * centred with `margin-left/right: auto`, and a rule written afterwards resets `margin: 0 0 6px`. The
 * shorthand writes all four sides, so it silently discards the centring — and the result was six section
 * headings sitting 216px to the left of their own content, plus a closing section that was the widest
 * thing on the page.
 *
 * It is invisible in a stylesheet, invisible in jsdom (which computes no layout), and invisible in a
 * screenshot unless you happen to look for a vertical line. `probe/landing_page_probe.py` measures the
 * rendered result at five widths; this file forbids the construct that causes it, which is the cheaper
 * of the two checks and the one that runs on every commit.
 */

const css = readFileSync(new URL('./page.css', import.meta.url), 'utf8')

/** The declarations inside one rule, by selector. */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} is missing from page.css`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe('the page measure', () => {
  it('declares one measure and one gutter for the whole page', () => {
    // The alternative — a max-width per section — is what produced four different left edges, each from
    // a locally reasonable rule. One variable makes "does this line up" a question with one answer.
    expect(block('.page')).toContain('--page-measure:')
    expect(block('.page')).toContain('--page-gutter:')
  })

  it('sizes every section from that measure rather than its own number', () => {
    for (const sel of ['.page-band > *', '.page-close > *', '.page-nav-inner', '.page-foot-inner']) {
      expect(block(sel), `${sel} should use var(--page-measure)`).toContain('var(--page-measure)')
    }
  })

  it('adds the gutter to the hero measure instead of padding it inwards', () => {
    /**
     * The hero caps its own box AND pads it, unlike the bands, which pad a full-width section and cap the
     * children inside. Capping at 1020 and then padding 28px leaves 964px of content — the gutter counted
     * twice — which put the hero's children 28px right of every band's.
     *
     * `calc(measure + gutter * 2)` is what makes the two constructions agree.
     */
    const hero = block('.page-hero')
    expect(hero).toMatch(/max-width:\s*calc\(var\(--page-measure\)\s*\+\s*var\(--page-gutter\)\s*\*\s*2\)/)
  })

  it('uses no margin shorthand on a centred section child', () => {
    /**
     * The rule that prevents the original bug, checked against every direct child of a centred container.
     *
     * `margin-block` and `margin-bottom` are fine — they leave the inline sides alone. A bare `margin:`
     * is not, whatever its values, because it always writes all four.
     */
    const centred = [
      '.page-band h2',
      '.page-band-lede',
      '.page-close h2',
      '.page-close p',
    ]
    for (const sel of centred) {
      const b = block(sel)
      expect(b, `${sel} uses a margin shorthand, which discards the auto centring above it`).not.toMatch(
        /\n\s*margin:\s/,
      )
    }
  })

  it('lets wide content scroll inside its own container', () => {
    // Four columns of prose do not fit a phone. A table allowed to widen the page gives the whole document
    // a horizontal scrollbar — breaking every other section to accommodate this one.
    expect(block('.page-table-wrap')).toContain('overflow-x: auto')
    expect(block('.page-table')).toMatch(/min-width:\s*\d+px/)
  })
})

describe('the wordmark', () => {
  it('is larger than the nav links beside it', () => {
    // At 14.5px it was the same size as the nav, so nothing marked it as the brand rather than a seventh
    // menu item. Compared against the nav's own size so the two cannot drift into agreement.
    const brand = Number(block('.page-brand-name').match(/font-size:\s*([\d.]+)px/)?.[1] ?? 0)
    const nav = Number(block('.page-nav nav a').match(/font-size:\s*([\d.]+)px/)?.[1] ?? 0)
    expect(brand).toBeGreaterThan(0)
    expect(nav).toBeGreaterThan(0)
    expect(brand).toBeGreaterThan(nav)
  })

  it('carries optical letter-spacing', () => {
    // A wordmark set at default tracking reads as body text that happens to be bold.
    expect(block('.page-brand-name')).toMatch(/letter-spacing:\s*-0\.0\d+em/)
  })

  it('is not set in a monospace face', () => {
    // The first thing a visitor reads. In mono it reads as terminal output, which is the whole "AI font"
    // complaint — see fonts.test.ts for the rest of it.
    expect(block('.page-brand-name')).not.toContain('var(--mono)')
    expect(block('.page-brand')).not.toContain('var(--mono)')
  })
})
