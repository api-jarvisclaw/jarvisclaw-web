import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { clampPane, DEFAULT_PANE_WIDTHS, normalizePanes, PANE_BOUNDS } from './panes'

describe('clampPane', () => {
  it('holds a pane inside its bounds', () => {
    expect(clampPane('rail', 50)).toBe(PANE_BOUNDS.rail.min)
    expect(clampPane('rail', 9999)).toBe(PANE_BOUNDS.rail.max)
    expect(clampPane('sidebar', 0)).toBe(PANE_BOUNDS.sidebar.min)
    expect(clampPane('sidebar', 9999)).toBe(PANE_BOUNDS.sidebar.max)
  })

  it('rounds to whole pixels', () => {
    // A fractional grid track renders a sub-pixel column, and the border it draws lands on a half
    // pixel — which is a visibly blurry line down the middle of the console.
    expect(clampPane('rail', 260.4)).toBe(260)
    expect(clampPane('rail', 260.6)).toBe(261)
  })

  it('returns the default for a non-number rather than passing it through', () => {
    // NaN fails every comparison, so Math.min/Math.max return it unchanged. It would reach the DOM as
    // `--rail-w: NaNpx`, an invalid value the browser drops — collapsing the track to zero and
    // leaving no handle to drag it back.
    expect(clampPane('rail', NaN)).toBe(DEFAULT_PANE_WIDTHS.rail)
    expect(clampPane('sidebar', Infinity)).toBe(DEFAULT_PANE_WIDTHS.sidebar)
  })
})

describe('normalizePanes', () => {
  it('accepts a stored pair', () => {
    expect(normalizePanes({ rail: 300, sidebar: 400 })).toEqual({ rail: 300, sidebar: 400 })
  })

  it('falls back per field, not wholesale', () => {
    // A half-written entry should keep the half that is usable. Discarding both would lose a width the
    // user did set because of one they did not.
    expect(normalizePanes({ rail: 320 })).toEqual({
      rail: 320,
      sidebar: DEFAULT_PANE_WIDTHS.sidebar,
    })
  })

  it('survives junk', () => {
    for (const junk of [null, undefined, 'nonsense', 42, [], { rail: 'wide' }]) {
      expect(normalizePanes(junk)).toEqual(DEFAULT_PANE_WIDTHS)
    }
  })
})

/**
 * The floors are written twice — here and in the grid template's `clamp()` — and they must agree.
 *
 * They cannot be shared: CSS needs the value at parse time to clamp against the viewport, which is
 * the whole reason the cap lives in the stylesheet. So the duplication is deliberate and this test is
 * what keeps it honest.
 *
 * The failure it catches is not a crash. If CSS floors the rail at 240px while this module allows
 * 200, a drag below 240 reports a width the layout refuses to render: the handle keeps moving, the
 * pane stops, and the last 40px of the drag appear to stick.
 */
describe('the CSS grid agrees with these bounds', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  const shell = css.slice(css.indexOf('.shell {'), css.indexOf('.shell-rail-closed'))

  it('floors each pane at the same minimum', () => {
    expect(shell).toContain(`clamp(${PANE_BOUNDS.rail.min}px, var(--rail-w`)
    expect(shell).toContain(`clamp(${PANE_BOUNDS.sidebar.min}px, var(--sidebar-w`)
  })

  it('defaults each custom property to the same width', () => {
    // The fallback in `var(--rail-w, 260px)` is what renders if App never sets the property — a test
    // rendering the shell alone, or a future caller that forgets. It should not be a different
    // console from the one everyone else sees.
    expect(shell).toContain(`var(--rail-w, ${DEFAULT_PANE_WIDTHS.rail}px)`)
    expect(shell).toContain(`var(--sidebar-w, ${DEFAULT_PANE_WIDTHS.sidebar}px)`)
  })

  it('caps both panes against the viewport, not only against the stored value', () => {
    // A window resize is not observed by React, so this cap can only be a CSS one. Without it a pane
    // dragged wide on a large monitor keeps that pixel width on a laptop and squeezes the transcript
    // toward zero.
    //
    // Matched as "a vw unit is the third argument", not with `clamp\([^)]*vw\)` — the middle argument
    // is `var(--rail-w, 260px)`, whose own closing paren ends a `[^)]*` run early. That pattern
    // reported zero caps against a stylesheet containing both.
    const caps = shell.match(/clamp\([^;]*?\d+vw\)/g) ?? []
    expect(caps.length).toBe(2)
  })
})
