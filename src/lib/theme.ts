/**
 * Light and dark, behaving the way the main site does.
 *
 * The console has a ThemeProvider with `DEFAULT_THEME = 'light'` and a cookie named
 * `vite-ui-theme`. This page was dark-only, which is why it did not look like the same product
 * even though every dark token was copied verbatim: a visitor to the console sees `html.light`.
 *
 * Same cookie NAME on purpose. It cannot be read across hosts — the console writes it without a
 * `Domain` attribute, so it is scoped to `api.jarvisclaw.ai` and this page gets nothing (checked
 * in a browser: only `.jarvisclaw.ai` analytics cookies are visible cross-host). Matching the
 * name still costs nothing and means one change on the console — adding `Domain=.jarvisclaw.ai`
 * — would make the preference follow the user here with no change to this file.
 *
 * Until then the preference is per-site, and the DEFAULT is what matters: light, the same as the
 * console, so a user arriving from it sees no jarring switch.
 */

export type Theme = 'light' | 'dark'

/** The console's own cookie name, so the two can converge later without a rename. */
const COOKIE = 'vite-ui-theme'
const MAX_AGE = 60 * 60 * 24 * 365

/** Light, matching the console's DEFAULT_THEME. */
export const DEFAULT_THEME: Theme = 'light'

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  for (const part of document.cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

/**
 * The stored preference, or the default.
 *
 * A cookie rather than localStorage, so it matches the console's storage exactly — see above.
 * Anything unrecognised falls back rather than being trusted: a hand-edited value must not
 * produce a class name that matches no stylesheet and leaves the page unstyled.
 */
export function loadTheme(): Theme {
  const stored = readCookie(COOKIE)
  return stored === 'dark' || stored === 'light' ? stored : DEFAULT_THEME
}

export function saveTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  try {
    document.cookie = `${COOKIE}=${theme}; path=/; max-age=${MAX_AGE}; SameSite=Lax`
  } catch {
    // Cookies blocked. The theme still applies for this page load; only persistence is lost.
  }
}

/**
 * Puts the theme on <html>, which is where the CSS expects it.
 *
 * The class goes on the documentElement rather than on a wrapper div because `color-scheme` has
 * to be there to affect scrollbars and form controls — a themed wrapper leaves a light page with
 * dark scrollbars, which is the detail that gives away a half-applied theme.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.classList.toggle('dark', theme === 'dark')
  el.classList.toggle('light', theme === 'light')
}
