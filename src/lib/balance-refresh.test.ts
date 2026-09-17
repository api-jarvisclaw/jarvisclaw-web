import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The balance is re-read after this session spends money.
 *
 * Reported as "ducat 花了钱，余额也不会自动更新。要人刷新网页才会" — and it was exactly that. An API
 * key is billed SERVER-SIDE: the gateway deducts quota and the response says nothing about it, so
 * the only figure that moved was the sidebar's own "Spent" counter. `whoami` runs once on mount
 * and is deliberately not polled, so the balance beside it kept its mount-time value until the
 * user reloaded the page.
 *
 * `refreshBalance` itself is unit-tested in account.test.ts. What CANNOT be tested there is
 * whether anything ever calls it — a correct function nobody invokes is the shape of PR #30,
 * which shipped a placeholder created after the only call it was meant to cover and changed
 * nothing observable. So this file reads App.tsx and asserts the wiring.
 *
 * The wiring is keyed on `spendVersion` rather than called from each payment site, and the guard
 * checks that specifically. There are three sites that spend money (chat signature, media
 * generation, agent tool call); every one of them already bumps that counter for the sidebar's
 * benefit. Hanging the refresh off the counter is what makes a fourth site, written later by
 * someone who never read this file, refresh the balance without having to remember to.
 */
const raw = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

/** Every spend site, identified by the counter bump that already had to be there. */
const SPEND_BUMPS = raw.match(/setSpendVersion\(\(v\) => v \+ 1\)/g) ?? []

/**
 * The effect that performs the refresh, as source text.
 *
 * Located by its dependency array rather than by a character window after `useEffect`. A fixed
 * window is how three earlier guards in this repo passed on correct code: the line they were
 * looking for sat a few characters past the cutoff. Anchoring on the closing `}, [spendVersion])`
 * bounds the region by the thing that makes it the right effect.
 */
function refreshEffect(): string {
  const dep = raw.indexOf('}, [spendVersion])')
  if (dep === -1) return ''
  const start = raw.lastIndexOf('useEffect(() => {', dep)
  if (start === -1) return ''
  return raw.slice(start, dep + '}, [spendVersion])'.length)
}

describe('a paid call refreshes the account balance', () => {
  it('has spend sites to cover', () => {
    // The denominator. If this file ever reads zero of them the guard below is asserting over an
    // empty set, and "the refresh covers every spend site" would be vacuously true — the
    // zero-sample pass, arrived at by a rename rather than by a regression.
    expect(SPEND_BUMPS.length).toBeGreaterThanOrEqual(3)
  })

  it('imports the refresh from the account module', () => {
    // A type-only import would satisfy a grep for the name while calling nothing: `import type`
    // is erased at compile time. So the assertion is on a value import specifically.
    expect(raw).toMatch(/import\s*\{[^}]*\brefreshBalance\b[^}]*\}\s*from\s*'\.\/lib\/account'/)
    expect(raw).not.toMatch(/import\s+type\s*\{[^}]*\brefreshBalance\b/)
  })

  it('runs the refresh in an effect keyed on the spend counter', () => {
    const effect = refreshEffect()
    expect(effect).not.toBe('')
    expect(effect).toContain('refreshBalance(')
  })

  it('feeds the result back into the account state', () => {
    // The mutation that motivates this line: calling refreshBalance and dropping its return
    // value leaves every test in account.test.ts green while the screen never changes. That is
    // the no-op fix this repo keeps rediscovering, so the assertion is on the assignment, not on
    // the call.
    expect(refreshEffect()).toMatch(/setAccount\(\s*fresh\s*\)/)
  })

  it('keeps the old figure when the re-read failed', () => {
    // refreshBalance returns null on failure. Passing that straight to setAccount would sign the
    // user out on a network blip — the panel renders the signed-out state for a null account.
    expect(refreshEffect()).toMatch(/fresh\s*!==\s*null/)
  })

  it('does not fire on mount, where whoami has just run', () => {
    // spendVersion starts at 0 and is only ever incremented after a spend. Without this guard the
    // effect makes a credentialed request on every page load, duplicating whoami's own.
    expect(refreshEffect()).toMatch(/spendVersion\s*===\s*0/)
  })

  it('does nothing when nobody is signed in', () => {
    // A wallet-only session has no account to refresh, and an anonymous one has no session at
    // all. Calling with a null account would throw on `account.id`.
    expect(refreshEffect()).toMatch(/account\s*===\s*null/)
  })

  it('aborts the request when the effect is torn down', () => {
    // A refresh in flight when the tab's account changes would otherwise resolve later and write
    // a balance belonging to the previous session.
    const effect = refreshEffect()
    expect(effect).toContain('AbortController')
    expect(effect).toMatch(/return\s*\(\)\s*=>\s*ac\.abort\(\)/)
  })
})
