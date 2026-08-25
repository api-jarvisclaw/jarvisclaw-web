import { MoonIcon, SunIcon } from 'lucide-react'

import type { Theme } from '../lib/theme'

/**
 * Light/dark toggle, built to match the console's own.
 *
 * Same shape as web/default/src/components/theme-toggle.tsx: a single icon button that swaps a
 * sun for a moon with a rotate-and-scale transition, both icons stacked so neither reflows the
 * layout as they cross over.
 */
export function ThemeToggle({
  theme,
  onTheme,
}: {
  theme: Theme
  onTheme: (t: Theme) => void
}) {
  const isDark = theme === 'dark'

  return (
    <button
      className="theme-toggle"
      onClick={() => onTheme(isDark ? 'light' : 'dark')}
      // The label says what the button DOES, not what the current state is. "Dark theme" on a
      // toggle leaves a screen reader user guessing whether that is the state or the action.
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <SunIcon className="theme-icon theme-icon-sun" size={17} aria-hidden="true" />
      <MoonIcon className="theme-icon theme-icon-moon" size={17} aria-hidden="true" />
    </button>
  )
}
