import { describe, expect, it } from 'vitest'

import { marketHeadline } from './Marketplace'

/**
 * The line under the marketplace heading.
 *
 * Small enough to look obviously correct, and it was wrong three separate ways: it named the
 * complete catalogue while showing curated picks, it sized the curated tier by summing a facet
 * that the curated tier caps, and it said "1 categories". The first two were caught by a browser
 * probe, the third by printing the header verbatim in one.
 */
describe('marketHeadline', () => {
  const base = { curatedTotal: 186, completeTotal: 2720, facetTotal: 12, categoryCount: 17 }

  it('sizes the curated tier by its own total, not by the facet sum', () => {
    // The facet is capped per category in the curated tier, so summing it understates the tier.
    // This read "12 picks" for a 186-row listing.
    const line = marketHeadline({ ...base, curated: true })
    expect(line).toContain('186 picks')
    expect(line).not.toContain('12 picks')
    expect(line).not.toContain('2,720')
  })

  it('names the complete catalogue only when that is what is shown', () => {
    const line = marketHeadline({ ...base, curated: false })
    expect(line).toContain('2,720 callable endpoints')
    expect(line).not.toContain('picks')
  })

  it('does not lead with the raw catalogue size while curated', () => {
    // The specific thing the report called a liability: making the 2,700+ figure the headline.
    expect(marketHeadline({ ...base, curated: true })).not.toContain('2,720')
  })

  it('pluralises the category count', () => {
    expect(marketHeadline({ ...base, curated: true, categoryCount: 1 })).toContain('1 category,')
    expect(marketHeadline({ ...base, curated: true, categoryCount: 17 })).toContain('17 categories')
  })

  it('falls back to the facet sum when the gateway reports no tier sizes', () => {
    // An older gateway omits curated_total/complete_total. Printing "0 picks" over a full grid of
    // results is a page contradicting itself.
    const line = marketHeadline({
      curated: false,
      curatedTotal: 0,
      completeTotal: 0,
      facetTotal: 2720,
      categoryCount: 17,
    })
    expect(line).toContain('2,720 callable endpoints')
  })

  it('says nothing at all when there is no count to state', () => {
    // Before the first response lands. A sentence with a zero in it would be a claim; silence is
    // the honest state, and the caller renders its own placeholder.
    expect(
      marketHeadline({
        curated: true,
        curatedTotal: 0,
        completeTotal: 0,
        facetTotal: 0,
        categoryCount: 0,
      }),
    ).toBe('')
  })

  it('always states that paid calls ask first', () => {
    // The consent promise is the one part of this line that is not about counts, and it must
    // survive every branch: someone deciding whether to try this needs to know a charge is
    // confirmed, not discovered.
    for (const curated of [true, false]) {
      expect(marketHeadline({ ...base, curated })).toContain('asks before it spends')
    }
  })
})
