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

describe('truncation is reported', () => {
  it('checks finishReason before calling the turn done', () => {
    /**
     * `finishReason` was captured by the transport and read by no one. The check has to sit in the
     * completion path — the branch that decides a turn is finished — or a truncated answer reaches
     * the user unmarked, which is what the screenshot shows.
     */
    const text = agent()
    expect(text, 'nothing reads finishReason; a truncated answer renders as complete')
      .toContain("result.finishReason === 'length'")
  })

  it('reports it before the done event, not after', () => {
    // Order matters: `done` is what stops the spinner and ends the stream the UI is reading, so a
    // notice emitted afterwards may never be applied to the transcript.
    const text = agent()
    const at = text.indexOf("result.finishReason === 'length'")
    expect(at, 'the truncation check is missing').toBeGreaterThan(0)
    const done = text.indexOf("yield { type: 'done', model: result.model }", at)
    expect(done, 'no done event follows the truncation check').toBeGreaterThan(at)
    // The notice must be inside the gap between them.
    expect(text.slice(at, done)).toContain("type: 'notice'")
  })

  it('keeps the partial text rather than replacing it with an error', () => {
    // The fragment is the model's real answer and is worth reading. An `error` event would be the
    // wrong shape — the transcript renders those instead of alongside.
    const text = agent()
    const at = text.indexOf("result.finishReason === 'length'")
    const block = text.slice(at, at + 600)
    expect(block).toContain("type: 'notice'")
    expect(block).not.toContain("type: 'error'")
  })
})
