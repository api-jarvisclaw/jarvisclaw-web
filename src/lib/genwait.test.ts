import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * A generation must show a wait from the moment Enter is pressed — not from the paid call.
 *
 * Reported as "在处理都没有一个类似状态条的东西". My FIRST fix put the placeholder just before
 * the paid call, and a live check on the deployed page measured zero effect:
 *
 *     16 DOM samples over a 12s hold, 1 request held
 *       media-waiting box seen:   0
 *       progressbar in a turn:    0
 *       clock readings:           []
 *
 * The reason is that `challengeGeneration` (the quote) is a network call too, and on the
 * anonymous path it is the ONLY one — the run ends at the price notice. A placeholder created
 * after it covers a window that, for a visitor with no wallet, never happens. There are three
 * sequential waits here (quote, consent dialog, paid call) and from the outside they are one
 * wait, so the turn has to exist for all of it.
 *
 * ## Why source text
 *
 * The property is an ORDERING inside one long `useCallback` that closes over React state, a
 * wallet, a spend tracker and a consent promise. Driving it would mean standing all of that up,
 * and the resulting test would be mostly harness — while the thing that broke is one line's
 * position relative to another. So these read the source.
 *
 * The risk of that is a guard that passes on its own explanatory comment, which has happened
 * here before: a parity test failed on correct CSS because the comment naming the old value was
 * still in the file. `body()` therefore strips comments before matching, and every assertion
 * below runs against the stripped text.
 */
const raw = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

/** The source with comments removed, so no assertion can be satisfied by prose about itself. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** `runGeneration`'s body, sliced at syntax boundaries rather than a character count. */
function runGeneration(): string {
  const src = stripComments(raw)
  const start = src.indexOf('const runGeneration = useCallback(')
  expect(start, 'runGeneration must exist — this guard scans it').toBeGreaterThan(-1)
  // Ends at the next top-level `const … = useCallback(`, which is the following handler.
  const rest = src.slice(start + 10)
  const nextIdx = rest.search(/\n  const \w+ = useCallback\(/)
  const end = nextIdx === -1 ? src.length : start + 10 + nextIdx
  const body = src.slice(start, end)
  // A slice that lost the interesting region would make every assertion below vacuous.
  expect(body).toContain('challengeGeneration')
  expect(body.length).toBeGreaterThan(500)
  return body
}

describe('the waiting placeholder covers the whole wait', () => {
  it('creates the placeholder before the quote, not after it', () => {
    const body = runGeneration()
    const placeholder = body.indexOf('waiting: true')
    const quote = body.indexOf('await challengeGeneration')
    expect(placeholder, 'a `waiting` placeholder must be created').toBeGreaterThan(-1)
    expect(quote, 'the quote call must be present').toBeGreaterThan(-1)
    // THE assertion. This is exactly what my first attempt got wrong, and the live probe
    // measured 0 waiting boxes as a result.
    expect(
      placeholder,
      'the placeholder must be created BEFORE the quote — the quote is a network call, and on ' +
        'the anonymous path it is the only one',
    ).toBeLessThan(quote)
  })

  it('adds it in the same update as the user turn', () => {
    // One setTurns, so there is no frame in which the prompt is on screen alone. Two separate
    // calls would also work in practice, but this way the invariant is structural rather than
    // dependent on React batching.
    const body = runGeneration()
    const idx = body.indexOf("kind: 'user'")
    const placeholder = body.indexOf('waiting: true')
    expect(idx).toBeGreaterThan(-1)
    expect(placeholder - idx).toBeGreaterThan(0)
    expect(placeholder - idx).toBeLessThan(400)
  })

  it('quotes no price until one is known', () => {
    // `spentUsd: 0` at creation. A guessed figure would put a wrong charge on screen, and the
    // real one is patched in once the quote lands and the spend is approved.
    const body = runGeneration()
    const create = body.indexOf('waiting: true')
    const before = body.slice(Math.max(0, create - 400), create)
    /**
     * Anchored to the end of the value, not `toContain('spentUsd: 0')`.
     *
     * That substring version PASSED under a mutation that wrote `spentUsd: 0.064` — a hardcoded
     * guess, the exact thing this test claims to forbid — because "0.064" starts with "0". A
     * prefix match on a numeric literal has no power over any value beginning with the same
     * digit.
     */
    expect(before).toMatch(/spentUsd: 0\s*,/)
    expect(body).toContain('patchMediaTurn(turnId, convId, { spentUsd: quoted })')
  })

  it('clears the placeholder on every path that ends the run early', () => {
    /**
     * The failure this prevents is worse than the original defect: a placeholder left behind is
     * a clock that never advances and never resolves, under a notice explaining that nothing
     * happened. Each of these is a real exit —
     *
     *   the quote threw            (a 400, an unservable model)
     *   anonymous                  (the price notice; the COMMON case)
     *   the spend was declined     (consent dialog dismissed)
     *   no way to pay
     *   the wallet signature failed or was rejected
     */
    const body = runGeneration()
    const drops = body.match(/dropPlaceholder\(\)/g) ?? []
    // Five early returns plus the definition. Asserted as a floor, not an equality: adding
    // another exit must not silently satisfy this.
    expect(drops.length).toBeGreaterThanOrEqual(5)

    // Every `return` between the placeholder's creation and the paid call must be preceded by a
    // drop. Counting is not enough — five drops in one branch would satisfy a count.
    const create = body.indexOf('waiting: true')
    const paid = body.indexOf('await generate(')
    expect(paid).toBeGreaterThan(create)
    const middle = body.slice(create, paid)
    /**
     * A BARE `return` only — `/return\s*$/m` rather than `/return\b/`.
     *
     * The looser version raised a false alarm the moment `dropPlaceholder` itself grew a body:
     * `return next` inside a `setTurns` callback is not an exit from `runGeneration`, it is that
     * callback's own value. A guard that fires on correct code gets weakened or deleted, so the
     * pattern has to name the thing it means. `return` with nothing after it is unambiguous —
     * `runGeneration` returns void, so every real early exit takes that form.
     */
    const bareReturn = /\n[ \t]+return[ \t]*\r?$/gm
    const returns = middle.match(bareReturn) ?? []
    expect(returns.length, 'the early-return region must be found').toBeGreaterThan(0)
    for (const seg of middle.split(bareReturn).slice(0, -1)) {
      const tail = seg.slice(-600)
      expect(
        tail,
        'an early return between the placeholder and the paid call must clear it first',
      ).toContain('dropPlaceholder()')
    }
  })

  it('hands the turn over to the result instead of leaving it waiting', () => {
    // The success path clears `waiting` rather than dropping the turn: that turn IS the result.
    const body = runGeneration()
    expect(body).toContain('waiting: false')
  })
})
