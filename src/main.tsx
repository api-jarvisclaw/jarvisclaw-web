import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { CONSOLE_PATH, currentPage, LANDING_PATH, navigate, pageFor } from './lib/route-path'
import { LandingPage } from './ui/LandingPage'
import './styles.css'
// The landing page's own stylesheet. It shares the design tokens declared in styles.css and
// nothing else, so it is kept separate rather than growing an already long file.
import './page.css'

/**
 * Two routes: the landing page at `/` and the console at `/chat`.
 *
 * Read from the URL rather than held in state, which buys three things state cannot:
 *
 *   a shareable link — `ducat.jarvisclaw.ai/chat` opens the console directly, so a link someone
 *   sends does not land the recipient on marketing copy to hunt through;
 *   a working Back button — clicking into the console and pressing Back returns to the landing
 *   page instead of leaving the site;
 *   no flash — the path is read before the first render, so the console never appears for a frame
 *   on the way to the right screen.
 *
 * No router library. Two routes, no params, no nested layouts and no loaders; `react-router` would
 * be several kilobytes and a provider tree to express one comparison.
 */
function Root() {
  const [page, setPage] = useState(currentPage)
  /**
   * A prompt typed into the landing page's hero, handed to the console.
   *
   * The landing page does not send it. Sending would mean that component needs the gateway client,
   * the spend tracker and the consent dialog — all of App's machinery — to service one text box,
   * and it would put a second place in charge of spending money.
   */
  const [handoff, setHandoff] = useState<string | undefined>(undefined)

  // Back and forward. Without this, history entries exist and moving between them changes the URL
  // while the page stays put — which is worse than having no routing, because the address bar then
  // lies about what is on screen.
  useEffect(() => {
    const onPop = () => setPage(pageFor(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  if (page === 'landing') {
    return (
      <LandingPage
        onEnter={(prompt) => {
          setHandoff(prompt)
          navigate(CONSOLE_PATH)
          setPage('console')
        }}
      />
    )
  }

  return (
    <App
      initialPrompt={handoff}
      onHome={() => {
        navigate(LANDING_PATH)
        setPage('landing')
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
