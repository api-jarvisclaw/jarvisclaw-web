import { describe, expect, it } from 'vitest'

import { decideSpend, SpendTracker, DEFAULT_POLICY } from './spend'

describe('decideSpend', () => {
  it('runs a cheap call without asking', () => {
    expect(decideSpend(0.001, 0)).toEqual({ kind: 'allow' })
  })

  it('asks before a call above the per-call limit', () => {
    const d = decideSpend(0.2, 0)
    expect(d.kind).toBe('ask')
  })

  it('refuses rather than asks when the session budget is spent', () => {
    // The distinction is the point of having two thresholds. A session that has spent
    // its budget must not be able to prompt its way past it — otherwise the budget is
    // advisory and a long run of individually-approved calls exceeds it.
    const d = decideSpend(0.5, DEFAULT_POLICY.sessionUsd)
    expect(d.kind).toBe('refuse')
  })

  it('checks the session budget before the per-call limit', () => {
    // A small charge that still breaks the total must be refused outright, not shown to
    // the user as an approvable prompt they cannot actually act on.
    const d = decideSpend(0.001, DEFAULT_POLICY.sessionUsd)
    expect(d.kind).toBe('refuse')
  })

  it('says how much budget is left when it refuses', () => {
    const d = decideSpend(0.5, 0.8)
    expect(d.kind).toBe('refuse')
    if (d.kind === 'refuse') {
      expect(d.reason).toContain('0.200000')
      expect(d.reason).toContain('1.00')
    }
  })

  it('allows a free call with no prompt even at the session limit', () => {
    // Free tools must keep working after the budget is gone: search_apis costs nothing,
    // and blocking it would leave the agent unable to explain why it stopped.
    expect(decideSpend(0, DEFAULT_POLICY.sessionUsd)).toEqual({ kind: 'allow' })
  })

  it('refuses an unreadable price instead of treating it as free', () => {
    // NaN compares false against every threshold, so without an explicit check it would
    // pass both gates and spend an unknown amount.
    expect(decideSpend(Number.NaN, 0).kind).toBe('refuse')
    expect(decideSpend(Number.POSITIVE_INFINITY, 0).kind).toBe('refuse')
    expect(decideSpend(-1, 0).kind).toBe('refuse')
  })

  it('allows a charge exactly at the per-call limit', () => {
    // The limit is "ask ABOVE this", so the boundary itself must not prompt.
    expect(decideSpend(DEFAULT_POLICY.perCallUsd, 0)).toEqual({ kind: 'allow' })
  })

  it('allows a charge that exactly exhausts the session budget', () => {
    // Refusing here would leave the last cent of a budget permanently unspendable.
    expect(decideSpend(0.01, DEFAULT_POLICY.sessionUsd - 0.01)).toEqual({ kind: 'allow' })
  })
})

describe('SpendTracker', () => {
  it('accumulates what was actually spent', () => {
    const t = new SpendTracker()
    t.record('Gas Oracle', 0.0115)
    t.record('Btc Fees', 0.001)
    expect(t.spentUsd).toBeCloseTo(0.0125, 6)
    expect(t.history).toHaveLength(2)
  })

  it('reports the remaining budget', () => {
    const t = new SpendTracker()
    t.record('a', 0.25)
    expect(t.remainingUsd).toBeCloseTo(0.75, 6)
  })

  it('never reports a negative remaining budget', () => {
    // Displaying "-$0.20 left" is worse than "$0 left"; the refusal already carries the
    // real number.
    const t = new SpendTracker()
    t.record('a', 5)
    expect(t.remainingUsd).toBe(0)
  })

  it('ignores a zero or unreadable charge', () => {
    // record() is called after a call returns. A free tool, or a call that failed
    // before reaching the upstream, must not shrink the user's budget.
    const t = new SpendTracker()
    t.record('free tool', 0)
    t.record('bad price', Number.NaN)
    expect(t.spentUsd).toBe(0)
    expect(t.history).toHaveLength(0)
  })

  it('tightens as it spends', () => {
    const t = new SpendTracker({ perCallUsd: 0.05, sessionUsd: 0.1 })
    expect(t.decide(0.04).kind).toBe('allow')
    t.record('first', 0.08)
    // Same price, now unaffordable: the decision has to follow the running total, not
    // just the per-call price.
    expect(t.decide(0.04).kind).toBe('refuse')
  })
})

describe('SpendTracker.setPolicy', () => {
  it('raising the per-call limit stops the prompting', () => {
    // The user's actual complaint: being asked about every charge with no way to say "stop
    // asking below X".
    const t = new SpendTracker({ perCallUsd: 0.001, sessionUsd: 1 })
    expect(t.decide(0.01).kind).toBe('ask')
    t.setPolicy({ perCallUsd: 0.5, sessionUsd: 1 })
    expect(t.decide(0.01).kind).toBe('allow')
  })

  it('does NOT forgive what has already been spent', () => {
    // The load-bearing one. Rebuilding the tracker on a settings change would zero the total,
    // so raising the budget would also erase a real ledger of money that left the wallet —
    // and the user could spend the same allowance twice by nudging a setting.
    const t = new SpendTracker({ perCallUsd: 0.05, sessionUsd: 1 })
    t.record('a paid call', 0.4)
    t.setPolicy({ perCallUsd: 0.05, sessionUsd: 2 })
    expect(t.spentUsd).toBeCloseTo(0.4, 6)
    expect(t.history).toHaveLength(1)
    // 2.0 budget minus the 0.4 already spent, not a fresh 2.0.
    expect(t.remainingUsd).toBeCloseTo(1.6, 6)
  })

  it('lowering the budget below what is spent leaves nothing and refuses', () => {
    // The honest reading of "stop at less than I have already spent". Reporting a negative
    // remainder, or silently ignoring the new limit, would both be worse.
    const t = new SpendTracker({ perCallUsd: 0.05, sessionUsd: 1 })
    t.record('a', 0.8)
    t.setPolicy({ perCallUsd: 0.05, sessionUsd: 0.5 })
    expect(t.remainingUsd).toBe(0)
    expect(t.decide(0.01).kind).toBe('refuse')
  })

  it('reports the new limits through the policy getter', () => {
    // The sidebar reads this to render the budget meter; a stale copy would show a bar that
    // disagrees with the decisions being made.
    const t = new SpendTracker({ perCallUsd: 0.05, sessionUsd: 1 })
    t.setPolicy({ perCallUsd: 0.2, sessionUsd: 7 })
    expect(t.policy).toEqual({ perCallUsd: 0.2, sessionUsd: 7 })
  })

  it('copies the policy rather than aliasing the caller’s object', () => {
    // Otherwise a caller mutating its own settings object would silently change the live
    // spend gate with no call into this class at all.
    const mine = { perCallUsd: 0.05, sessionUsd: 1 }
    const t = new SpendTracker(mine)
    mine.sessionUsd = 999
    expect(t.policy.sessionUsd).toBe(1)
  })
})
