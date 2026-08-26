import { PanelLeftIcon } from 'lucide-react'

import { navFor } from '../lib/nav'
import { pathForView } from '../lib/route-path'
import type { RailView } from './ChatList'
import { ThemeToggle } from './ThemeToggle'
import type { Theme } from '../lib/theme'

/**
 * The console's top bar.
 *
 * It used to hold a rail toggle, a status tag and two buttons — everything a session needs and
 * nothing that says where else there is to go. Every destination lived in the left rail, so with the
 * rail collapsed (or on a tablet, where it is hidden entirely) the console had no navigation at all.
 *
 * The nav items come from `lib/nav.ts`, shared with the landing page's bar. Two hand-kept lists
 * drift, and the drift is invisible: an item added to one bar and forgotten on the other looks like
 * a link that is broken on some pages.
 *
 * They are real anchors with real `href`s, not buttons. Each console pane has a URL now, so a nav
 * item that could be middle-clicked or copied should be — `preventDefault` keeps the navigation
 * client-side while leaving the browser's own affordances intact. A `<button>` here would silently
 * remove copy-link and open-in-new-tab from every item in the bar.
 */
export function TopNav({
  view,
  anonymous,
  busy,
  theme,
  railOpen,
  hasTurns,
  onView,
  onRail,
  onTheme,
  onStop,
  onNew,
}: {
  view: RailView
  anonymous: boolean
  busy: boolean
  theme: Theme
  railOpen: boolean
  /** Whether there is anything to clear, so "New chat" can disable itself. */
  hasTurns: boolean
  onView: (v: RailView) => void
  onRail: () => void
  onTheme: (t: Theme) => void
  onStop: () => void
  onNew: () => void
}) {
  return (
    <header className="topbar">
      <button
        className="rail-toggle"
        onClick={onRail}
        aria-label={railOpen ? 'Hide conversations' : 'Show conversations'}
        aria-expanded={railOpen}
      >
        <PanelLeftIcon size={16} aria-hidden="true" />
      </button>

      <nav className="topnav" aria-label="Sections">
        {navFor('console').map((item) =>
          item.kind === 'view' ? (
            <a
              key={item.label}
              className={view === item.view ? 'topnav-item topnav-item-active' : 'topnav-item'}
              href={pathForView(item.view)}
              // aria-current, not just a class: the highlight is a colour, and colour alone does not
              // tell a screen reader which pane is open.
              aria-current={view === item.view ? 'page' : undefined}
              onClick={(e) => {
                // Modified clicks are left to the browser. Swallowing ctrl/cmd-click would turn
                // "open in a new tab" into an in-place navigation, which is the specific way a
                // hand-rolled link betrays someone who navigates by habit.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                e.preventDefault()
                onView(item.view)
              }}
            >
              {item.label}
            </a>
          ) : (
            <a
              key={item.label}
              className="topnav-item"
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.label}
            </a>
          ),
        )}
      </nav>

      <span className="spacer" />

      {/* Kept in the bar, and it is the most load-bearing label on the screen: it is the difference
          between "this will cost money" and "this will not". */}
      <span className={anonymous ? 'tag tag-free' : 'tag'}>
        {anonymous ? 'free · no sign-in' : 'signed in'}
      </span>

      <ThemeToggle theme={theme} onTheme={onTheme} />

      {busy && (
        <button className="ghost-btn" onClick={onStop}>
          Stop
        </button>
      )}
      <button className="ghost-btn" onClick={onNew} disabled={!hasTurns}>
        New chat
      </button>
    </header>
  )
}
