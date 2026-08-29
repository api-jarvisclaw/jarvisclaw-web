/**
 * A cut-off answer must not render as a finished one.
 *
 * Reported from a screenshot: the reply ended "这个市场的描述是：如果" — mid-sentence, after two paid
 * `call_api` steps had already spent the user's money fetching the data being described. There was
 * no marker of any kind; the fragment read as the whole answer.
 *
 * Two independent causes, measured against the live gateway rather than reasoned about:
 *
 *   1. `streamChat` defaults to `max_tokens: 1024` and the agent never overrode it, so a
 *      tool-using turn — which must restate an API payload before interpreting it — ran out.
 *   2. The gateway layer already captured `finish_reason` and NOBODY read it. Verified live: the
 *      same prompt returns `finish_reason: 'length'` at a low ceiling and `'stop'` at a high one,
 *      and the truncated reply is an ordinary 200 with no other distinguishing mark.
 *
 * Fixing only the ceiling would move the boundary without making a crossing visible, so both are
 * pinned here.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { earlyStopNotice } from './agent'

const agent = () => readFileSync('src/lib/agent.ts', 'utf8')
const gateway = () => readFileSync('src/lib/gateway.ts', 'utf8')

describe('the output ceiling', () => {
  it('is raised above the transport default for answer turns', () => {
    const text = agent()
    const match = text.match(/const ANSWER_MAX_TOKENS = ([\d_]+)/)
    expect(match, 'ANSWER_MAX_TOKENS is gone — answers fall back to the 1024 default').not.toBeNull()
    const ceiling = Number(match![1]!.replace(/_/g, ''))
    // The default it exists to beat, read from the transport rather than restated, so this cannot
    // pass by both numbers drifting together.
    const fallback = gateway().match(/max_tokens: req\.maxTokens \?\? (\d+)/)
    expect(fallback, 'the transport default vanished; this comparison is meaningless').not.toBeNull()
    expect(ceiling).toBeGreaterThan(Number(fallback![1]))
  })

  it('is actually passed to the streaming call', () => {
    /**
     * The load-bearing adjacency check. Defining the constant and not passing it is exactly the
     * original defect — `maxTokens` was an accepted parameter that no caller supplied — and a unit
     * test on the constant alone would stay green through it.
     */
    const text = agent()
    const call = text.slice(text.indexOf('const request = streamChat('))
    expect(call.slice(0, 200)).toContain('maxTokens: ANSWER_MAX_TOKENS')
  })

  it('is bounded, not unbounded', () => {
    // A free model already ran to 229k characters of reasoning once; MAX_REASONING_CHARS is the
    // other half of that defence and removing the ceiling entirely would undo this one.
    const ceiling = Number(agent().match(/const ANSWER_MAX_TOKENS = ([\d_]+)/)![1]!.replace(/_/g, ''))
    expect(ceiling).toBeLessThanOrEqual(32_000)
  })
})

/**
 * Every early stop is reported, not just the one I guessed first.
 *
 * The first version of this fix handled `finish_reason: 'length'` only, and the guards asserted on
 * the literal string `finishReason === 'length'`. Both were too narrow in the same direction, so
 * the reported defect survived a fix and a green test suite.
 *
 * Measured against the live gateway afterwards, the real cause was
 *
 *     finish_reason: 'sensitive'   37 frames, 64 chars, clean [DONE], HTTP 200
 *
 * GLM's content moderation cutting generation mid-sentence on a Polymarket question about Chinese
 * politics — arriving as a tool result the user had already paid for. Non-streaming answers 400 for
 * the same input; streaming answers 200 and just stops.
 *
 * So these test the FUNCTION's behaviour over the reasons that actually occur, plus the property
 * that made the miss possible: an unknown reason must not be treated as success.
 */
describe('earlyStopNotice', () => {
  it('says nothing for a normal finish', () => {
    for (const reason of ['stop', '']) {
      expect(earlyStopNotice(reason), JSON.stringify(reason)).toBeNull()
    }
  })

  it('says nothing for a tool call, which is not an early stop', () => {
    // The model asked for a tool and the loop is about to run it. A notice here would be noise on
    // every single tool-using turn.
    for (const reason of ['tool_calls', 'function_call']) {
      expect(earlyStopNotice(reason), reason).toBeNull()
    }
  })

  it('reports the length cut as continuable', () => {
    const msg = earlyStopNotice('length')
    expect(msg).not.toBeNull()
    expect(msg!.toLowerCase()).toContain('incomplete')
    // A length cut CAN be continued, so the advice must say so.
    expect(msg!.toLowerCase()).toMatch(/ask for the rest/)
  })

  it('reports the moderation cut, and does not advise a retry that will fail', () => {
    /**
     * The reported defect. Distinct wording is the point: telling someone to "ask for the rest"
     * when the upstream will refuse the same material again spends another paid turn for nothing.
     */
    for (const reason of ['sensitive', 'content_filter']) {
      const msg = earlyStopNotice(reason)
      expect(msg, reason).not.toBeNull()
      expect(msg!.toLowerCase()).toContain('incomplete')
      expect(msg!.toLowerCase()).toContain('filter')
      expect(msg!.toLowerCase(), `${reason} must not promise a retry works`)
        .not.toMatch(/ask for the rest/)
    }
  })

  it('reports an UNKNOWN reason rather than accepting it', () => {
    /**
     * The property whose absence let the real cause through. Upstreams add reasons without notice —
     * 'sensitive' is not in the OpenAI set — and the old code compared against one string, so
     * everything else fell through as a finished answer.
     *
     * Over-reporting is recoverable; presenting a fragment as an answer is not.
     */
    for (const reason of ['sensitive_but_renamed', 'model_error', 'guardrail', 'ANYTHING']) {
      const msg = earlyStopNotice(reason)
      expect(msg, `unknown reason ${reason} was treated as a normal finish`).not.toBeNull()
      expect(msg!).toContain(reason)
    }
  })
})

describe('the agent applies it', () => {
  it('routes the finish reason through earlyStopNotice before done', () => {
    /**
     * Adjacency, because the function is useless uncalled — and a unit test on the function alone
     * would stay green with the call deleted, which is the shape of every inert fix in this repo.
     */
    const text = agent()
    const at = text.indexOf('earlyStopNotice(result.finishReason)')
    expect(at, 'the agent no longer consults earlyStopNotice; an early stop reads as complete')
      .toBeGreaterThan(0)
    const done = text.indexOf("yield { type: 'done', model: result.model }", at)
    expect(done, 'no done event follows the check').toBeGreaterThan(at)
    // Order matters: `done` ends the stream the UI reads, so a notice after it may never render.
    expect(text.slice(at, done)).toContain("type: 'notice'")
  })

  it('keeps the partial text rather than replacing it with an error', () => {
    // The fragment is the model's real answer and is worth reading; `error` renders instead of
    // alongside.
    const text = agent()
    const at = text.indexOf('earlyStopNotice(result.finishReason)')
    const block = text.slice(at, at + 300)
    expect(block).toContain("type: 'notice'")
    expect(block).not.toContain("type: 'error'")
  })

  it('no longer compares against a single hardcoded reason', () => {
    // The specific mistake: `result.finishReason === 'length'` handled one cause and let the
    // reported one through. A bare equality test against one literal must not come back.
    expect(agent()).not.toMatch(/result\.finishReason === '[a-z_]+'/)
  })
})

