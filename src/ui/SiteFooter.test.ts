import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The footer's destinations and structure, pinned to the main site's.
 *
 * Asked for: "ducat底下也要跟主站的一样". Measured on both rendered pages at 1440px, scrolled
 * to the bottom:
 *
 *                      main site   ducat (before)
 *   height             502px       81px
 *   links              15          3
 *   labelled columns   4           0
 *   brand + tagline    yes         brand only
 *   copyright line     yes         none
 *
 * An 81px strip with three links reads as an unfinished page. Every column title, its order and
 * every href were copied from the main site's own footer component rather than invented, so the
 * two cannot drift into describing different products — and that copying is what these tests
 * check, since a footer is exactly the region nobody re-reads.
 *
 * Read as source text: the destinations are the thing under test, and jsdom cannot tell me where
 * a link points any better than the file can. The RENDERED comparison was run separately against
 * a local build of dist and matched the main site item for item, in order:
 *
 *   JarvisClaw, Chat, Models, Marketplace, Docs, API Keys, Get Started Free,
 *   X, YouTube, LinkedIn, Instagram, TikTok, Reddit, Terms, Privacy      (15 = 15)
 *
 * with the four column labels identical at 12px / 500 / 0.6px uppercase.
 */
const source = readFileSync(new URL('./LandingPage.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../page.css', import.meta.url), 'utf8')

function block(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`)
  expect(at, `${selector} is missing — the assertion below would be vacuous`)
    .toBeGreaterThan(-1)
  return sheet.slice(at, sheet.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The main site's footer, column by column. Copied from its own component. */
const MAIN_SITE_FOOTER = {
  Product: ['Chat', 'Models', 'Marketplace', 'Docs'],
  Developers: ['API Keys', 'Get Started Free'],
  Connect: ['X', 'YouTube', 'LinkedIn', 'Instagram', 'TikTok', 'Reddit'],
  Legal: ['Terms', 'Privacy'],
}

describe('the footer carries the main site’s four columns', () => {
  for (const title of Object.keys(MAIN_SITE_FOOTER)) {
    it(`has a ${title} column`, () => {
      expect(source).toContain(`{t('${title}')}`)
    })
  }

  it('names every destination the main site names', () => {
    const all = Object.values(MAIN_SITE_FOOTER).flat()
    expect(all).toHaveLength(14)
    for (const label of all) {
      // Either a translated label or a bare one (the social handles are proper nouns).
      const present = source.includes(`{t('${label}')}`) || source.includes(`>${label}<`)
      expect(present, `the footer is missing "${label}"`).toBe(true)
    }
  })

  it('keeps every social account, since none can be derived from another', () => {
    // These handles were registered separately — Instagram is still MakeMyJarvis — so a
    // "fix the pattern" edit would silently point at accounts that do not exist.
    for (const href of [
      'https://x.com/ApiJarvisclaw',
      'https://www.youtube.com/@JarvisClaw',
      'https://www.linkedin.com/in/jarvis-claw-34213b417/',
      'https://www.instagram.com/MakeMyJarvis',
      'https://www.tiktok.com/@jarvisclaw',
      'https://www.reddit.com/user/Jarvisclaw/',
    ]) {
      expect(source).toContain(href)
    }
  })

  it('carries the tagline and a computed copyright year', () => {
    expect(source).toContain('The payment rail for AI.')
    expect(source).toContain('Agents transact. Autonomously.')
    // From the clock, not a literal: a hard-coded year is wrong every January and nobody
    // notices for months.
    expect(source).toContain('new Date().getFullYear()')
    expect(source).not.toMatch(/©\s*20\d\d\s+JarvisClaw/)
  })
})

describe('the platform links leave this SPA', () => {
  /**
   * The failure this pins, and it is invisible without it: an app-relative /pricing here would be
   * caught by this SPA's router and answer 200 with an empty shell. A 200 means no error surfaces
   * anywhere — the hero's docs button had exactly this bug once.
   */
  for (const path of ['/pricing', '/marketplace', '/keys', '/sign-up', '/user-agreement',
    '/privacy-policy']) {
    it(`${path} is absolute on the platform host`, () => {
      expect(source).toContain(`\${PLATFORM}${path}`)
    })
  }

  it('points PLATFORM at the site, not at the API host', () => {
    // DEFAULT_BASE_URL is api.jarvisclaw.ai — a gateway, not a page. Sending a human there is
    // the mistake the nav's "Platform" link made.
    expect(source).toContain("const PLATFORM = 'https://jarvisclaw.ai'")
    expect(source).not.toContain("PLATFORM = 'https://api.jarvisclaw.ai'")
  })

  it('sends Chat to this console rather than to ducat’s own URL', () => {
    // The one deliberate difference from the main site, whose Chat entry points AT ducat.
    // Linking a visitor from ducat to ducat is a no-op that looks broken.
    expect(source).not.toContain('https://ducat.jarvisclaw.ai')
    const chatAt = source.indexOf("{t('Chat')}")
    expect(chatAt).toBeGreaterThan(-1)
    // A button, because entering the console is a state change; an <a href="#"> that
    // preventDefaults is a link that lies about where it goes.
    expect(source.slice(chatAt - 200, chatAt)).toContain('onClick={() => onEnter()}')
  })
})

describe('the footer’s own styling', () => {
  it('labels columns at the main site’s measured 12px / 500 / 0.6px', () => {
    const label = block(css, '.page-foot-col h2')
    expect(label).toContain('font-size: 12px')
    expect(label).toContain('font-weight: 500')
    expect(label).toContain('letter-spacing: 0.6px')
    expect(label).toContain('text-transform: uppercase')
  })

  it('gives the wordmark its own size, not the link size', () => {
    // Without this it inherited .page-foot's 13px and sat at the same size as the links beside
    // it — the same defect the nav brand had.
    expect(block(css, '.page-foot-brand')).toContain('font-size: 16px')
  })

  it('scopes the link reset to the columns, not to every anchor in the footer', () => {
    /**
     * The regression this pins. The wordmark is an anchor too, and a broad `.page-foot a` rule
     * declared after `.page-foot-brand` wins at equal specificity — it rendered the brand as
     * 13px muted body text. Caught by reading the computed style after making the wordmark a
     * link, and it is the kind of thing that then looks like "the brand was always that colour".
     */
    expect(css).toContain('.page-foot-col a,')
    expect(css).not.toMatch(/^\.page-foot a,$/m)
    expect(css).not.toMatch(/^\.page-foot a \{/m)
  })

  it('gives the footer the main site’s vertical air', () => {
    // 80px top, measured off the main site's own footer inner. At 48/32 this rendered 151px
    // shorter than its reference on identical content, and the air is most of what makes a
    // footer read as the end of a page rather than a leftover strip.
    expect(block(css, '.page-foot-inner')).toContain('padding-block: 80px 40px')
  })
})
