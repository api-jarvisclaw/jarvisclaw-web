import { describe, expect, it } from 'vitest'

import { SEEDANCE } from './seedance'
import { SHOWCASE } from './showcase'
import { SHOWCASE_ASSETS, SHOWCASE_ASSET_SET } from './showcase-manifest'

/**
 * The manifest is a committed copy of what R2 serves, so it can drift in two directions and only
 * one of them is caught elsewhere.
 *
 * `seedance.test.ts` and `showcase.test.ts` catch data naming an asset the manifest lacks — a blank
 * tile. Measured: emptying the manifest fails 5 of their assertions, so that direction is covered
 * and the floor below is NOT what catches it.
 *
 * What the floor does catch is data and manifest shrinking *together* — a regeneration that drops
 * half the collection leaves both sides agreeing, and every per-item loop passes over whatever
 * survived. The count is the only thing that notices, which is why it is pinned rather than
 * derived.
 */
describe('the showcase asset manifest', () => {
  it('is not empty, and is not a placeholder', () => {
    // Without this, deleting the manifest's contents turns two suites green while every tile on
    // the page is broken: `missing` computed over an empty set is an empty array.
    expect(SHOWCASE_ASSETS.length).toBeGreaterThan(140)
    expect(SHOWCASE_ASSET_SET.size).toBe(SHOWCASE_ASSETS.length)
  })

  it('holds no duplicate names', () => {
    expect(new Set(SHOWCASE_ASSETS).size).toBe(SHOWCASE_ASSETS.length)
  })

  it('lists bare filenames, never paths', () => {
    // The URL is built as `${CDN}/showcase/${file}`, so a name carrying a slash silently escapes
    // the prefix — and `showcase/` is the prefix with no expiry rule. A path here could land a
    // lookup under `media/`, which clears daily.
    for (const name of SHOWCASE_ASSETS) {
      expect(name, name).not.toContain('/')
      expect(name, name).toMatch(/\.(jpg|jpeg|png|webp|mp4)$/)
    }
  })

  it('covers every asset both data files reference', () => {
    // The same direction the other suites check, asserted once over the union so a new data file
    // added without regenerating the manifest fails here rather than rendering blank tiles.
    const referenced = new Set<string>()
    for (const s of SEEDANCE) {
      referenced.add(s.poster)
      if (s.video) referenced.add(s.video)
    }
    for (const s of SHOWCASE) {
      referenced.add(s.asset)
      if (s.poster) referenced.add(s.poster)
    }
    expect(referenced.size).toBeGreaterThan(140)
    const uncovered = [...referenced].filter((f) => !SHOWCASE_ASSET_SET.has(f))
    expect(uncovered).toEqual([])
  })
})
