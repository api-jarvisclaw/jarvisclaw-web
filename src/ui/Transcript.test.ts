import { describe, expect, it } from 'vitest'

import {
  formatWait,
  isPlumbing,
  partitionSteps,
  tailOf,
  TAIL_CHARS,
  type ToolStep,
} from './Transcript'

/**
 * The one-line live tail of a reasoning stream.
 *
 * Measured against the gateway: the first reasoning frame arrives in 1.3-1.8s while the first
 * content frame can be 23-91s later, because the model writes thousands of characters of
 * deliberation first. For that whole gap the transcript HAD data and rendered a static
 * "Thinking" label, so a healthy stream looked frozen.
 */
describe('tailOf', () => {
  it('keeps a short thought whole', () => {
    expect(tailOf('Checking the catalogue')).toBe('Checking the catalogue')
  })

  it('shows the END of a long thought, not the beginning', () => {
    // The head stops changing after the first frame, and a frozen first sentence is exactly the
    // "nothing is happening" impression this exists to dispel.
    const s = 'A'.repeat(400) + 'THE-NEWEST-PART'
    const out = tailOf(s)
    expect(out.endsWith('THE-NEWEST-PART')).toBe(true)
    expect(out.startsWith('…')).toBe(true)
  })

  it('collapses newlines so the layout cannot grow mid-stream', () => {
    // Rendered on one clipped line. A multi-line thought arriving would otherwise push the
    // composer around several times a second.
    expect(tailOf('first line\n\nsecond   line\ttabbed')).toBe('first line second line tabbed')
    expect(tailOf('x\n'.repeat(50)).includes('\n')).toBe(false)
  })

  it('caps the length, counting the ellipsis as extra', () => {
    const out = tailOf('B'.repeat(1000))
    expect(out.length).toBe(TAIL_CHARS + 1)
  })

  it('survives the empty and whitespace-only cases', () => {
    // Reached in practice: a model can emit an empty reasoning delta before its first real one.
    expect(tailOf('')).toBe('')
    expect(tailOf('   \n  ')).toBe('')
  })
})

/**
 * The elapsed-time label on a running generation. It exists because a video takes minutes, and
 * the complaint that produced it was "I wait a long time with no indication of anything".
 */
describe('formatWait', () => {
  it('uses bare seconds under a minute', () => {
    expect(formatWait(0)).toBe('0s')
    expect(formatWait(45)).toBe('45s')
    expect(formatWait(59)).toBe('59s')
  })

  it('pads the seconds so a live counter does not jump width', () => {
    // `2m 5s` and `2m 10s` are different widths, so the label shifts every ten seconds while
    // someone is watching it. Padding keeps it still.
    expect(formatWait(125)).toBe('2m 05s')
    expect(formatWait(130)).toBe('2m 10s')
  })

  it('drops the seconds on a whole minute', () => {
    // The typical-duration estimate is 180s. "usually about 3m 00s" claims a precision nobody
    // has — two padded zeros read as a measured figure rather than a rough one.
    expect(formatWait(60)).toBe('1m')
    expect(formatWait(180)).toBe('3m')
    expect(formatWait(90)).toBe('1m 30s')
  })
})

/**
 * Which tool steps get a row of their own.
 *
 * Reported as "11+ consecutive search_apis calls in ~60s ... never returned", read as a
 * runaway loop. The loop was a separate defect in one model; the READING came from here —
 * every catalogue lookup took a full row, so a handful looked like thrashing.
 *
 * The rule is about money, not tidiness: a step that spends or refuses to spend the user's
 * funds is never collapsed.
 */
describe('partitionSteps', () => {
  const done = (tool: string, extra: Partial<ToolStep> = {}): ToolStep => ({
    tool,
    running: false,
    ...extra,
  })

  it('collapses finished catalogue lookups into a count', () => {
    const { shown, plumbingDone } = partitionSteps([
      done('search_apis'),
      done('search_apis'),
      done('search_apis'),
    ])
    expect(shown).toHaveLength(0)
    expect(plumbingDone).toBe(3)
  })

  it('never treats an outside API call as plumbing, by name alone', () => {
    // The three tests below pass a call_api carrying a price or a refusal flag, so they are
    // satisfied by the money guards and say nothing about the NAME. Adding call_api to the
    // plumbing set left every one of them green. This is the assertion that catches it: a call
    // to a third party is not plumbing even when nothing was recorded against it.
    expect(isPlumbing(done('call_api'))).toBe(false)
  })

  it('keeps a catalogue lookup visible if it was ever refused or declined', () => {
    // Exercises the refusal guard on a PLUMBING-named tool. Passing a refused call_api instead
    // proves nothing, because call_api is not in the plumbing set to begin with — deleting the
    // guard entirely left that test green.
    expect(isPlumbing(done('search_apis', { unpayable: true }))).toBe(false)
    expect(isPlumbing(done('list_models', { declined: true }))).toBe(false)
  })

  it('never collapses a paid call', () => {
    // This is the product's whole claim — an agent paying an outside API mid-conversation.
    // Hiding it would hide a charge.
    const { shown, plumbingDone } = partitionSteps([
      done('search_apis'),
      done('call_api', { spentUsd: 0.00115 }),
    ])
    expect(shown.map((s) => s.tool)).toEqual(['call_api'])
    expect(plumbingDone).toBe(1)
  })

  it('never collapses a refused call', () => {
    // "not called — needs payment" is the answer to "why did nothing happen".
    const { shown } = partitionSteps([done('call_api', { unpayable: true })])
    expect(shown).toHaveLength(1)
  })

  it('never collapses a declined call', () => {
    const { shown } = partitionSteps([done('call_api', { declined: true })])
    expect(shown).toHaveLength(1)
  })

  it('keeps a RUNNING lookup visible', () => {
    // While it is in flight the spinner is the only thing telling the user the turn is alive.
    const { shown, plumbingDone } = partitionSteps([
      done('search_apis'),
      { tool: 'search_apis', running: true },
    ])
    expect(shown).toHaveLength(1)
    expect(shown[0].running).toBe(true)
    expect(plumbingDone).toBe(1)
  })

  it('keeps an unknown tool visible', () => {
    // The plumbing list is an allowlist: a tool nobody classified must not vanish.
    const { shown } = partitionSteps([done('some_future_tool')])
    expect(shown.map((s) => s.tool)).toEqual(['some_future_tool'])
  })

  it('treats a catalogue lookup that somehow charged as chargeable', () => {
    // Defensive: if search_apis ever costs money, the row showing that must not be hidden by
    // the name-based rule.
    expect(isPlumbing(done('search_apis', { spentUsd: 0.0001 }))).toBe(false)
  })

  it('preserves the order of the steps it shows', () => {
    const { shown } = partitionSteps([
      done('call_api', { spentUsd: 0.001 }),
      done('search_apis'),
      done('call_api', { spentUsd: 0.002 }),
    ])
    expect(shown.map((s) => s.spentUsd)).toEqual([0.001, 0.002])
  })
})
