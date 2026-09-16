import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { signPayment } from './wallet'

/**
 * Nothing on a chat turn may wait forever.
 *
 * Reported twice, the second time as "完全就跟死了一样": the page sat with Stop showing and the
 * send button spinning, no answer, no error, and no consent prompt. Measured while diagnosing
 * it, the gateway was not the problem —
 *
 *   anonymous + free model      answered in 10s      (probe EXIT=0)
 *   claude-haiku-4.5 anonymous  402 in 1.08s
 *   invalid key                 401 in 1.28s
 *   glm-4-flash streaming       2.9s, clean [DONE]
 *
 * — so the hang was on our side, in one of three awaits that had no bound:
 *
 *   gateway.ts  await reader.read()                       upstream stops writing
 *   wallet.ts   await provider.request(signTypedData_v4)  popup never appears
 *   wallet.ts   await provider.request(requestAccounts)   same, on connect
 *
 * `busy` clears only in the run's `finally`, so any one of them not settling shows Stop
 * forever. The wallet one is the likeliest: `provider.request` resolves when the user acts and
 * rejects when they decline, but does NEITHER when the popup fails to render — a routine
 * extension state.
 *
 * These tests assert the bounds exist and fire. The idle-vs-total distinction is asserted as
 * source text because it is a design decision a value alone cannot express: a total-duration
 * cap would kill the gateway's own legitimately slow answers, measured at 23-91 seconds to the
 * first content frame.
 */
const gateway = readFileSync(new URL('./gateway.ts', import.meta.url), 'utf8')
const wallet = readFileSync(new URL('./wallet.ts', import.meta.url), 'utf8')

describe('the wallet signature is bounded', () => {
  it('rejects rather than hanging when the wallet never answers', async () => {
    vi.useFakeTimers()
    try {
      // A provider that accepts the request and then does nothing at all — exactly what a
      // popup that never renders looks like from the page's side.
      const stalled = {
        request: vi.fn(({ method }: { method: string }) => {
          if (method === 'eth_accounts') return Promise.resolve(['0xabc'])
          if (method === 'eth_chainId') return Promise.resolve('0x2105')
          return new Promise(() => {})
        }),
      }
      ;(globalThis as unknown as { window: unknown }).window = { ethereum: stalled }

      const challenge = {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '1000',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            payTo: '0xDC59fa7b64988B846e76eC9849bb68f889071506',
            extra: { name: 'USD Coin', version: '2' },
          },
        ],
      }

      const p = signPayment(
        challenge as never,
        'https://api.jarvisclaw.ai/v1/chat/completions',
        { address: '0xabc', chainId: 8453 } as never,
        5,
      )
      // Nothing may be reported before the bound: a signature prompt a user is still reading
      // must not be cancelled underneath them.
      const settledEarly = await Promise.race([
        p.then(() => 'settled').catch(() => 'settled'),
        Promise.resolve('pending'),
      ])
      expect(settledEarly).toBe('pending')

      await vi.advanceTimersByTimeAsync(95_000)
      await expect(p).rejects.toThrow(/did not respond to the signature request/i)
    } finally {
      vi.useRealTimers()
      delete (globalThis as unknown as { window?: unknown }).window
    }
  })
})

describe('the stream read is bounded by SILENCE, not by total duration', () => {
  it('bounds the read at all', () => {
    // The bare `await reader.read()` is what hung. It must go through the wrapper.
    expect(gateway).toContain('await readWithIdleLimit(reader')
    expect(gateway).not.toMatch(/const \{ done, value \} = await reader\.read\(\)/)
  })

  it('measures the gap between bytes rather than the whole answer', () => {
    /**
     * The load-bearing distinction. A 120s TOTAL cap would abort the gateway's own slow-but-
     * working answers — measured 23-91s to the first content frame on the free pool, because a
     * reasoning model spends that time thinking rather than transmitting. The timer must be
     * armed per read and cleared on every settle, which is what makes it an idle bound.
     */
    const at = gateway.indexOf('async function readWithIdleLimit')
    expect(at).toBeGreaterThan(-1)
    const fn = gateway.slice(at, gateway.indexOf('\n}', at))
    expect(fn).toContain('Promise.race')
    expect(fn).toContain('clearTimeout')
  })

  it('cancels the reader when the idle bound fires, not only on abort', async () => {
    /**
     * Behaviour, not source text, and the reason is a survived mutation: the first version
     * asserted the function CONTAINS `reader.cancel()`, and the `finally` block contains a
     * second call for the abort case — so deleting the one inside the timeout left the string
     * present and the guard green.
     *
     * A rejection with the body still open holds the connection and leaves the browser's stream
     * indeterminate, so the cancel has to happen on THIS path specifically.
     */
    vi.useFakeTimers()
    try {
      const cancel = vi.fn(() => Promise.resolve())
      const reader = {
        read: () => new Promise<never>(() => {}),
        cancel,
      } as unknown as ReadableStreamDefaultReader<Uint8Array>

      const { readWithIdleLimit } = await import('./gateway')
      const p = readWithIdleLimit(reader).catch(() => 'rejected')
      expect(cancel).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(125_000)
      expect(await p).toBe('rejected')
      expect(cancel).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows more idle time than the slowest measured legitimate wait', () => {
    const ms = Number(gateway.match(/STREAM_IDLE_LIMIT_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''))
    expect(Number.isFinite(ms)).toBe(true)
    // 91s was measured; anything at or under that would cut off working answers.
    expect(ms).toBeGreaterThan(91_000)
    // And an upper bound, because the point is that "dead" becomes visible: three minutes of
    // silence is indistinguishable from a crash to the person watching.
    expect(ms).toBeLessThanOrEqual(180_000)
  })
})

describe('the wallet bounds are generous enough to read an EIP-712 message', () => {
  it('gives at least a minute', () => {
    const ms = Number(wallet.match(/SIGNATURE_TIMEOUT_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''))
    expect(Number.isFinite(ms)).toBe(true)
    // Checking the amount and the recipient in the wallet's own UI is the entire point of
    // typed-data signing. A 15s bound would punish the careful reader, who is the user this
    // design is for.
    expect(ms).toBeGreaterThanOrEqual(60_000)
  })

  it('bounds the connect prompt too, not only the signature', () => {
    // Same failure mode, different button: a connect popup that never renders left the
    // Connect control spinning with no way back.
    const at = wallet.indexOf("method: 'eth_requestAccounts'")
    expect(at).toBeGreaterThan(-1)
    expect(wallet.slice(Math.max(0, at - 300), at)).toContain('withTimeout(')
  })

  it('does not claim to cancel a wallet prompt it cannot withdraw', () => {
    // There is no EIP-1193 API to withdraw a pending prompt. Reporting a timeout while leaving
    // it signable is the safe direction; the alternative is claiming failure and then having
    // the call succeed anyway. Pinned so a later "cleanup" does not invent a cancel.
    const at = wallet.indexOf('async function withTimeout')
    expect(at).toBeGreaterThan(-1)
    expect(wallet.slice(at, wallet.indexOf('\n}', at))).not.toContain('.cancel()')
  })
})
