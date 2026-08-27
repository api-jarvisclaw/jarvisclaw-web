import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The typefaces, pinned as source text.
 *
 * The complaint this encodes is "don't use an AI font". The specific thing that produced it: we shipped
 * JetBrains Mono and applied it in 33 places, most of them prose — conversation titles, marketplace
 * card headings, gallery notes, the landing page's brand and its step numbers. A monospace face on
 * ordinary text is the strongest visual signal of a machine-generated page; it reads as a terminal
 * pretending to be a product.
 *
 * The reference is the main site, and it was measured rather than assumed: jarvisclaw.ai resolves
 * `--font-sans` to `"Public Sans", sans-serif` and `--font-mono` to a plain system stack, loading no
 * mono webfont at all.
 *
 * Read as text rather than rendered, because what matters is what the stylesheet ASKS FOR. A render
 * test in jsdom resolves every family to the same default and would pass on either version.
 */

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const page = readFileSync(new URL('./page.css', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
}

describe('the typefaces', () => {
  it('imports no monospace webfont', () => {
    // The import is what pulls five woff2 files into the bundle. Checked separately from the family
    // stack below, because leaving the import while changing `--mono` would still ship the payload.
    expect(styles).not.toMatch(/@import\s+'@fontsource[^']*mono/)
    expect(styles).toMatch(/@import\s+'@fontsource-variable\/public-sans'/)
  })

  it('does not depend on a monospace font package', () => {
    // A dependency nothing imports is a dependency someone will re-import. Removing the @import while
    // leaving the package installed leaves the trap loaded.
    for (const name of Object.keys(pkg.dependencies)) {
      expect(name).not.toMatch(/mono/i)
    }
  })

  it('resolves --mono to the system stack the main site uses', () => {
    const mono = styles.match(/--mono:\s*([^;]+);/s)?.[1] ?? ''
    expect(mono).not.toMatch(/JetBrains|Fira|IBM Plex|Space Mono|Roboto Mono/i)
    // `ui-monospace` first, so each platform contributes its own best face (SF Mono, Cascadia) rather
    // than one we picked for all of them.
    expect(mono.trim()).toMatch(/^ui-monospace/)
    expect(mono).toContain('monospace')
  })

  it('keeps monospace off prose and headings', () => {
    /**
     * The selectors that had it and should not: card headings, chips, badges, names, ages, counts of
     * things. Each one is a sentence or a title, and none of them needs characters to line up.
     *
     * Named individually rather than counted, because a count passes as soon as the total drops and
     * says nothing about which ones went. These are the ones that produced the look.
     */
     const forbidden = [
      '.market-card h2',
      '.market-chip',
      '.market-cat-n',
      '.picker-name',
      '.picker-row-name',
      '.rail-row-age',
      '.rail-count',
      '.hint-model',
      '.genopts-chip',
      '.media-head',
      '.seedance-badge',
      '.seedance-count',
    ]
    for (const sel of forbidden) {
      const at = styles.indexOf(`${sel} {`)
      expect(at, `${sel} is missing from styles.css`).toBeGreaterThan(-1)
      const block = styles.slice(at, styles.indexOf('}', at))
      expect(block, `${sel} still asks for the mono stack`).not.toContain('var(--mono)')
    }
    // The landing page's brand and step numbers were mono too, which made the first thing a visitor
    // reads look like terminal output.
    for (const sel of ['.page-brand', '.page-step-n']) {
      const at = page.indexOf(`${sel} {`)
      expect(at, `${sel} is missing from page.css`).toBeGreaterThan(-1)
      expect(page.slice(at, page.indexOf('}', at))).not.toContain('var(--mono)')
    }
  })

  it('keeps monospace where characters must line up', () => {
    /**
     * The other half, and the reason this is not simply "delete every --mono".
     *
     * A column of prices whose digits are different widths cannot be scanned; a raw JSON payload in a
     * proportional face is harder to read; and an input whose text shifts sideways as you type reads
     * as a rendering bug. Monospace earns its place in exactly these cases.
     */
    for (const sel of ['.amount', '.ledger', '.media-raw', '.showcase-prompt']) {
      const at = styles.indexOf(`${sel} {`)
      expect(at, `${sel} is missing from styles.css`).toBeGreaterThan(-1)
      expect(styles.slice(at, styles.indexOf('}', at))).toContain('var(--mono)')
    }
  })

  it('aligns the hero figures with tabular numerals rather than a mono face', () => {
    // The alternative to monospace when only the DIGITS need to line up. Using the mono stack here
    // would give four big numbers a terminal look on the one screen that forms a first impression.
    const at = page.indexOf('.page-figures dt {')
    expect(at).toBeGreaterThan(-1)
    const block = page.slice(at, page.indexOf('}', at))
    expect(block).toContain('tabular-nums')
    expect(block).not.toContain('var(--mono)')
  })
})
