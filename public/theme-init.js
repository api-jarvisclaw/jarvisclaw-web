/**
 * Applies the stored theme before first paint.
 *
 * Deliberately duplicates a few lines of src/lib/theme.ts. It runs as a blocking script in
 * <head>, before the module graph exists, so it cannot import them — and the alternative is a
 * frame rendered in the wrong theme, which is the flash that gives away a bolted-on theme.
 *
 * A separate file rather than an inline <script> so `script-src 'self'` covers it with no
 * 'unsafe-inline' exemption. The CSP is the main protection on a page that handles an API key
 * and asks a wallet to sign payments; widening it for a theme flash would be a bad trade.
 *
 * The cookie name and the default MUST stay in step with src/lib/theme.ts. If they drift, this
 * script sets one theme and React immediately sets the other — a visible flip on every load.
 */
;(function () {
  try {
    var name = 'vite-ui-theme'
    var parts = document.cookie.split(';')
    var stored = null
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim().split('=')
      if (kv[0] === name) {
        stored = kv.slice(1).join('=')
        break
      }
    }
    // Light is the console's DEFAULT_THEME. Anything unrecognised falls back rather than being
    // trusted, so a hand-edited cookie cannot leave the page with a class matching no rules.
    var theme = stored === 'dark' || stored === 'light' ? stored : 'light'
    var el = document.documentElement
    el.classList.add(theme)
    if (theme === 'dark') el.classList.remove('light')
  } catch (e) {
    // Cookies blocked, or document unavailable. The stylesheet's :root defaults to light on its
    // own, so doing nothing here is already correct — this must never throw and block the page.
  }
})()
