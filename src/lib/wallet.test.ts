import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  base64Utf8,
  connectWallet,
  isUserRejection,
  PER_SIGNATURE_CAP_USDC,
  selectEvmRequirement,
  signPayment,
  type WalletAccount,
} from './wallet'

const BASE = { address: '0xAbC0000000000000000000000000000000000001', chainId: 8453 } as WalletAccount
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** A wallet that records what it was asked and answers with a fixed signature. */
function stubWallet(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ method: string; params?: unknown }> = []
  const provider = {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params })
      if (method in overrides) {
        const v = overrides[method]
        if (v instanceof Error) throw v
        return v
      }
      if (method === 'eth_requestAccounts') return [BASE.address]
      if (method === 'eth_chainId') return '0x2105'
      if (method === 'eth_signTypedData_v4') return `0x${'ab'.repeat(32)}1b`
      return null
    }),
  }
  vi.stubGlobal('window', { ethereum: provider })
  return { provider, calls }
}

function challenge(over: Record<string, unknown> = {}) {
  return {
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '64000',
        asset: USDC,
        payTo: '0xDC59fa7b64988B846e76eC9849bb68f889071506',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
        ...over,
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('selectEvmRequirement', () => {
  it('picks the EVM option when the gateway also quotes Solana', () => {
    // The gateway quotes both chains. Taking accepts[0] blindly would hand a Solana
    // requirement to an EVM wallet and fail with a signature error that says nothing about
    // the real problem.
    const both = {
      accepts: [
        { network: 'solana:mainnet', amount: '1000', payTo: 'So1...' },
        { network: 'eip155:8453', amount: '2000', payTo: '0xdead' },
      ],
    }
    expect(selectEvmRequirement(both).network).toBe('eip155:8453')
  })

  it('says a browser wallet cannot pay a Solana-only quote', () => {
    const solanaOnly = { accepts: [{ network: 'solana:mainnet', amount: '1000', payTo: 'So1' }] }
    expect(() => selectEvmRequirement(solanaOnly)).toThrow(/no EVM payment option/)
  })

  it('does not crash on a challenge with no accepts array', () => {
    expect(() => selectEvmRequirement({})).toThrow(/no EVM payment option/)
  })
})

describe('connectWallet', () => {
  it('reports a missing wallet as something the user can act on', async () => {
    vi.stubGlobal('window', {})
    await expect(connectWallet()).rejects.toThrow(/No wallet found/)
  })

  it('returns the address and chain', async () => {
    stubWallet()
    await expect(connectWallet()).resolves.toEqual({ address: BASE.address, chainId: 8453 })
  })

  it('refuses an empty account list rather than returning undefined', async () => {
    stubWallet({ eth_requestAccounts: [] })
    await expect(connectWallet()).rejects.toThrow(/no account/)
  })

  it('refuses an unparseable chain id', async () => {
    stubWallet({ eth_chainId: 'not-hex' })
    await expect(connectWallet()).rejects.toThrow(/unreadable chain id/)
  })
})

describe('signPayment', () => {
  it('signs a typed message naming the exact amount, recipient and expiry', async () => {
    const { calls } = stubWallet()
    const signed = await signPayment(challenge(), 'https://api.jarvisclaw.ai/v1/images/generations', BASE)

    const sig = calls.find((c) => c.method === 'eth_signTypedData_v4')
    expect(sig).toBeDefined()
    const [addr, json] = (sig!.params as [string, string])
    expect(addr).toBe(BASE.address)

    // The wallet displays this message to the user, so these fields ARE the consent.
    const typed = JSON.parse(json) as {
      primaryType: string
      domain: { chainId: number; verifyingContract: string }
      message: Record<string, string>
    }
    expect(typed.primaryType).toBe('TransferWithAuthorization')
    expect(typed.domain.chainId).toBe(8453)
    expect(typed.domain.verifyingContract).toBe(USDC)
    expect(typed.message.to).toBe('0xDC59fa7b64988B846e76eC9849bb68f889071506')
    expect(typed.message.value).toBe('64000')
    expect(typed.message.from).toBe(BASE.address)

    expect(signed.usd).toBeCloseTo(0.064, 6)
  })

  it('produces the x402 v2 payload the gateway reads', async () => {
    stubWallet()
    // The gateway peeks at `accepted.network` and falls back to a top-level `network` for
    // v1. A v1-shaped payload would be routed and priced from the wrong field.
    const signed = await signPayment(challenge(), 'https://api.jarvisclaw.ai/v1/chat/completions', BASE)
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(signed.header), (c) => c.charCodeAt(0)))) as {
      x402Version: number
      accepted: Record<string, unknown>
      payload: { signature: string; authorization: Record<string, string> }
    }
    expect(payload.x402Version).toBe(2)
    expect(payload.accepted.network).toBe('eip155:8453')
    expect(payload.accepted.amount).toBe('64000')
    expect(payload.payload.signature).toMatch(/^0x/)
    expect(payload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/)
    // Backdated on purpose: a signature stamped exactly "now" can be refused by a
    // facilitator whose clock is a second behind.
    expect(Number(payload.payload.authorization.validAfter)).toBeLessThan(
      Number(payload.payload.authorization.validBefore),
    )
  })

  it('uses a fresh nonce for every signature', async () => {
    // A reused nonce is a replay: the gateway has already had one signature serve two
    // requests 0.12s apart, and the guard for that is on the server. The client must not
    // manufacture the case.
    stubWallet()
    const a = await signPayment(challenge(), 'https://x/1', BASE)
    const b = await signPayment(challenge(), 'https://x/1', BASE)
    expect(a.header).not.toBe(b.header)
  })

  it('refuses to sign above the per-signature cap', async () => {
    // A signature is an irreversible transfer authorisation, so the cap lives in the
    // function that produces one — not only in a dialog, which a bug can bypass.
    stubWallet()
    const tooMuch = challenge({ amount: String((PER_SIGNATURE_CAP_USDC + 1) * 1_000_000) })
    await expect(signPayment(tooMuch, 'https://x', BASE)).rejects.toThrow(/per-signature cap/)
  })

  it('refuses a zero or negative amount', async () => {
    stubWallet()
    await expect(signPayment(challenge({ amount: '0' }), 'https://x', BASE)).rejects.toThrow(/invalid amount/)
    await expect(signPayment(challenge({ amount: '-5' }), 'https://x', BASE)).rejects.toThrow(/invalid amount/)
  })

  it('refuses an asset that is not USDC', async () => {
    // Signing a TransferWithAuthorization against an unknown contract is signing away an
    // unknown token.
    stubWallet()
    const other = challenge({ asset: '0x0000000000000000000000000000000000000bad' })
    await expect(signPayment(other, 'https://x', BASE)).rejects.toThrow(/other than USDC/)
  })

  it('refuses an empty recipient', async () => {
    stubWallet()
    await expect(signPayment(challenge({ payTo: '' }), 'https://x', BASE)).rejects.toThrow(/no recipient/)
  })

  it('refuses to sign when the wallet is on a different chain', async () => {
    // Signing with the wrong domain chainId produces a signature that verifies nowhere —
    // the user would approve a prompt and get an opaque settlement failure.
    stubWallet()
    const wrongChain = { ...BASE, chainId: 1 }
    await expect(signPayment(challenge(), 'https://x', wrongChain)).rejects.toThrow(/on chain 1/)
  })

  it('refuses an unrecognised network', async () => {
    stubWallet()
    await expect(
      signPayment(challenge({ network: 'eip155:notanumber' }), 'https://x', BASE),
    ).rejects.toThrow(/Unrecognised network/)
  })

  it('refuses a wallet that returns no signature', async () => {
    stubWallet({ eth_signTypedData_v4: null })
    await expect(signPayment(challenge(), 'https://x', BASE)).rejects.toThrow(/no signature/)
  })

  it('never asks the wallet for a private key or a raw account export', async () => {
    // The property that matters most here. Only signing and account discovery are ever
    // requested; anything resembling key extraction would be a hard defect.
    const { calls } = stubWallet()
    await signPayment(challenge(), 'https://x', BASE)
    const methods = calls.map((c) => c.method)
    for (const method of methods) {
      expect(method).not.toMatch(/privatekey|private_key|exportaccount|eth_sign$|personal_sign/i)
    }
    expect(methods).toContain('eth_signTypedData_v4')
  })
})

describe('base64Utf8', () => {
  it('encodes non-Latin-1 text that btoa alone would throw on', () => {
    // A description or extra field can carry any character; btoa throws above U+00FF.
    expect(() => base64Utf8('价格 · 支付')).not.toThrow()
    const encoded = base64Utf8('价格')
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)))
    expect(decoded).toBe('价格')
  })
})

describe('isUserRejection', () => {
  it('recognises EIP-1193 code 4001', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true)
  })

  it('recognises wallets that only set a message', () => {
    expect(isUserRejection(new Error('MetaMask Tx Signature: User denied transaction signature.'))).toBe(true)
    expect(isUserRejection(new Error('User rejected the request.'))).toBe(true)
  })

  it('does not mistake a real failure for a refusal', () => {
    // Declining must be reported as declining, and a breakage as a breakage. Conflating
    // them would hide a broken payment path behind "you cancelled".
    expect(isUserRejection(new Error('network error'))).toBe(false)
    expect(isUserRejection({ code: -32603 })).toBe(false)
  })
})
