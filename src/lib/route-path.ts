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
import { localePath, resolveLocale, splitLocale, type Locale } from './i18n'

export type Page = 'landing' | 'console'

/** Where the URL points: which page, which pane, and which language it asked for. */
export interface Route {
  page: Page
  /** Only meaningful when `page` is 'console'. */
  view: RailView
  /**
   * The locale the URL named, or null when it named none.
   *
   * Null is not "English". It is the signal to redirect to a prefixed path, so that from then on
   * every URL states its language and every link is unambiguous.
   */
  locale: Locale | null
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

/**
 * Reads a path, locale prefix and all.
 *
 * The prefix is stripped BEFORE the route table is consulted, so the table stays a map of four
 * screens rather than four screens times however many locales exist. Adding a locale must not mean
 * adding rows here — that is exactly the kind of table that ends up missing one entry and silently
 * serving the landing page for `/zh/gallery`.
 *
 * `locale: null` means the URL named no language. The caller redirects in that case; see i18n.ts.
 * Returning DEFAULT_LOCALE here instead would make `/chat` and `/en/chat` indistinguishable and the
 * redirect impossible to write.
 */
export function routeFor(pathname: string): Route {
  const { locale, rest } = splitLocale(pathname)
  const view = CONSOLE_ROUTES.get(rest)
  // Anything unknown is the landing page, not a 404. The SPA fallback means a typo already arrives
  // here, and the landing page is the useful answer; a blank screen is not.
  return view ? { page: 'console', view, locale } : { page: 'landing', view: 'chat', locale }
}

/**
 * The canonical path for one console pane, in one locale.
 *
 * The locale is required rather than defaulted. A default would let a caller emit an unprefixed
 * `/chat` href that works — because the SPA fallback serves it and the app redirects — while
 * quietly costing every such link a redirect and a locale reset. Making it explicit means the
 * compiler names each place that has to know the language.
 */
export function pathForView(locale: Locale, view: RailView): string {
  return localePath(locale, viewPath(view))
}

/** The locale-free part, for callers that only need to know which pane a view maps to. */
export function viewPath(view: RailView): string {
  switch (view) {
    case 'marketplace':
      return '/marketplace'
    case 'gallery':
      return '/gallery'
    default:
      return '/chat'
  }
}

export function consolePath(locale: Locale): string {
  return localePath(locale, '/chat')
}

export function landingPath(locale: Locale): string {
  return localePath(locale, '/')
}

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
  if (typeof window === 'undefined') return { page: 'landing', view: 'chat', locale: null }
  return routeFor(window.location.pathname)
}

/**
 * Resolves a bare URL to a prefixed one, once, before the first render.
 *
 * Returns the path to redirect to, or null when the URL already names a locale. Called from
 * main.tsx before mount and applied with replaceState, deliberately:
 *
 *   - `replaceState`, not `pushState` — a redirect must not create a history entry, or Back would
 *     land on the unprefixed URL and redirect again, trapping the reader on the site;
 *   - before the first render, so nothing paints at `/chat` and then re-paints at `/en/chat`;
 *   - a stored preference and the browser's own languages are consulted here and ONLY here. Once
 *     the URL carries a locale it wins over both — see i18n.ts.
 */
export function localeRedirect(pathname: string, languages: readonly string[] = []): string | null {
  const { locale, rest } = splitLocale(pathname)
  if (locale !== null) return null
  return localePath(resolveLocale(languages), rest)
}
