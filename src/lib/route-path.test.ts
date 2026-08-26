import { describe, expect, it } from 'vitest'

import { CONSOLE_PATH, LANDING_PATH, pathForView, routeFor } from './route-path'

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
    expect(routeFor('/chat')).toEqual({ page: 'console', view: 'chat' })
    expect(routeFor('/marketplace')).toEqual({ page: 'console', view: 'marketplace' })
    expect(routeFor('/gallery')).toEqual({ page: 'console', view: 'gallery' })
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
    expect(routeFor('/en/chat').page).toBe('landing')
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
    for (const view of ['chat', 'marketplace', 'gallery'] as const) {
      expect(routeFor(pathForView(view))).toEqual({ page: 'console', view })
    }
  })

  it('agrees with the exported constants', () => {
    expect(pathForView('chat')).toBe(CONSOLE_PATH)
    expect(routeFor(LANDING_PATH).page).toBe('landing')
  })
})
