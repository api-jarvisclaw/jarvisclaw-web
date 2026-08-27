/**
 * Model selection with downgrade, because a model list is never as true as it looks.
 *
 * Measured on the live gateway (2026-08-24): `auto/free` resolved to
 * `zai/glm-4-flash`, and the request came back "Unknown model: zai/glm-4-flash" — while
 * the SAME model requested by name answered fine. So the free tier's own resolution can
 * hand back a name its chosen channel cannot serve, and a client that trusts one virtual
 * model name has no first run at all.
 *
 * This is also what Franklin's resilience actually consists of: not a better list, but
 * treating "this model is unservable right now" as an ordinary event and moving to the
 * next candidate. The list is read from the gateway each session rather than written
 * here, so a retired or repriced model stops being offered without a code change.
 */

import { FREE_MODEL, isModelUnavailable, listFreeModels, type Credential } from './gateway'

export interface RouteOptions {
  baseUrl: string
  cred?: Credential
  signal?: AbortSignal
}

/**
 * What one model's failure means for the session.
 *
 * Three outcomes, not a boolean. The distinction that matters is between "the last
 * candidate has now failed" and "this failure was not about the model at all": the first
 * should be reported as the free tier being exhausted, the second as the raw error the
 * gateway gave. A boolean collapses them, and a caller then reports a rate limit and a
 * used-up candidate list with the same words.
 */
export type FailureOutcome = 'try-next' | 'exhausted' | 'not-a-model-problem'

/**
 * Candidate models to try in order, for a session with no credential.
 *
 * `auto/free` goes first: when it works it picks per prompt, which is better than any
 * fixed order this file could impose. The named models are the fallback for when its
 * resolution lands on something unservable.
 */
export async function freeCandidates(opts: RouteOptions): Promise<string[]> {
  const candidates = [FREE_MODEL]
  try {
    for (const name of await listFreeModels(opts)) {
      if (!candidates.includes(name)) candidates.push(name)
    }
  } catch {
    // Discovery unreachable. auto/free alone is still worth attempting — failing here
    // would turn a degraded first run into no first run.
  }
  return candidates
}

/**
 * A model chooser that remembers what has already failed this session.
 *
 * Stateful on purpose: without the exclusion set, every message would re-try the same
 * broken model first and pay the same latency to learn the same thing. Franklin keeps
 * this per session for the same reason.
 */
export class ModelRouter {
  private candidates: string[] = []
  private readonly dead = new Set<string>()
  private loaded = false

  constructor(private readonly opts: RouteOptions) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.candidates = await freeCandidates(this.opts)
    this.loaded = true
  }

  /**
   * How long a retired model stays retired.
   *
   * "Unavailable" on this pool means capacity exhausted, which is a condition of the minute rather
   * than a property of the model — the same name that 429s now serves a request a short while
   * later, measured repeatedly across the free pool.
   *
   * Reported from a screenshot: "Every free model the gateway offers is unavailable right now"
   * shown at the top of a turn that `qwen3.6-flash` then answered. Both statements were produced
   * by this class: the list had been exhausted earlier in the session, `dead` never emptied, so a
   * later message reported exhaustion without trying anything — and the retry that followed found
   * a working model immediately. A permanent set turns one bad minute into a dead session.
   *
   * Five minutes, not one, and the number comes from what a retry actually costs. Measured against
   * the live pool while it was degraded: a model that is going to 429 takes 30-34 SECONDS to say
   * so, and an agent turn walks the list on every step. Expiring after a minute means a long
   * conversation keeps re-paying half a minute to rediscover the same refusal. Long enough to stop
   * re-probing a model this session just watched fail; short enough that a recovered pool comes
   * back well inside one sitting.
   */
  private static readonly RETIRE_MS = 300_000

  private readonly retiredAt = new Map<string, number>()

  /** Drops retirements that have aged out, so a recovered model is tried again. */
  private expireRetirements(now = Date.now()): void {
    for (const [model, at] of this.retiredAt) {
      if (now - at >= ModelRouter.RETIRE_MS) {
        this.retiredAt.delete(model)
        this.dead.delete(model)
      }
    }
  }

  /** The model to try now, or undefined when everything known has failed. */
  async current(): Promise<string | undefined> {
    await this.ensureLoaded()
    this.expireRetirements()
    return this.candidates.find((m) => !this.dead.has(m))
  }

  /**
   * Records that a model could not serve a request, and reports whether another remains.
   *
   * Only an unavailability error retires a model. A rate limit, a network blip or an auth
   * failure says nothing about the model, and retiring on those would burn the whole
   * candidate list over one bad minute.
   *
   * Async because the answer depends on the candidate list, which may not have loaded
   * yet. A synchronous version read an empty list and reported "nothing left to try" on
   * the very first failure — correct only by accident, because the caller happens to ask
   * for a model first. Depending on that call order would make this quietly wrong for
   * the next caller.
   */
  async markFailed(model: string, err: unknown): Promise<FailureOutcome> {
    if (!isModelUnavailable(err)) return 'not-a-model-problem'
    await this.ensureLoaded()
    this.expireRetirements()
    this.dead.add(model)
    this.retiredAt.set(model, Date.now())
    return this.candidates.some((m) => !this.dead.has(m)) ? 'try-next' : 'exhausted'
  }

  /**
   * Retires a model for a reason the gateway never reported.
   *
   * `markFailed` decides from the error message whether the model is at fault, which is right for
   * everything the gateway says — and useless for a failure the gateway was never told about. The
   * runaway-reasoning guard aborts the stream from the client after the model emits tens of
   * thousands of characters without answering; there is no gateway error to inspect, and the model
   * has still proven it cannot serve this session.
   *
   * Shares the same expiry as every other retirement (see RETIRE_MS): a model that ran away on one
   * question is not permanently broken, and the pool is small enough that a permanent exclusion
   * would end the session early.
   */
  async retire(model: string): Promise<FailureOutcome> {
    await this.ensureLoaded()
    this.expireRetirements()
    this.dead.add(model)
    this.retiredAt.set(model, Date.now())
    return this.candidates.some((m) => !this.dead.has(m)) ? 'try-next' : 'exhausted'
  }

  get retired(): string[] {
    return [...this.dead]
  }
}
