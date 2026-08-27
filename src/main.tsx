import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { CONSOLE_PATH, currentRoute, LANDING_PATH, navigate, routeFor } from './lib/route-path'
import { LandingPage } from './ui/LandingPage'
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
function Root() {
  const [route, setRoute] = useState(currentRoute)
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
      <LandingPage
        onEnter={(prompt, path) => {
          setHandoff(prompt)
          const to = path ?? CONSOLE_PATH
          navigate(to)
          setRoute(routeFor(to))
        }}
      />
    )
  }

  return (
    <App
      initialPrompt={handoff}
      // The pane the URL named, as a seed only. Once mounted, App owns which pane is showing and
      // rewrites the path itself — so switching panes does not round-trip through this component,
      // and this value is not a prop the console has to stay in sync with.
      initialView={route.view}
      onHome={() => {
        navigate(LANDING_PATH)
        setRoute(routeFor(LANDING_PATH))
      }}
    />
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
