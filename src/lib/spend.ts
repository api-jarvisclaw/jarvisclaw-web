/**
 * The spend policy: when a charge needs the user's word, and when it must simply stop.
 *
 * Two thresholds, and they are deliberately different KINDS of gate:
 *
 *   perCallLimit    — above this, ASK. The user may say yes; it is a consent prompt.
 *   sessionLimit    — at this, STOP. Not a prompt: a session that has spent its budget
 *                     must not be able to talk its way past it, or the budget is only
 *                     advisory. The user raises the limit deliberately or starts fresh.
 *
 * The CLI uses the same split for the same reason. A single "ask above X" gate lets a
 * long run of individually-cheap approved calls add up to an amount nobody agreed to.
 */

/** Charges at or below this run without asking. */
export const DEFAULT_PER_CALL_USD = 0.05

/** Total for one session, after which nothing more is spent. */
export const DEFAULT_SESSION_USD = 1.0

export interface SpendPolicy {
  perCallUsd: number
  sessionUsd: number
}

export const DEFAULT_POLICY: SpendPolicy = {
  perCallUsd: DEFAULT_PER_CALL_USD,
  sessionUsd: DEFAULT_SESSION_USD,
}

/**
 * How many wallet signatures one agent run on a PAID chat model is expected to need.
 *
 * Not a limit — an estimate, used to warn before the run rather than during it. It exists
 * because of a measured failure: one request produced FIVE signature prompts in a row, and
 * nothing had said it would.
 *
 * The prompts cannot be batched away. One x402 `exact` signature authorises exactly one HTTP
 * request, and an agent turn is one request; the facilitator advertises the `upto` scheme
 * only on Base Sepolia (measured against its /supported), while the gateway quotes `exact`
 * on mainnet. So per-call signing is a protocol floor, and the honest fix is to say so up
 * front instead of surprising someone mid-run.
 */
export const TYPICAL_AGENT_STEPS = 3

export type SpendDecision =
  /** Under both limits: run it, no prompt. */
  | { kind: 'allow' }
  /** Over the per-call limit but within the session budget: ask the user. */
  | { kind: 'ask'; usd: number; remainingUsd: number }
  /** Would exceed the session budget: refuse, and say by how much. */
  | { kind: 'refuse'; reason: string }

/**
 * Decide what to do about one prospective charge.
 *
 * `spentUsd` is what this session has already spent, not including `usd`.
 */
export function decideSpend(
  usd: number,
  spentUsd: number,
  policy: SpendPolicy = DEFAULT_POLICY,
): SpendDecision {
  // A non-positive or unusable price is refused rather than waved through as free. A
  // NaN price compares false against every threshold, so without this check it would
  // pass both gates and spend an unknown amount.
  if (!Number.isFinite(usd) || usd < 0) {
    return { kind: 'refuse', reason: 'the price could not be read, so nothing was spent' }
  }
  if (usd === 0) return { kind: 'allow' }

  // Session budget first: a charge that would break the total is refused whether or
  // not it is individually small. Checking the per-call gate first would prompt the
  // user for a charge that must be refused anyway.
  const remaining = policy.sessionUsd - spentUsd
  if (usd > remaining) {
    return {
      kind: 'refuse',
      reason:
        `this call costs $${usd.toFixed(6)} but only $${Math.max(0, remaining).toFixed(6)} ` +
        `of the $${policy.sessionUsd.toFixed(2)} session budget is left`,
    }
  }

  if (usd > policy.perCallUsd) {
    return { kind: 'ask', usd, remainingUsd: remaining }
  }
  return { kind: 'allow' }
}

/** Running total for one session. */
export class SpendTracker {
  private total = 0
  private readonly entries: Array<{ label: string; usd: number }> = []
  private current: SpendPolicy

  constructor(policy: SpendPolicy = DEFAULT_POLICY) {
    this.current = { ...policy }
  }

  get policy(): SpendPolicy {
    return this.current
  }

  /**
   * Adopt new limits WITHOUT resetting what has been spent.
   *
   * Mutating rather than rebuilding is the point: the alternative — a fresh tracker on every
   * settings change — would zero the running total, so raising a budget mid-session would also
   * silently forgive everything already charged and hand back a full allowance. The ledger is
   * a record of real money that left the wallet; a preference change must not erase it.
   *
   * Lowering below what is already spent is allowed and leaves `remainingUsd` at 0, which then
   * refuses further charges. That is the honest outcome of "stop at less than I have spent".
   */
  setPolicy(policy: SpendPolicy): void {
    this.current = { ...policy }
  }

  get spentUsd(): number {
    return this.total
  }

  get remainingUsd(): number {
    return Math.max(0, this.policy.sessionUsd - this.total)
  }

  get history(): ReadonlyArray<{ label: string; usd: number }> {
    return this.entries
  }

  decide(usd: number): SpendDecision {
    return decideSpend(usd, this.total, this.policy)
  }

  /**
   * Record a charge that actually happened.
   *
   * Called after the call returns, not when it is approved: an approved call that then
   * failed to reach the upstream costs nothing, and counting it would shrink the
   * user's budget for a service they never received.
   */
  record(label: string, usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return
    this.total += usd
    this.entries.push({ label, usd })
  }
}
