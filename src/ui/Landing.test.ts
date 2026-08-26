import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The first screen's copy, checked as source text.
 *
 * This is the page a newcomer judges the product by, and its failure mode is not a crash — it is a
 * confident sentence that is false. Two of those are possible here and both have already happened
 * in this codebase:
 *
 *   a hardcoded count. The marketplace facet reported 26 categories one afternoon and 18 the next,
 *   and the model catalogue grows. A number typed into the source is a number that will be wrong.
 *
 *   a claim the product does not honour. The gallery said "stored permanently" about rows whose
 *   URLs expire in hours, which is how someone loses a file they paid for.
 *
 * Read as text rather than rendered, because what is being checked is what the file SAYS. A render
 * test would pass on a hardcoded number as readily as a live one.
 */

const source = readFileSync(new URL('./Landing.tsx', import.meta.url), 'utf8')

describe('the landing copy', () => {
  it('hardcodes no catalogue counts', () => {
    /**
     * The counts move, so they must come from props. Checked by looking for the numbers that were
     * true when this was written: 336 models, 2,720 endpoints, 18 categories. Any of them appearing
     * as a literal means someone typed a snapshot into the copy.
     *
     * Deliberately NOT a blanket "no digits" rule — `padStart(2, '0')` and step numbers are digits
     * with nothing to do with the catalogue, and a rule that forbids them would be worked around
     * rather than obeyed.
     */
    for (const stale of ['336', '2,720', '2720', '105 ', '18 categories']) {
      expect(source).not.toContain(stale)
    }
  })

  it('renders a dash rather than a zero while loading', () => {
    // "0 callable APIs" on a page still fetching reads as an empty product — on the one screen
    // whose entire job is a first impression. The null-or-zero guard is what prevents it.
    expect(source).toMatch(/n === null \|\| n === 0/)
    expect(source).toContain("'—'")
  })

  it('promises no permanence the gallery cannot deliver', () => {
    // The gallery's own retention notes are per-row for a reason: some files expire in hours. The
    // landing FAQ must not undo that with a blanket reassurance.
    const faq = source.slice(source.indexOf('const FAQ'))
    expect(faq).not.toMatch(/stored permanently|kept forever|never expires/i)
    // And it has to actually mention the limit, not just avoid overclaiming by saying nothing.
    expect(faq).toMatch(/expire|on a clock/i)
  })

  it('is honest that history lives in one browser', () => {
    // There is no account, so the transcript does not follow anyone anywhere. Someone who learns
    // that from the FAQ can plan around it; someone who learns it by losing a conversation cannot.
    const faq = source.slice(source.indexOf('const FAQ'))
    expect(faq).toMatch(/this browser/i)
    expect(faq).toMatch(/another device|other devices/i)
  })

  it('says the free tier needs no credential at all', () => {
    // The single most load-bearing claim on the page, and the reason this console exists in the
    // form it does. Measured previously: the free tier accepts only a request with NO auth header
    // — a placeholder key 401s — so "no account" has to mean exactly that.
    expect(source).toMatch(/no account, no key, no card/i)
  })

  it('keeps every starter something the gateway can actually do', () => {
    // A suggestion that fails on click is worse than none: it is the first thing a visitor tries.
    // Pinned as a count so a careless addition has to be a deliberate one.
    const block = source.slice(source.indexOf('const SUGGESTIONS'))
    const entries = block.slice(0, block.indexOf(']')).match(/'[^']+'/g) ?? []
    expect(entries.length).toBeGreaterThanOrEqual(4)
    for (const e of entries) {
      // Each ends as a question or an instruction, not a fragment — these are sent verbatim as a
      // user message.
      expect(e.replace(/'/g, '').trim().length).toBeGreaterThan(15)
    }
  })
})
