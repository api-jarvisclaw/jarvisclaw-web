import { describe, expect, it } from 'vitest'

import { SHOWCASE, showcaseMode, showcaseUrl } from './showcase'

/**
 * The prompt gallery's data, checked as data. Thirty-two items transcribed from another site is
 * exactly the kind of thing that goes subtly wrong in transcription — a missing asset, a prompt
 * truncated at a quote character, attribution dropped from one row — and every one of those
 * failures renders as a plausible-looking page.
 */
describe('SHOWCASE', () => {
  it('has all 32 items', () => {
    expect(SHOWCASE).toHaveLength(32)
  })

  it('gives every item a title, model and asset', () => {
    for (const item of SHOWCASE) {
      expect(item.title, item.slug).not.toBe('')
      expect(item.model, item.slug).not.toBe('')
      expect(item.asset, item.slug).not.toBe('')
    }
  })

  it('uses unique slugs', () => {
    // A duplicate would make one item unreachable, since the detail view is keyed on it.
    expect(new Set(SHOWCASE.map((s) => s.slug)).size).toBe(SHOWCASE.length)
  })

  it('carries 28 prompts, and nothing pretends to have one it does not', () => {
    // The four launch-film stills were assembled with a skill rather than written as a prompt.
    // An empty string would render a Copy button over nothing, so they are explicitly null.
    const withPrompt = SHOWCASE.filter((s) => s.prompt !== null)
    expect(withPrompt).toHaveLength(28)
    for (const item of withPrompt) {
      expect(item.prompt!.length, item.slug).toBeGreaterThan(100)
    }
    for (const item of SHOWCASE.filter((s) => s.prompt === null)) {
      expect(item.slug).toMatch(/^launch-film-/)
    }
  })

  it('keeps the argument placeholders intact', () => {
    // `{argument name="…" default="…"}` marks what the author expected to be edited. Resolving
    // them into finished text would remove the only thing that makes a prompt reusable, and it
    // is the kind of loss a transcription script does silently.
    const templated = SHOWCASE.filter((s) => s.prompt?.includes('{argument'))
    expect(templated.length).toBeGreaterThan(0)
    for (const item of templated) {
      // Balanced, i.e. not cut off mid-placeholder.
      const opens = (item.prompt!.match(/\{argument/g) ?? []).length
      const closes = (item.prompt!.match(/\}/g) ?? []).length
      expect(closes, item.slug).toBeGreaterThanOrEqual(opens)
    }
  })

  it('credits the prompt authors', () => {
    // Attribution is data, not decoration: these are other people's prompts. Franklin credits
    // every handle and the upstream collection, and dropping either would be taking credit for
    // writing that is not ours.
    const authored = SHOWCASE.filter((s) => s.author !== null)
    expect(authored.length).toBeGreaterThanOrEqual(18)
    for (const item of authored) {
      expect(item.author, item.slug).toMatch(/^@/)
    }
    // The video prompts come from a published collection.
    const credited = SHOWCASE.filter((s) => s.credit !== null)
    expect(credited.length).toBeGreaterThan(0)
    for (const item of credited) {
      expect(item.credit, item.slug).toMatch(/^https:\/\//)
    }
  })

  it('serves media from our own CDN, never from the source site', () => {
    // Two independent reasons, both measured: the page CSP allows images only from self, data:
    // and our CDN, and the CDN Worker refuses franklin.run as a copy source (403). A hotlinked
    // asset would render as a blank tile with a console error.
    for (const item of SHOWCASE) {
      const url = showcaseUrl(item.asset)
      expect(url, item.slug).toContain('/showcase/')
      expect(url, item.slug).not.toContain('franklin.run')
      expect(item.asset, item.slug).not.toContain('/')
    }
  })

  it('routes a prompt to the endpoint its model belongs to', () => {
    // Mapped from the model, not the media type. Three of the four launch-film items are JPEG
    // stills FROM a video shoot — keying on the file extension would send a video prompt to the
    // image endpoint and produce a poster of the scene instead of the scene.
    for (const item of SHOWCASE) {
      const mode = showcaseMode(item)
      expect(mode, item.slug).toBe(/seedance/i.test(item.model) ? 'video' : 'image')
    }
    const stillFromVideo = SHOWCASE.find((s) => s.kind === 'image' && /seedance/i.test(s.model))
    expect(stillFromVideo, 'a still from a video shoot should exist').toBeDefined()
    expect(showcaseMode(stillFromVideo!)).toBe('video')
  })

  it('gives every video a poster or is its own', () => {
    // A video tile with no poster shows a black rectangle until it buffers, across a grid of 32.
    for (const item of SHOWCASE.filter((s) => s.kind === 'video')) {
      expect(item.poster ?? item.asset, item.slug).toBeTruthy()
    }
  })
})
