import { describe, expect, it } from 'vitest'

import { CDN_BASE_URL, RETENTION_NOTE, retentionIsAtRisk, retentionOf } from './gallery'

/**
 * How long an artifact lasts, per artifact.
 *
 * The gallery claimed "stored permanently" about every row. That is true of an archived file and
 * false of two other cases that look identical in the UI, and one of them is a file that will be
 * gone tomorrow. Getting this wrong is not a cosmetic problem: someone reads "permanent", does not
 * download, and loses something they paid for.
 */

describe('retentionOf', () => {
  it('calls an archived file kept, with no expiry', () => {
    // Verified against the live bucket, not assumed: the only lifecycle rule is `media-cache-1d`
    // on prefix `media/`, so `gallery/` genuinely never expires.
    expect(retentionOf({ url: `${CDN_BASE_URL}/gallery/abc123.png` })).toBe('kept')
  })

  it('calls a cached file cache, because it expires in a day', () => {
    // `media/` is the read-through cache and has a 1-day expiry rule. A row pointing here is real
    // today and gone tomorrow, which is the opposite of what "permanent" told the user.
    expect(retentionOf({ url: `${CDN_BASE_URL}/media/abc123.mp4` })).toBe('cache')
  })

  it('calls a provider URL upstream', () => {
    // What is left when `archive()` returns null — a network failure, or a source host the CDN
    // Worker refuses to copy from. These links expire within hours.
    expect(retentionOf({ url: 'https://someprovider.example/out/xyz.mp4' })).toBe('upstream')
  })

  it('calls inline bytes thisTab', () => {
    // Speech returns base64 with no URL at all, and the CDN Worker cannot copy it: it fetches from
    // an allowlisted host and inline bytes have no host. Those bytes live in one browser.
    expect(retentionOf({ mediaKey: 'k1' })).toBe('thisTab')
  })

  it('does not call another host permanent just because the path matches', () => {
    // The dangerous shortcut. Matching on the PATH alone would read an attacker's — or simply a
    // provider's — `/gallery/…` URL as permanently stored by us, and tell the user not to bother
    // downloading a file that expires in an hour.
    expect(retentionOf({ url: 'https://evil.example/gallery/abc.png' })).toBe('upstream')
    expect(retentionOf({ url: 'https://cdn.jarvisclaw.ai.evil.com/gallery/abc.png' })).toBe(
      'upstream',
    )
  })

  it('treats a missing url with no key as upstream rather than kept', () => {
    // Fails toward the warning. An unknown provenance that reported "kept" would be the one
    // combination that loses data silently; reporting a risk that turns out to be safe only costs
    // a needless download.
    expect(retentionOf({})).toBe('upstream')
  })
})

describe('the notes people actually read', () => {
  it('warns on exactly the classes that expire', () => {
    expect(retentionIsAtRisk('cache')).toBe(true)
    expect(retentionIsAtRisk('upstream')).toBe(true)
    expect(retentionIsAtRisk('kept')).toBe(false)
    // `thisTab` is deliberately NOT a warning. Nothing is on a clock — it survives reloads
    // indefinitely — so a warning colour would cry wolf on the common speech case and teach people
    // to ignore the colour that matters.
    expect(retentionIsAtRisk('thisTab')).toBe(false)
  })

  it('tells someone what to do about the ones that expire', () => {
    // A note without an action produces worry instead of a saved file.
    for (const r of ['cache', 'upstream'] as const) {
      expect(RETENTION_NOTE[r].toLowerCase()).toContain('download')
    }
  })

  it('never promises permanence for a class that does not have it', () => {
    for (const r of ['cache', 'upstream', 'thisTab'] as const) {
      expect(RETENTION_NOTE[r].toLowerCase()).not.toContain('permanent')
      expect(RETENTION_NOTE[r].toLowerCase()).not.toContain('no expiry')
    }
    expect(RETENTION_NOTE.kept.toLowerCase()).toContain('no expiry')
  })

  it('says where thisTab media does NOT exist, not only where it does', () => {
    // "Held in this browser" is easy to read as a detail. The consequences — clearing site data
    // loses it, other devices never had it — are the part someone needs before they rely on it.
    const note = RETENTION_NOTE.thisTab.toLowerCase()
    expect(note).toContain('this browser')
    expect(note).toMatch(/site data|clearing/)
    expect(note).toContain('devices')
  })
})
