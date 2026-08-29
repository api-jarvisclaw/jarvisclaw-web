/**
 * Advertised counts must be defensible, and they must agree with each other.
 *
 * Every user-facing surface said "4000+ APIs and 80+ models". Measured against the live gateway on
 * 2026-08-29, both were wrong and in OPPOSITE directions:
 *
 *   /api/marketplace/apis   total 2720, of which 2440 are distinct by (name, path)
 *                           — 280 are the same endpoint registered under mirrored servers
 *   /api/discovery/models   283
 *
 * So the API count was overstated by ~64% and the model count understated by ~250%. Overstating is
 * the dangerous half: it is checkable by anyone in one request, and the catalogue endpoint is
 * public. Understating merely undersells.
 *
 * This test does NOT call the network — a unit test that depends on production would fail on a
 * flight and pass for the wrong reasons. It pins the numbers to a single constant per claim and
 * asserts every surface agrees, so re-measuring is one edit and drift between surfaces is caught.
 * Re-measure with:
 *
 *   curl -s 'https://api.jarvisclaw.ai/api/marketplace/apis?page=1&page_size=1'   # .data.total
 *   curl -s 'https://api.jarvisclaw.ai/api/discovery/models'                      # .data.length
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * What the copy is allowed to claim, and what was actually measured.
 *
 * The claim is deliberately BELOW the measurement. "2,400+" against 2440 distinct stays true as
 * entries churn, and it is the distinct count rather than the raw total because the extra 280 are
 * duplicates — advertising them would be counting the same endpoint twice.
 */
const CLAIMS = {
  apis: { claimed: '2,400+', measuredDistinct: 2440, measuredTotal: 2720 },
  models: { claimed: '280+', measured: 283 },
} as const

const SURFACES = [
  'package.json',
  'README.md',
  'src/lib/agent.ts',
  'src/lib/tools.ts',
] as const

describe('advertised counts', () => {
  it('claims no more than was measured', () => {
    const apis = Number(CLAIMS.apis.claimed.replace(/[^\d]/g, ''))
    expect(apis).toBeLessThanOrEqual(CLAIMS.apis.measuredDistinct)
    const models = Number(CLAIMS.models.claimed.replace(/[^\d]/g, ''))
    expect(models).toBeLessThanOrEqual(CLAIMS.models.measured)
  })

  it('counts distinct APIs, not mirrored duplicates', () => {
    /**
     * The marketplace reports 2720 and 2440 of those are distinct: the same upstream is registered
     * as two servers (one with a www prefix), so a dedup key of (server_id, path) cannot see it.
     * Claiming the raw total would be counting one endpoint twice.
     */
    expect(CLAIMS.apis.measuredDistinct).toBeLessThan(CLAIMS.apis.measuredTotal)
    const apis = Number(CLAIMS.apis.claimed.replace(/[^\d]/g, ''))
    expect(apis, 'the claim must be based on the distinct count').toBeLessThanOrEqual(
      CLAIMS.apis.measuredDistinct,
    )
  })

  it('is the same number on every surface', () => {
    // The old copy drifted per file: package.json, README and two source strings each carried their
    // own wording. A user comparing the npm page to the site should not see two figures.
    for (const file of SURFACES) {
      const text = readFileSync(file, 'utf8')
      if (!/APIs?\b/i.test(text)) continue
      expect(text, `${file} still claims a stale API count`).not.toMatch(/4000\+|4,000\+/)
      expect(text, `${file} still claims a stale model count`).not.toMatch(/\b80\+\s*(language\s*)?models?/)
    }
  })

  it('names the API count identically wherever it appears', () => {
    let seen = 0
    for (const file of SURFACES) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/([\d,]+)\+\s*(?:callable\s*)?APIs?/gi)) {
        seen += 1
        expect(m[1], `${file}: claims ${m[1]}+ APIs, expected ${CLAIMS.apis.claimed}`).toBe(
          CLAIMS.apis.claimed.replace('+', ''),
        )
      }
    }
    expect(seen, 'no API count found on any surface — this guard is scanning nothing').toBeGreaterThan(0)
  })

  it('names the model count identically wherever it appears', () => {
    let seen = 0
    for (const file of SURFACES) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/([\d,]+)\+\s*(?:language\s*)?models?/gi)) {
        seen += 1
        expect(m[1], `${file}: claims ${m[1]}+ models, expected ${CLAIMS.models.claimed}`).toBe(
          CLAIMS.models.claimed.replace('+', ''),
        )
      }
    }
    expect(seen, 'no model count found on any surface — this guard is scanning nothing').toBeGreaterThan(0)
  })
})

describe('what must NOT be claimed', () => {
  it('does not call the zero-priced media models free', () => {
    /**
     * 25 models report input/output price 0, but only 10 carry `free: true`. The other 15 are the
     * per-CALL media models — nano-banana, gpt-image-2, seedance-1.5-pro — whose per-TOKEN price is
     * genuinely zero and which charge real money per image or video.
     *
     * So "25 free models" would be a lie built from true numbers, and the front end has computed a
     * Free badge from prices before, showing 13 paid models as free. Copy must not repeat it.
     */
    for (const file of SURFACES) {
      const text = readFileSync(file, 'utf8')
      expect(text, `${file} claims a free-model count that includes paid media models`)
        .not.toMatch(/\b25\s+free\b/i)
    }
  })

  it('does not claim to be the cheapest', () => {
    /**
     * Measured: some paths carry very thin margin and the quota cache path is 1.00x, i.e. none. A
     * price-leadership claim is unverified and trivially disproved.
     *
     * Scoped to the MARKETING surfaces only. The first version scanned agent.ts too and failed on
     *
     *   '- Prefer the cheapest API that answers the question.'
     *
     * which is an instruction telling the agent how to spend the user's money well — the opposite
     * of a boast, and something this test should protect rather than forbid. A guard that cannot
     * tell a claim from an instruction would have been "fixed" by deleting that line.
     */
    for (const file of ['package.json', 'README.md'] as const) {
      const text = readFileSync(file, 'utf8')
      expect(text, `${file} makes a price-leadership claim`).not.toMatch(
        /\b(cheapest|lowest price|best price)\b/i,
      )
    }
  })
})
