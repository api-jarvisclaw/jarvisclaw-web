/**
 * Which page the URL asks for.
 *
 * Two routes, so no router library. `react-router` for a landing page and a console is several
 * kilobytes and a provider tree to express one comparison, and this app has no nested routes, no
 * loaders and no params.
 *
 * What it DOES need, and what state alone cannot give:
 *
 *   - a shareable URL. `ducat.jarvisclaw.ai/chat` has to open the console directly, or every link
 *     anyone sends lands on the marketing page and the recipient has to hunt for the button;
 *   - a working Back button. Someone who clicks into the console and presses Back expects the
 *     landing page, not their browser leaving the site;
 *   - a first paint that does not flash. Reading the path synchronously before React mounts means
 *     the console never renders the landing page for a frame on its way to the right screen.
 *
 * The Worker serves index.html for any unknown path (`not_found_handling: single-page-application`),
 * which is what makes a client-side read of the path sufficient.
 */

export type Page = 'landing' | 'console'

/**
 * Paths that open the console.
 *
 * An allowlist, and `/chat` is the canonical one. Everything else — including a path that does not
 * exist — falls back to the landing page rather than 404ing, because the SPA fallback means any
 * typo already arrives here and showing the landing page is the useful answer.
 */
const CONSOLE_PATHS = new Set(['/chat', '/chat/'])

export function pageFor(pathname: string): Page {
  return CONSOLE_PATHS.has(pathname) ? 'console' : 'landing'
}

export const CONSOLE_PATH = '/chat'
export const LANDING_PATH = '/'

/**
 * Navigates without a reload, and tells the caller what to render.
 *
 * `pushState` rather than `location.href`: a reload would refetch the bundle, discard the model
 * catalogue this app just loaded, and lose an in-flight generation — including a paid one that is
 * still being polled. That last part is not hypothetical for this product; a detached wait lives in
 * memory for up to five minutes.
 */
export function navigate(path: string): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname === path) return
  window.history.pushState(null, '', path)
}

/** The page the URL currently names, safe to call before mount. */
export function currentPage(): Page {
  if (typeof window === 'undefined') return 'landing'
  return pageFor(window.location.pathname)
}
