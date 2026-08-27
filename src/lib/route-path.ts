/**
 * Which screen the URL asks for.
 *
 * Four paths, so still no router library. `react-router` for this would be several kilobytes and a
 * provider tree to express one lookup, and there are no params, no nested routes and no loaders.
 *
 * What it DOES need, and what state alone cannot give:
 *
 *   - shareable URLs. `/chat` has to open the console directly, or every link anyone sends lands on
 *     the marketing page and the recipient has to hunt for the button. `/marketplace` and `/gallery`
 *     were added for the same reason the nav lists them: a nav item that cannot be linked to is a
 *     button pretending to be a link, and "look at this API" is a sentence people send;
 *   - a working Back button. Someone who clicks into the console and presses Back expects the
 *     landing page, not their browser leaving the site;
 *   - a first paint that does not flash. Reading the path synchronously before React mounts means
 *     the console never renders one screen for a frame on its way to another.
 *
 * The Worker serves index.html for any unknown path (`not_found_handling: single-page-application`),
 * which is what makes a client-side read of the path sufficient — and also why an unknown path has
 * to resolve to something useful here rather than 404ing.
 */

import type { RailView } from '../ui/ChatList'

export type Page = 'landing' | 'console'

/** Where the URL points: which page, and for the console, which pane. */
export interface Route {
  page: Page
  /** Only meaningful when `page` is 'console'. */
  view: RailView
}

/**
 * Paths that open the console, and the pane each one opens.
 *
 * An allowlist rather than a prefix test. `startsWith('/chat')` would swallow a future `/chat-export`
 * route, and the failure is silent: the new route renders the console and looks like it was never
 * added. Both slash forms are listed because a link typed by hand and one produced by a tool that
 * normalises URLs differ, and landing on marketing copy from `/chat/` looks broken.
 */
const CONSOLE_ROUTES = new Map<string, RailView>([
  ['/chat', 'chat'],
  ['/chat/', 'chat'],
  ['/marketplace', 'marketplace'],
  ['/marketplace/', 'marketplace'],
  ['/gallery', 'gallery'],
  ['/gallery/', 'gallery'],
])

export function routeFor(pathname: string): Route {
  const view = CONSOLE_ROUTES.get(pathname)
  // Anything unknown is the landing page, not a 404. The SPA fallback means a typo already arrives
  // here, and the landing page is the useful answer; a blank screen is not.
  return view ? { page: 'console', view } : { page: 'landing', view: 'chat' }
}

/** The canonical path for one console pane, so no caller has to hardcode a string. */
export function pathForView(view: RailView): string {
  switch (view) {
    case 'marketplace':
      return '/marketplace'
    case 'gallery':
      return '/gallery'
    default:
      return '/chat'
  }
}

export const CONSOLE_PATH = '/chat'
export const LANDING_PATH = '/'

/**
 * Points the address bar at a path without reloading.
 *
 * `pushState` rather than `location.href`: a reload would refetch the bundle, discard the model
 * catalogue this app just loaded, and lose an in-flight generation — including a paid one still
 * being polled. That last part is not hypothetical for this product; a detached wait lives in memory
 * for up to five minutes, and losing it loses the only record of a charge.
 */
export function navigate(path: string): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname === path) return
  window.history.pushState(null, '', path)
}

/**
 * Rewrites the current entry instead of adding one.
 *
 * Used when the user switches pane INSIDE the console, where pushState would be wrong: clicking
 * Marketplace, Gallery and back to chat would bury the landing page four entries deep, so Back —
 * which on every other site leaves a section — would walk through the panes one at a time instead.
 * Replacing keeps the URL honest about what is on screen while leaving Back meaning "the page I came
 * from".
 */
export function replacePath(path: string): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname === path) return
  window.history.replaceState(null, '', path)
}

/** The route the URL currently names, safe to call before mount. */
export function currentRoute(): Route {
  if (typeof window === 'undefined') return { page: 'landing', view: 'chat' }
  return routeFor(window.location.pathname)
}
