import { describe, expect, it } from 'vitest'

import { LOCALES } from './i18n'
import { consolePath, landingPath, pathForView, routeFor } from './route-path'

/**
 * Which screen a URL names.
 *
 * Small enough to look not worth testing, and it decides what a visitor sees on a shared link. The
 * failure that matters is a path resolving to the wrong screen — which looks like the app ignoring
 * the address bar.
 */
describe('routeFor', () => {
  it('sends the root to the landing page', () => {
    expect(routeFor('/').page).toBe('landing')
  })

  it('opens each console pane from its own path', () => {
    // The reason these paths exist: a nav item that cannot be linked to is a button pretending to be
    // a link, and "look at this API" is a sentence people send as a URL.
    //
    // `locale: null` is the whole point of the field: a bare path names no language, which is the
    // signal main.tsx uses to redirect to a prefixed one. If this returned 'en' instead, `/chat`
    // and `/en/chat` would be indistinguishable and no redirect could be written — every link would
    // stay ambiguous about its language forever.
    expect(routeFor('/chat')).toEqual({ page: 'console', view: 'chat', locale: null })
    expect(routeFor('/marketplace')).toEqual({
      page: 'console',
      view: 'marketplace',
      locale: null,
    })
    expect(routeFor('/gallery')).toEqual({ page: 'console', view: 'gallery', locale: null })
  })

  it('keeps a bare path working rather than 404ing it', () => {
    // Old links, and anything typed by hand. `/chat` must still open the console — the redirect to
    // `/en/chat` happens in main.tsx before the first paint, and it can only do that if this
    // resolves the route in the first place.
    for (const p of ['/chat', '/marketplace', '/gallery']) {
      expect(routeFor(p).page, p).toBe('console')
    }
  })

  it('accepts a trailing slash on each', () => {
    // A link typed by hand and one produced by a tool that normalises URLs differ, and landing on
    // marketing copy from `/gallery/` looks broken.
    for (const p of ['/chat/', '/marketplace/', '/gallery/']) {
      expect(routeFor(p).page).toBe('console')
    }
  })

  it('falls back to the landing page for anything unknown', () => {
    // The Worker serves index.html for every unknown path, so a typo already arrives here. Showing the
    // landing page is the useful answer; a blank screen is not.
    expect(routeFor('/nonsense').page).toBe('landing')
    expect(routeFor('/chatt').page).toBe('landing')
    // `/en/chat` used to be listed here as an unknown path, and asserting that was correct before
    // locales existed. It is now the canonical form of the console — recorded rather than quietly
    // edited, because a test that flips meaning is worth noticing.
    expect(routeFor('/en/chat').page).toBe('console')
    // An unknown language is NOT a locale prefix. `/de/chat` has no German copy, so it must fall
    // through to the landing page rather than render English under a German URL and imply a
    // translation that does not exist.
    expect(routeFor('/de/chat').page).toBe('landing')
    expect(routeFor('/de/chat').locale).toBeNull()
  })

  it('does not match a console route by prefix', () => {
    // `/chat-export` must not open the console, and `/gallery-old` must not either. An allowlist
    // rather than a startsWith is what stops a future real route being swallowed — silently, because
    // the new route would render the console and look like it was never added.
    for (const p of ['/chat-export', '/chatroom', '/gallery-old', '/marketplaces']) {
      expect(routeFor(p).page).toBe('landing')
    }
  })

  it('names a view for the landing page too, so callers need no null check', () => {
    // 'chat' is the seed App would use anyway. Returning undefined here would push a branch into every
    // consumer for a value none of them can act on.
    expect(routeFor('/').view).toBe('chat')
  })
})

describe('pathForView', () => {
  it('round-trips through routeFor', () => {
    // The property that matters: navigating to pathForView(v) has to land somewhere routeFor agrees is
    // view v. Hardcoding '/gallery' at a call site would silently break the moment this file changed.
    // Across every locale, not just the default. The prefix is stripped before the route table is
    // consulted, and the failure if it were not would be silent: /zh/gallery would render the
    // landing page and look like the link was wrong rather than the routing.
    for (const locale of LOCALES) {
      for (const view of ['chat', 'marketplace', 'gallery'] as const) {
        expect(routeFor(pathForView(locale, view))).toEqual({ page: 'console', view, locale })
      }
    }
  })

  it('agrees with the locale-aware helpers', () => {
    for (const locale of LOCALES) {
      expect(pathForView(locale, 'chat')).toBe(consolePath(locale))
      expect(routeFor(landingPath(locale)).page).toBe('landing')
      expect(routeFor(landingPath(locale)).locale).toBe(locale)
    }
  })
})
