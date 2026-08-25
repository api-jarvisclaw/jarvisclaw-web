import { describe, expect, it } from 'vitest'

import { formatWait } from './Transcript'

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
