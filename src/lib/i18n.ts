/**
 * Locale handling: `en` and `zh`, English by default, chosen by URL path.
 *
 * ## Why no i18n library
 *
 * 219 strings and two locales. `i18next` plus `react-i18next` is a provider tree, a plugin chain
 * and a runtime to express one lookup in a frozen object — and it would not do the load-bearing
 * part of this anyway, which is the URL. The path prefix has to agree with a hand-written route
 * table, the Worker's SPA fallback, and every `<a href>` in the app; that work exists either way.
 *
 * If a third locale with plurals and dates arrives, revisit. Two locales of UI copy do not need a
 * plural engine, and pretending otherwise now costs a dependency for nothing.
 *
 * ## The URL is the source of truth, not a preference
 *
 * `/en/chat` and `/zh/chat`, decided by the user's own request. That has consequences the app must
 * honour rather than work around:
 *
 *   - a link is shareable in the language it was read in. Someone sending `/zh/marketplace` to a
 *     colleague sends the Chinese page, not "whatever your browser guesses";
 *   - the locale survives a reload with no storage, because it is in the address bar;
 *   - a stored preference must never override an explicit path. If someone opens `/en/chat`, they
 *     get English, even if they picked Chinese last week — the URL is the more specific request.
 *
 * A bare path (`/chat`, `/`) carries no locale. Those are resolved once, from the browser, and
 * redirected to a prefixed path so that from then on the URL always says which language is on
 * screen. Without that redirect the app has two kinds of URL forever and every link is ambiguous.
 *
 * ## English is the fallback, deliberately
 *
 * The x402 and agent audience reads English, and a missing Chinese string must render as English
 * rather than as a key. `t()` therefore falls back rather than throwing: a half-translated screen
 * is usable and an exception is not.
 */

export const LOCALES = ['en', 'zh'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

/** What each locale is called in its OWN language, for the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
}

const KEY = 'jarvisclaw.locale.v1'

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
}

/**
 * Splits a pathname into its locale prefix and the rest.
 *
 * Returns `locale: null` for a bare path so the caller can tell "no locale was asked for" from
 * "English was asked for" — the first needs a redirect, the second does not. Collapsing them is
 * how `/chat` would keep working forever as an unprefixed URL and the whole scheme would rot.
 */
export function splitLocale(pathname: string): { locale: Locale | null; rest: string } {
  const m = /^\/([a-zA-Z-]+)(\/.*|)$/.exec(pathname)
  if (m && isLocale(m[1].toLowerCase())) {
    const rest = m[2] === '' ? '/' : m[2]
    return { locale: m[1].toLowerCase() as Locale, rest }
  }
  return { locale: null, rest: pathname === '' ? '/' : pathname }
}

/** Builds a path in one locale. `localePath('zh', '/chat')` -> `/zh/chat`. */
export function localePath(locale: Locale, rest: string): string {
  const clean = rest.startsWith('/') ? rest : `/${rest}`
  // The root is `/en`, not `/en/` — one canonical form, so `navigate()`'s "already here" check and
  // the route table cannot disagree about whether a trailing slash counts.
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`
}

/** The same URL in another locale, keeping the page the reader is on. */
export function switchLocalePath(pathname: string, to: Locale): string {
  return localePath(to, splitLocale(pathname).rest)
}

/**
 * Which locale the browser is asking for.
 *
 * `zh` matches zh, zh-CN, zh-TW, zh-Hans — a reader of any of them is better served by Chinese
 * than by English. Region-specific copy is not something this app has, so treating them
 * separately would only produce a mismatch nobody can act on.
 */
export function detectLocale(languages: readonly string[] = []): Locale {
  for (const raw of languages) {
    const tag = raw.toLowerCase()
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return DEFAULT_LOCALE
}

/** The remembered choice, if the reader has made one. */
export function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(KEY)
    return isLocale(v) ? v : null
  } catch {
    // A private window or blocked site data. Detection still works; only the memory is lost.
    return null
  }
}

export function rememberLocale(locale: Locale): void {
  try {
    localStorage.setItem(KEY, locale)
  } catch {
    // Same as above: not remembering is a small loss, and throwing here would break a click.
  }
}

/**
 * The locale for a bare path, in priority order: what they chose, then what their browser asks.
 *
 * Only ever consulted when the URL says nothing. A prefixed path outranks both — see the header:
 * an explicit `/en/chat` must not be redirected to Chinese by a week-old preference.
 */
export function resolveLocale(languages: readonly string[] = []): Locale {
  return storedLocale() ?? detectLocale(languages)
}
