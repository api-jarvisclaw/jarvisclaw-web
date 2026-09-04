import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The landing page's type and chrome, pinned to the main site's measured values.
 *
 * Asked for: "ducat的首页要跟主站的风格一致". The instinct is to compare design tokens, and
 * that instinct has now been wrong three times in this project — twice by comparing a file
 * against a copy of itself (so the answer was always "identical"), and once by diffing colour
 * STRINGS across two apps that write colours in different spaces, which reports a difference
 * on values that paint the same pixel.
 *
 * So the reference numbers below were measured from the two RENDERED homepages at 1440px, in
 * a real browser, with every colour pushed through a 1x1 canvas so both sites' notations
 * resolved to the same sRGB bytes:
 *
 *                      main site            ducat (before)
 *   bodyBg             rgb(245,249,252)     rgb(245,249,252)   <- already identical
 *   body colour        rgb(26,31,45)        rgb(26,31,45)      <- already identical
 *   primary fill       rgb(0,92,204)        rgb(0,92,204)      <- already identical
 *   h1 size            37.44px              56px
 *   h1 line-height     40.44px              60.48px
 *   h1 tracking        -0.936px             -1.96px
 *   base size          16px                 15px
 *   CTA radius         10px                 999px (a pill)
 *   CTA font-size      14px                 13px
 *   nav height         64px                 63px
 *   nav bg at rest     rgba(0,0,0,0)        rgba(245,249,252,0.82)
 *   nav blur           none at rest         blur(10px) always
 *
 * The palette was never the problem. Type scale and button shape were, and a full pill
 * against a 10px rounded rectangle repeats on every button on the page.
 *
 * These read the stylesheet as text, on purpose: what matters is what the CSS ASKS FOR, and
 * jsdom resolves clamp(), color-mix() and var() to nothing useful — a render test here would
 * pass on either version. The rendered numbers were verified separately against a local build
 * of dist and matched the main site exactly (37.44px / 40.4352px / -0.936px, 10px, 14px, 64px).
 */
const page = readFileSync(new URL('./page.css', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

/**
 * The declarations of one rule, with comments stripped.
 *
 * Stripping is not tidiness. The first version of the tracking assertion below failed on
 * CORRECT css, because the comment explaining the change names the old value (`-0.035em`) and
 * a `not.toContain` cannot tell an explanation from a declaration. A guard whose own prose can
 * fail it is a guard that will be deleted rather than trusted, and this project has hit that
 * shape before.
 */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} is missing — the assertion below would be vacuous`)
    .toBeGreaterThan(-1)
  const body = css.slice(at, css.indexOf('}', at))
  return body.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('the headline is on the main site’s scale', () => {
  const h1 = block(page, '.page-hero h1')

  it('uses the main site’s own clamp, not a larger one of its own', () => {
    // The main site sizes its h1 with clamp(2.25rem, 2.6vw, 3rem) — 36px to 48px. The
    // previous clamp(34px, 5.2vw, 56px) topped out half again as large.
    expect(h1).toContain('clamp(2.25rem, 2.6vw, 3rem)')
  })

  it('does not keep the 56px ceiling', () => {
    expect(h1).not.toContain('56px')
  })

  it('tracks at the main site’s ratio, not twice as tight', () => {
    // -0.025em resolves to -0.936px at 37.44px, which is what the main site renders.
    // -0.035em resolved to -1.96px.
    expect(h1).toContain('letter-spacing: -0.025em')
    expect(h1).not.toContain('-0.035em')
  })
})

describe('the buttons are the main site’s shape', () => {
  it('derives its radius from the shared token rather than a pill', () => {
    // Anchored on `.page-cta {` — the shared rule is a two-selector list whose newline is
    // CRLF in this checkout, so matching the pair as written in the file is brittle. The
    // block that follows `.page-cta {` is the same declaration body either way.
    const cta = block(page, '.page-cta')
    // --radius is 0.625rem = 10px, the value the main site renders. Deriving from the token
    // rather than writing 10px means the two cannot drift apart silently.
    expect(cta).toContain('border-radius: var(--radius)')
    expect(cta).not.toContain('border-radius: 999px')
  })

  it('leaves no pill radius anywhere on the page’s buttons', () => {
    // The rule above covers the shared block. This catches a 999px reintroduced in either
    // of the two size variants, which would put the shapes back out of step with each other
    // as well as with the main site.
    for (const sel of ['.page-cta-sm', '.page-cta']) {
      expect(block(page, sel)).not.toContain('999px')
    }
  })

  it('keeps --radius at the main site’s 10px', () => {
    // The assertion above is only worth anything if the token still resolves to 10px. A
    // future change to --radius would silently move every button off the reference.
    expect(styles).toContain('--radius: 0.625rem')
  })

  it('sets the bar’s CTA to the main site’s 14px', () => {
    expect(block(page, '.page-cta-sm')).toContain('font-size: 14px')
  })
})

describe('the page reads at the main site’s size', () => {
  it('sets 16px on the landing page', () => {
    expect(block(page, '.page')).toContain('font-size: 16px')
  })

  it('leaves the console at 15px', () => {
    // The control. "Match the main site" must not be satisfied by resizing the console
    // too: a chat transcript, a model picker and a ledger are a dense working surface, and
    // 15px is right there. Only the marketing page moves.
    expect(block(styles, 'body')).toContain('font-size: 15px')
  })
})

describe('the nav is clear at rest, like the main site’s', () => {
  it('paints no background on the bar itself', () => {
    const nav = block(page, '.page-nav')
    expect(nav).toContain('background: transparent')
    // The old always-on backdrop, which produced a horizontal band the main site does not
    // have.
    expect(nav).not.toContain('backdrop-filter')
  })

  it('moves the backdrop to a pseudo-element so its opacity can be animated', () => {
    // backdrop-filter does not interpolate from blur(0) reliably — keyframing it left the
    // bar opaque at the top. Opacity on ::before does interpolate.
    const before = block(page, '.page-nav::before')
    expect(before).toContain('backdrop-filter: blur(40px)')
    expect(before).toContain('z-index: -1')
  })

  it('drives that opacity from the ROOT scroller', () => {
    // Measured: on this route the document scrolls (window.scrollY reached 700) while
    // `.page` stayed at scrollTop 0, despite declaring overflow-y: auto. scroll(nearest)
    // therefore bound to something that never moves and the animation sat frozen at its
    // start — the bar stayed opaque and the whole effect was inert while looking correct
    // in the stylesheet.
    expect(page).toContain('animation-timeline: scroll(root block)')
    expect(page).not.toContain('animation-timeline: scroll(nearest)')
  })

  it('falls back to a permanent backdrop where scroll timelines are unsupported', () => {
    // The ::before carries the backdrop unconditionally and only the @supports block
    // animates it, so no support means opacity stays 1 — legible everywhere, merely less
    // airy at the top. A nav over moving text may only degrade toward legible.
    const at = page.indexOf('@supports (animation-timeline: scroll())')
    expect(at).toBeGreaterThan(-1)
    expect(page.indexOf('.page-nav::before {')).toBeLessThan(at)
  })

  it('is the main site’s 64px tall', () => {
    expect(block(page, '.page-nav-inner')).toContain('min-height: 64px')
  })
})
