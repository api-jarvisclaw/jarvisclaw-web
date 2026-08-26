import { describe, expect, it } from 'vitest'

import { formatWait, tailOf, TAIL_CHARS } from './Transcript'

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
