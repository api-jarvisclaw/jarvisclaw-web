import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { NAV, navFor } from './nav'
import { pathForView, routeFor } from './route-path'

/**
 * The navigation, shared by the landing bar and the console bar.
 *
 * A nav is the one place a broken link is unambiguously the site's own fault, and its failures are
 * quiet: an anchor rendered where there is nothing to scroll to does nothing at all, and a view item
 * pointing at a path the router does not know renders the landing page instead.
 */
describe('the shared nav', () => {
  it('drops in-page anchors from the console bar', () => {
    // `#how` on the console scrolls to nothing — that section only exists on the landing page. A dead
    // nav item is worse than a missing one: it looks like the app stopped responding.
    //
    // Still checked at runtime even though `navFor('console')` returns a type that excludes anchors,
    // because that type comes from a predicate (`i is LinkableNavItem`) — an assertion, not a check.
    // A filter written against the wrong field would compile perfectly and hand back anchors labelled
    // as linkable, which is exactly the bug this catches.
    const kinds = navFor('console').map((i) => i.kind as string)
    expect(kinds).not.toContain('anchor')
    expect(navFor('landing').map((i) => i.kind as string)).toContain('anchor')
  })

  it('keeps every view and external item on both bars', () => {
    // The whole reason this list is shared. An item on one bar and not the other reads as a link that
    // breaks on some pages, and nobody adding to one bar has a reason to think of the other.
    const labels = (items: Array<{ label: string; kind: string }>) =>
      items.filter((i) => i.kind !== 'anchor').map((i) => i.label)
    expect(labels(navFor('console'))).toEqual(labels(navFor('landing')))
  })

  it('points every view item at a path the router resolves to that view', () => {
    // The failure this catches: a view item whose path falls through to the landing page, so clicking
    // "Gallery" in the console's bar leaves the console.
    for (const item of NAV) {
      if (item.kind !== 'view') continue
      expect(routeFor(pathForView(item.view))).toEqual({ page: 'console', view: item.view })
    }
  })

  it('gives every external item an absolute https URL', () => {
    // A relative href here would resolve against this app's origin and hit the SPA fallback — so
    // "Docs" would silently render the landing page rather than the docs site.
    for (const item of NAV) {
      if (item.kind !== 'href') continue
      expect(item.href).toMatch(/^https:\/\//)
    }
  })

  it('anchors only at targets the landing page actually has', () => {
    // An anchor to a section that was renamed scrolls nowhere. Checked against the page's own source,
    // because the id lives in the JSX and nothing else would notice the two drifting apart.
    const page = readFileSync(new URL('../ui/LandingPage.tsx', import.meta.url), 'utf8')
    for (const item of NAV) {
      if (item.kind !== 'anchor') continue
      expect(page).toContain(`id="${item.to.slice(1)}"`)
    }
  })

  it('labels each item once', () => {
    // The label is the React key in both bars, so a duplicate is a rendering warning and one of the
    // two items silently not updating.
    const labels = NAV.map((i) => i.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
