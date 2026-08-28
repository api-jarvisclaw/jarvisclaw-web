import { PanelLeftIcon } from 'lucide-react'

import { navFor } from '../lib/nav'
import { landingPath, pathForView, viewPath } from '../lib/route-path'
import { localePath, type Locale } from '../lib/i18n'
import type { RailView } from './ChatList'
import { LocaleToggle } from './LocaleToggle'
import { useT } from './LocaleContext'
import { ThemeToggle } from './ThemeToggle'
import type { Theme } from '../lib/theme'

/**
 * The console's top bar, spanning the whole window.
 *
 * It used to hold a rail toggle, a status tag and two buttons — everything a session needs and
 * nothing that says where else there is to go. Every destination lived in the left rail, so with the
 * rail collapsed (or on a tablet, where it is hidden entirely) the console had no navigation at all.
 *
 * ## Above the panes, not between them
 *
 * The first version of this bar was rendered inside `.main`, the grid's middle column. That made it
 * a *pane* bar: it began after the rail's right border and stopped at the sidebar's left one, with
 * the brand stranded in the rail beside it and two vertical rules cutting the row into thirds. A
 * global bar that stops two-thirds of the way across is not global — it just looks like the chat
 * pane has a toolbar.
 *
 * So the shell is now a row of two: this bar, then the three panes beneath it. Which is also why the
 * brand moved here out of the rail — the left edge of a global bar is where a logo belongs, and it is
 * what the landing page's own bar already does. The rail toggle sits beside it, next to the pane it
 * controls.
 *
 * ## Shared destinations
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
  onHome,
  locale,
  onLocale,
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
  /** Back to the landing page. Absent when this console was not rendered by the router. */
  onHome?: () => void
  /** The locale in the URL — every path this bar writes carries it. */
  locale: Locale
  /**
   * Change language. Absent when nothing owns the URL, which also hides the switcher: a control
   * that cannot navigate is worse than no control, because it looks like the switch failed.
   */
  onLocale?: (next: Locale) => void
}) {
  const t = useT()
  return (
    <header className="topbar">
      {/* The brand, at the window's left edge rather than inside the rail.
          A real anchor when there is a landing page to reach: a logo is a link to home on every site
          that has one, and rendering it as a button would drop copy-link and open-in-new-tab from the
          one element every visitor already knows how to use. */}
      {onHome ? (
        <a
          className="topbar-brand"
          href={landingPath(locale)}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
            e.preventDefault()
            onHome()
          }}
        >
          <img className="brand-mark" src="/jc.png" alt="" width={24} height={24} />
          <span className="topbar-brand-name">JarvisClaw</span>
        </a>
      ) : (
        <span className="topbar-brand">
          <img className="brand-mark" src="/jc.png" alt="" width={24} height={24} />
          <span className="topbar-brand-name">JarvisClaw</span>
        </span>
      )}

      <button
        className="rail-toggle"
        onClick={onRail}
        aria-label={railOpen ? 'Hide conversations' : 'Show conversations'}
        aria-expanded={railOpen}
      >
        <PanelLeftIcon size={16} aria-hidden="true" />
      </button>

      <nav className="topnav" aria-label={t('Sections')}>
        {navFor('console').map((item) =>
          item.kind === 'view' ? (
            <a
              key={item.label}
              className={view === item.view ? 'topnav-item topnav-item-active' : 'topnav-item'}
              href={pathForView(locale, item.view)}
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
              {t(item.label)}
            </a>
          ) : (
            <a
              key={item.label}
              className="topnav-item"
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t(item.label)}
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

      {onLocale && (
        <LocaleToggle
          locale={locale}
          onLocale={onLocale}
          // The same pane in the other language. Built from the CURRENT view rather than from
          // window.location, so the href is correct even before the effect that rewrites the path
          // has run — otherwise a language switch made immediately after changing pane would carry
          // the reader back to the pane they just left.
          hrefFor={(l) => localePath(l, viewPath(view))}
        />
      )}
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
