/**
 * How wide the two side panes are, remembered across sessions.
 *
 * They were `260px` and `320px`, written into the grid. Reasonable numbers, and wrong for anyone
 * whose window is not the one they were chosen on: at 2560px the conversation list wastes ten
 * percent of the screen on truncated titles, and at 1280px the wallet panel's own text wraps every
 * three words. Neither is fixable from the outside, which is what makes a fixed pane a defect
 * rather than a default.
 *
 * ## What lives here and what lives in CSS
 *
 * This module owns the number the user chose and the bounds it must fall inside. CSS owns the
 * number actually rendered, because it has to react to a window resize that no React state hears:
 * see the `clamp(min, var, vw)` on `.shell`. The split matters in one visible way — a stored width
 * that a narrow window cannot honour is NOT overwritten. Someone who sets a wide rail, shrinks the
 * window, then widens it again gets their rail back, because the viewport never wrote to storage.
 *
 * The floors in {@link PANE_BOUNDS} are duplicated in the stylesheet and a test asserts the two
 * agree. That duplication is deliberate but it must not drift: if CSS floors the rail at 200px and
 * this file allows 120, the handle reports a width the layout refuses to render and the drag
 * appears to stick for the last 80px.
 */

const KEY = 'jarvisclaw.panes.v1'

export interface PaneWidths {
  /** The left rail: navigation and the conversation list. */
  rail: number
  /** The right sidebar: spend, account, wallet, limits. */
  sidebar: number
}

export type Pane = keyof PaneWidths

export const DEFAULT_PANE_WIDTHS: PaneWidths = { rail: 260, sidebar: 320 }

/**
 * The range each pane may be dragged to.
 *
 * The floors are the width at which the pane's own content stops working, measured rather than
 * guessed: below 200px a conversation title truncates to about two words, and below 260px the
 * wallet panel's sentences wrap mid-phrase. A pane narrower than its content is not a smaller pane,
 * it is a broken one — and someone who drags it there has no way to know why it looks wrong.
 *
 * The ceilings exist so a drag cannot squeeze the transcript out of usable width on its own. They
 * are not the only guard: the stylesheet also caps each pane against the viewport, which is what
 * handles a window too narrow for even these numbers.
 */
export const PANE_BOUNDS: Record<Pane, { min: number; max: number }> = {
  rail: { min: 200, max: 460 },
  sidebar: { min: 260, max: 560 },
}

/** Rounds and bounds one pane width. */
export function clampPane(pane: Pane, px: number): number {
  const { min, max } = PANE_BOUNDS[pane]
  // NaN fails every comparison, so Math.min/max would pass it straight through and the grid would
  // receive `NaNpx` — an invalid value the browser drops, collapsing the track to zero.
  if (!Number.isFinite(px)) return DEFAULT_PANE_WIDTHS[pane]
  return Math.round(Math.min(max, Math.max(min, px)))
}

/**
 * Coerces anything into usable widths.
 *
 * Applied to stored values and to live drags alike, so a hand-edited localStorage entry takes the
 * same path as the pointer. Junk returns the defaults rather than throwing: a corrupt preference
 * must not be able to stop the console rendering.
 */
export function normalizePanes(raw: unknown): PaneWidths {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PaneWidths>
  return {
    rail: clampPane('rail', typeof r.rail === 'number' ? r.rail : NaN),
    sidebar: clampPane('sidebar', typeof r.sidebar === 'number' ? r.sidebar : NaN),
  }
}

export function loadPanes(): PaneWidths {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return { ...DEFAULT_PANE_WIDTHS }
    return normalizePanes(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_PANE_WIDTHS }
  }
}

export function savePanes(w: PaneWidths): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizePanes(w)))
  } catch {
    // A full or blocked store must not interrupt a drag. The width still applies to this tab.
  }
}
