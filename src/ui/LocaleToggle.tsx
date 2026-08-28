import { LOCALE_NAMES, LOCALES, type Locale } from '../lib/i18n'

/**
 * Language switcher, sitting beside the theme toggle in both bars.
 *
 * ## Two buttons, not a dropdown
 *
 * With two locales a `<select>` costs a click to discover what the options even are, and its closed
 * state shows the CURRENT language — which is the one thing the reader already knows. Both names
 * visible means the switch is one click and the alternative is legible before committing.
 *
 * Revisit at four or more; a row of six is a different problem.
 *
 * ## Each name is written in its own language
 *
 * `中文`, not `Chinese`. Someone who cannot read the current interface is exactly the person who
 * needs this control, and labelling the target language in the language they cannot read is how a
 * switcher becomes useless to its own audience.
 *
 * ## Real links, not buttons
 *
 * `href` is the same page in the other locale, so the control can be middle-clicked, copied, and
 * read by a crawler as an alternate. The click is intercepted to keep the navigation client-side —
 * a full reload here would refetch the bundle and drop an in-flight paid generation.
 */
export function LocaleToggle({
  locale,
  onLocale,
  hrefFor,
}: {
  locale: Locale
  onLocale: (next: Locale) => void
  /** The URL for one locale, so this component does not need to know the current path. */
  hrefFor: (l: Locale) => string
}) {
  return (
    <div className="locale-toggle" role="group" aria-label="Language">
      {LOCALES.map((l) => (
        <a
          key={l}
          className={l === locale ? 'locale-btn locale-btn-on' : 'locale-btn'}
          href={hrefFor(l)}
          // lang on the link itself, so a screen reader pronounces 中文 in Chinese rather than
          // attempting it with an English voice.
          lang={l}
          // aria-current, not the class alone: the active state is a background colour, and colour
          // does not tell a screen reader which language is showing.
          aria-current={l === locale ? 'true' : undefined}
          onClick={(e) => {
            // Modified clicks belong to the browser — swallowing cmd-click would turn "open the
            // Chinese version in a new tab" into an in-place switch.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
            e.preventDefault()
            if (l !== locale) onLocale(l)
          }}
        >
          {LOCALE_NAMES[l]}
        </a>
      ))}
    </div>
  )
}
