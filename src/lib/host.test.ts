import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { CANONICAL_HOST, CANONICAL_ORIGIN } from './host'

/**
 * The hostname, and the two files that must agree with it.
 *
 * This exists because the failure mode is silent in both directions. If the Worker serves a
 * hostname the credentialed-origin allowlist does not name, `whoami` refuses to send its request
 * and every visitor is told they are signed out — with nothing in the console, because the whole
 * point of that guard is to not make the blocked request. If the allowlist names a hostname the
 * Worker does not serve, nothing breaks visibly and the entry is simply dead.
 *
 * Neither shows up in a build, a type check, or any behavioural test. Reading the deploy config
 * is the only thing that catches them.
 */

const wranglerConfig = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')

describe('the canonical host', () => {
  it('is the hostname the Worker actually serves', () => {
    // Read out of the deploy config rather than duplicated here. A test asserting
    // `CANONICAL_HOST === 'ducat.jarvisclaw.ai'` would only confirm the constant equals itself;
    // what can go wrong is the constant and the ROUTE drifting apart.
    expect(wranglerConfig).toContain(`"pattern": "${CANONICAL_HOST}"`)
  })

  it('serves exactly one hostname', () => {
    // chat.jarvisclaw.ai is detached by decision. Left in the routes it would serve this bundle
    // from an origin the gateway does not whitelist — so the page would load and then tell every
    // signed-in visitor they are signed out, which is the exact bug this app just finished fixing.
    //
    // Counts `"pattern":` rather than searching for the old hostname as a substring. The first
    // version of this test did the latter and failed on the COMMENT that explains why the name was
    // removed — a test that forbids naming a decision in prose is a test that gets the prose
    // deleted. What matters is how many routes exist, not which words appear in the file.
    const patterns = [...wranglerConfig.matchAll(/"pattern":\s*"([^"]+)"/g)].map((m) => m[1])
    expect(patterns).toEqual([CANONICAL_HOST])
  })

  it('derives the origin rather than restating it', () => {
    expect(CANONICAL_ORIGIN).toBe(`https://${CANONICAL_HOST}`)
    // https, not http. The origin is compared against `window.location.origin` to decide whether
    // to send credentials; a scheme mismatch would refuse them on the real site.
    expect(CANONICAL_ORIGIN.startsWith('https://')).toBe(true)
  })
})
