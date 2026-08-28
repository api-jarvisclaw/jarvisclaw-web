import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { DEFAULT_LOCALE, type Locale } from '../lib/i18n'
import { translate } from '../lib/strings'

/**
 * The current locale and its lookup, for components.
 *
 * A context rather than a prop threaded through the tree: `t` is needed in leaf components four
 * levels down (a badge, a button label), and passing it by hand would mean touching every
 * intermediate signature — and missing one would leave that subtree in English with no error.
 *
 * The default is English rather than a throw, so a component rendered outside the provider — a
 * test, a lazy chunk mounted before the shell — shows readable copy instead of crashing. A missing
 * provider is a bug worth finding, but not one worth a blank screen in front of a user; the tests
 * assert the provider is present where it matters.
 */
export interface LocaleValue {
  locale: Locale
  t: (key: string, vars?: Record<string, string | number>) => string
}

const LocaleContext = createContext<LocaleValue>({
  locale: DEFAULT_LOCALE,
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
})

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  // Memoised on the locale alone. Without this, every render of the shell hands down a new `t` and
  // re-renders every consumer — including the 119-card library grid.
  const value = useMemo<LocaleValue>(
    () => ({ locale, t: (key, vars) => translate(locale, key, vars) }),
    [locale],
  )
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleValue {
  return useContext(LocaleContext)
}

/** Shorthand for the common case, where only the lookup is wanted. */
export function useT(): LocaleValue['t'] {
  return useContext(LocaleContext).t
}
