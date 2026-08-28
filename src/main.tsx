import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { DEFAULT_LOCALE, rememberLocale, switchLocalePath, type Locale } from './lib/i18n'
import {
  consolePath,
  currentRoute,
  landingPath,
  localeRedirect,
  navigate,
  routeFor,
} from './lib/route-path'
import { LandingPage } from './ui/LandingPage'
import { LocaleProvider } from './ui/LocaleContext'
import './styles.css'
// The landing page's own stylesheet. It shares the design tokens declared in styles.css and
// nothing else, so it is kept separate rather than growing an already long file.
import './page.css'

/**
 * The landing page at `/`, and the console at `/chat`, `/marketplace` and `/gallery`.
 *
 * Read from the URL rather than held in state, which buys three things state cannot:
 *
 *   shareable links — `/gallery` opens the gallery directly, so "look at this" is a URL rather than
 *   a set of directions;
 *   a working Back button — clicking into the console and pressing Back returns to the landing page
 *   instead of leaving the site;
 *   no flash — the path is read before the first render, so no screen appears for a frame on the way
 *   to another.
 *
 * No router library. Four paths, no params, no nested layouts and no loaders; `react-router` would be
 * several kilobytes and a provider tree to express one Map lookup.
 */
/**
 * Resolve the locale before React mounts.
 *
 * A bare `/chat` is rewritten to `/en/chat` (or `/zh/chat`) with replaceState, so from the first
 * paint onward the address bar states the language. Done here rather than in an effect for the
 * reason the routing itself is read synchronously: an effect would render one locale for a frame
 * and then swap, and the swap is a whole page of copy changing under the reader.
 *
 * replaceState, never pushState — a redirect that adds a history entry means Back lands on the bare
 * URL, which redirects again, and the reader cannot leave the site.
 */
function resolveLocaleInUrl(): void {
  if (typeof window === 'undefined') return
  const langs = navigator.languages?.length
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : []
  const to = localeRedirect(window.location.pathname, langs)
  if (to !== null && to !== window.location.pathname) {
    window.history.replaceState(null, '', to + window.location.search + window.location.hash)
  }
}

resolveLocaleInUrl()

function Root() {
  const [route, setRoute] = useState(currentRoute)
  /**
   * The locale on screen, seeded from the URL.
   *
   * `route.locale` cannot be null by now — resolveLocaleInUrl() ran before this component existed
   * and rewrote any bare path. The fallback is there because a type cannot express "already
   * redirected", and defaulting is better than a non-null assertion that would crash the page if
   * that ordering ever changed.
   */
  const locale: Locale = route.locale ?? DEFAULT_LOCALE

  /**
   * Switching language keeps the reader where they are: `/zh/gallery` from `/en/gallery`.
   *
   * pushState, not replaceState, and this is the one place that difference goes the other way: a
   * language switch is a navigation the reader made, so Back should undo it. Remembered too, so a
   * later visit to a bare URL resolves to the same choice.
   */
  const setLocale = useCallback((next: Locale) => {
    rememberLocale(next)
    const to = switchLocalePath(window.location.pathname, next)
    window.history.pushState(null, '', to)
    setRoute(routeFor(to))
    // The document's own language, for screen readers and for the browser's translate prompt.
    document.documentElement.lang = next
  }, [])

  // Keep <html lang> in step with the URL on first paint and on Back/forward.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  /**
   * A prompt typed into the landing page's hero, handed to the console.
   *
   * The landing page does not send it. Sending would mean that component needs the gateway client,
   * the spend tracker and the consent dialog — all of App's machinery — to service one text box, and
   * it would put a second place in charge of spending money.
   */
  const [handoff, setHandoff] = useState<string | undefined>(undefined)

  // Back and forward. Without this, history entries exist and moving between them changes the URL
  // while the page stays put — which is worse than having no routing, because the address bar then
  // lies about what is on screen.
  useEffect(() => {
    const onPop = () => setRoute(routeFor(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  if (route.page === 'landing') {
    return (
      <LocaleProvider locale={locale}>
        <LandingPage
          locale={locale}
          onLocale={setLocale}
          onEnter={(prompt, path) => {
            setHandoff(prompt)
            const to = path ?? consolePath(locale)
            navigate(to)
            setRoute(routeFor(to))
          }}
        />
      </LocaleProvider>
    )
  }

  return (
    <LocaleProvider locale={locale}>
      <App
        initialPrompt={handoff}
        // The pane the URL named, as a seed only. Once mounted, App owns which pane is showing and
        // rewrites the path itself — so switching panes does not round-trip through this component,
        // and this value is not a prop the console has to stay in sync with.
        initialView={route.view}
        locale={locale}
        onLocale={setLocale}
        onHome={() => {
          const to = landingPath(locale)
          navigate(to)
          setRoute(routeFor(to))
        }}
      />
    </LocaleProvider>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
