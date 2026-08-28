import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LOCALE,
  detectLocale,
  isLocale,
  LOCALE_NAMES,
  LOCALES,
  localePath,
  splitLocale,
  switchLocalePath,
} from './i18n'

/**
 * The locale in the URL.
 *
 * This is the part of i18n that breaks in ways copy cannot: a prefix that does not round-trip
 * strands a reader on the landing page, and a switcher that loses the current pane sends them back
 * to the start of the site in a language they asked for. Both look like the app forgot where they
 * were rather than like a routing bug.
 */
describe('splitLocale', () => {
  it('separates a known prefix from the rest', () => {
    expect(splitLocale('/en/chat')).toEqual({ locale: 'en', rest: '/chat' })
    expect(splitLocale('/zh/marketplace')).toEqual({ locale: 'zh', rest: '/marketplace' })
  })

  it('treats a bare locale as the root of that language', () => {
    // `/en` is the English landing page, not an unknown path. Getting this wrong would 404 the
    // canonical home URL of every language.
    expect(splitLocale('/en')).toEqual({ locale: 'en', rest: '/' })
    expect(splitLocale('/zh/')).toEqual({ locale: 'zh', rest: '/' })
  })

  it('reports no locale for a bare path, rather than assuming English', () => {
    // The distinction the redirect is built on. `locale: 'en'` here would make `/chat` and
    // `/en/chat` identical, so nothing could tell which URLs still need rewriting.
    expect(splitLocale('/chat')).toEqual({ locale: null, rest: '/chat' })
    expect(splitLocale('/')).toEqual({ locale: null, rest: '/' })
  })

  it('does not treat an unsupported language as a prefix', () => {
    // `/de/chat` must keep its whole path. Stripping `de` would render English copy under a German
    // URL — claiming a translation that does not exist — and `/deploy` shows why the check has to be
    // against the locale list rather than "two letters then a slash".
    expect(splitLocale('/de/chat')).toEqual({ locale: null, rest: '/de/chat' })
    expect(splitLocale('/fr')).toEqual({ locale: null, rest: '/fr' })
    expect(splitLocale('/deploy')).toEqual({ locale: null, rest: '/deploy' })
  })

  it('accepts the case a browser or a person might send', () => {
    expect(splitLocale('/EN/chat').locale).toBe('en')
    expect(splitLocale('/Zh/gallery').locale).toBe('zh')
  })
})

describe('localePath', () => {
  it('prefixes a path', () => {
    expect(localePath('en', '/chat')).toBe('/en/chat')
    expect(localePath('zh', '/gallery')).toBe('/zh/gallery')
  })

  it('emits one canonical form for the root', () => {
    // `/en`, not `/en/`. navigate() and replacePath() both short-circuit when the target equals
    // location.pathname, so two spellings of the same page would make that check unreliable and
    // leave a stale URL in the bar.
    expect(localePath('en', '/')).toBe('/en')
    expect(localePath('zh', '/')).toBe('/zh')
  })

  it('round-trips with splitLocale for every locale', () => {
    for (const l of LOCALES) {
      for (const rest of ['/', '/chat', '/marketplace', '/gallery']) {
        expect(splitLocale(localePath(l, rest))).toEqual({ locale: l, rest })
      }
    }
  })
})

describe('switchLocalePath', () => {
  it('keeps the reader on the same page', () => {
    // The failure this prevents: switching to Chinese from the gallery landing you on the Chinese
    // home page, which reads as the site losing your place.
    expect(switchLocalePath('/en/gallery', 'zh')).toBe('/zh/gallery')
    expect(switchLocalePath('/zh/marketplace', 'en')).toBe('/en/marketplace')
  })

  it('works from an unprefixed path', () => {
    expect(switchLocalePath('/chat', 'zh')).toBe('/zh/chat')
  })

  it('is its own inverse', () => {
    for (const rest of ['/', '/chat', '/gallery']) {
      const en = localePath('en', rest)
      expect(switchLocalePath(switchLocalePath(en, 'zh'), 'en')).toBe(en)
    }
  })
})

describe('detectLocale', () => {
  it('matches any Chinese variant', () => {
    // zh-CN, zh-TW and zh-Hans readers are all better served by Chinese than by English. This app
    // has no region-specific copy, so splitting them would produce a distinction nobody can act on.
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans', 'ZH-cn']) {
      expect(detectLocale([tag]), tag).toBe('zh')
    }
  })

  it('falls back to English for a language we do not have', () => {
    expect(detectLocale(['de-DE', 'fr'])).toBe('en')
    expect(detectLocale([])).toBe('en')
  })

  it('honours the order the browser gave', () => {
    // navigator.languages is a preference list. Taking the last match, or scanning our own list
    // first, would give a zh-first reader English whenever English appears anywhere in theirs.
    expect(detectLocale(['zh-CN', 'en-US'])).toBe('zh')
    expect(detectLocale(['en-US', 'zh-CN'])).toBe('en')
  })

  it('skips languages it does not know instead of giving up at the first', () => {
    expect(detectLocale(['de', 'zh-CN'])).toBe('zh')
  })
})

describe('the locale list', () => {
  it('names every locale in its own language', () => {
    // A reader who cannot read the current interface is exactly who needs the switcher, so
    // "Chinese" written in English is useless to them.
    for (const l of LOCALES) {
      expect(LOCALE_NAMES[l], l).toBeTruthy()
    }
    expect(LOCALE_NAMES.zh).toBe('中文')
  })

  it('defaults to a locale that exists', () => {
    expect(isLocale(DEFAULT_LOCALE)).toBe(true)
  })

  it('rejects anything not in the list', () => {
    for (const v of ['de', '', 'en-US', null, 42, undefined]) {
      expect(isLocale(v), String(v)).toBe(false)
    }
  })
})
