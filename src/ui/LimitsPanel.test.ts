import { describe, expect, it } from 'vitest'

import { format } from './LimitsPanel'

/**
 * These pin a bug found in a browser, not in a test: the panel showed a stored limit of 0.001
 * as "0.00". Zero means "ask about everything" — the opposite of the setting — so the display
 * was actively misleading about how much the page would prompt.
 */
describe('format', () => {
  it('does not round a sub-cent limit down to zero', () => {
    // The failure exactly as observed. toFixed(2) produced "0.00" here.
    expect(format(0.001)).toBe('0.001')
    expect(format(0.0005)).toBe('0.0005')
  })

  it('keeps two decimals for ordinary amounts', () => {
    // The fix's own trap: plain String(1) gives "1", which next to a $ reads as unset.
    expect(format(1)).toBe('1.00')
    expect(format(5)).toBe('5.00')
    expect(format(0.05)).toBe('0.05')
    expect(format(0.4)).toBe('0.40')
  })

  it('shows a real zero as zero', () => {
    // Zero is a legitimate setting — "ask me about everything" — and must be distinguishable
    // from the rounding artefact above.
    expect(format(0)).toBe('0.00')
  })

  it('does not render NaN into the input', () => {
    // An input whose value is the string "NaN" cannot be corrected by typing in some browsers.
    expect(format(Number.NaN)).toBe('0.00')
    expect(format(Number.POSITIVE_INFINITY)).toBe('0.00')
  })
})
