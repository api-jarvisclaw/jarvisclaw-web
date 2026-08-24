/**
 * Wallet payments, signed in the visitor's own wallet.
 *
 * This replaces the API-key box. Two reasons, and the second is the one that settles it:
 *
 *  1. A key pasted into a page is a bearer credential in plaintext — it can mint more keys
 *     and read the account, and the user has no way to scope it to one call.
 *  2. The key box never worked from a browser anyway. `Authorization` was not in the
 *     gateway's Access-Control-Allow-Headers, so every keyed request was blocked by CORS
 *     before it left the page. Measured from the deployed site: anonymous 200, keyed
 *     "Failed to fetch". It was UI in front of a wall.
 *
 * Here the private key never leaves the wallet extension. The page asks for a signature
 * over a typed EIP-712 message that names the exact amount, recipient and expiry; the
 * wallet shows those to the user and returns a signature. Nothing else is requested, and
 * there is no path by which this code could read a key.
 */

/** USDC on Base — the only asset the gateway settles in. */
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_NAME = 'USD Coin'
const USDC_VERSION = '2'

/**
 * Refuse anything above this in one call, whatever the gateway quoted.
 *
 * A signature is an irreversible transfer authorisation. The same cap exists in the Python
 * SDK; a browser page reachable by anyone needs it more, not less.
 */
export const PER_SIGNATURE_CAP_USDC = 5

const CHAIN_IDS: Record<string, number> = {
  'eip155:8453': 8453, // Base mainnet
  'eip155:84532': 84532, // Base Sepolia
}

/** The subset of EIP-1193 this needs. Deliberately narrow. */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && window.ethereum !== undefined
}

export interface WalletAccount {
  address: string
  chainId: number
}

/**
 * Asks the wallet to connect.
 *
 * `eth_requestAccounts` is the only method that prompts; it is called from a click handler
 * because wallets reject it otherwise. Nothing is stored: the address lives in component
 * state, and a reload asks again. That is deliberate — a page that silently reconnects a
 * wallet is a page that can spend without the user opening it.
 */
export async function connectWallet(): Promise<WalletAccount> {
  const provider = window.ethereum
  if (!provider) {
    throw new Error('No wallet found. Install a browser wallet such as MetaMask or Rabby.')
  }

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts?.[0]
  if (typeof address !== 'string' || address === '') {
    throw new Error('The wallet returned no account.')
  }

  const rawChain = (await provider.request({ method: 'eth_chainId' })) as string
  const chainId = Number.parseInt(rawChain, 16)
  if (!Number.isFinite(chainId)) {
    throw new Error('The wallet returned an unreadable chain id.')
  }

  return { address, chainId }
}

/** Asks the wallet to switch to Base, adding it if the wallet does not know it. */
export async function switchToBase(): Promise<void> {
  const provider = window.ethereum
  if (!provider) throw new Error('No wallet found.')
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x2105' }],
    })
  } catch (err) {
    // 4902 = the wallet does not have this chain. Adding it is the documented recovery;
    // any other error (including the user declining) must propagate rather than be
    // retried as an add, which would prompt twice for one refusal.
    const code = (err as { code?: number }).code
    if (code !== 4902) throw err
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0x2105',
          chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org'],
        },
      ],
    })
  }
}

/** One `accepts` entry from a 402 challenge. */
export interface PaymentRequirement {
  scheme?: string
  network?: string
  amount?: string
  maxAmountRequired?: string
  asset?: string
  payTo?: string
  maxTimeoutSeconds?: number
  extra?: Record<string, unknown>
}

export interface Challenge {
  accepts?: PaymentRequirement[]
  [key: string]: unknown
}

/**
 * Picks the requirement this wallet can actually pay.
 *
 * EVM only: the gateway also quotes Solana, which a browser EVM wallet cannot sign. Taking
 * `accepts[0]` blindly would hand a Solana requirement to MetaMask and fail with a
 * signature error that says nothing about the real problem.
 */
export function selectEvmRequirement(challenge: Challenge): PaymentRequirement {
  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : []
  const evm = accepts.find((a) => typeof a.network === 'string' && a.network.startsWith('eip155:'))
  if (!evm) {
    throw new Error('The gateway quoted no EVM payment option, so a browser wallet cannot pay it.')
  }
  return evm
}

export interface SignedPayment {
  /** base64 payload for the X-PAYMENT header. */
  header: string
  /** Dollars, for the ledger and the consent record. */
  usd: number
}

function atomicToUsd(atomic: string): number {
  const n = Number(atomic)
  return Number.isFinite(n) ? n / 1_000_000 : NaN
}

function randomNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Signs one payment authorisation and returns the X-PAYMENT header.
 *
 * The payload shape mirrors the Python SDK's x402 v2 format exactly (jarvisclaw/x402.py):
 * the gateway reads `accepted.network` and `payload.authorization`, and a v1-shaped payload
 * would be priced from the wrong field.
 *
 * Every value the user is agreeing to is inside the typed message the wallet displays —
 * amount, recipient, expiry. That is the whole point of EIP-712 over a blind hash: the
 * consent happens in the wallet's own UI, not in ours.
 */
export async function signPayment(
  challenge: Challenge,
  resourceUrl: string,
  account: WalletAccount,
  /**
   * The user's own per-signature cap, when they have set one.
   *
   * Passed in rather than read from storage here: this module must stay callable from a test
   * and from a non-browser context, and a function that silently consults localStorage for a
   * safety limit is one whose behaviour cannot be reasoned about at the call site.
   *
   * Absent means the built-in cap. A supplied value is still bounded by it below — the
   * setting can only ever be as permissive as the hard ceiling, never more.
   */
  capUsd: number = PER_SIGNATURE_CAP_USDC,
): Promise<SignedPayment> {
  const provider = window.ethereum
  if (!provider) throw new Error('No wallet found.')

  const req = selectEvmRequirement(challenge)
  const network = req.network ?? 'eip155:8453'
  const payTo = req.payTo ?? ''
  const amount = String(req.amount ?? req.maxAmountRequired ?? '0')
  const asset = req.asset ?? USDC_BASE
  const maxTimeout = typeof req.maxTimeoutSeconds === 'number' ? req.maxTimeoutSeconds : 300

  if (payTo === '') throw new Error('The gateway quoted no recipient address.')

  const atomic = Number(amount)
  if (!Number.isFinite(atomic) || atomic <= 0) {
    throw new Error(`The gateway quoted an invalid amount (${amount}).`)
  }
  const usd = atomicToUsd(amount)
  // The user's cap, but never looser than the built-in one. Taking the minimum rather than
  // trusting the argument is what keeps a tampered localStorage value — or a caller that
  // forgot to validate — from raising the ceiling this function exists to enforce.
  const effectiveCap = Math.min(
    PER_SIGNATURE_CAP_USDC,
    Number.isFinite(capUsd) && capUsd > 0 ? capUsd : PER_SIGNATURE_CAP_USDC,
  )
  if (usd > effectiveCap) {
    // Checked here as well as in the UI, because this is the function that produces a
    // spendable signature. A cap enforced only by a dialog is a cap that a bug bypasses.
    throw new Error(
      `Refusing to sign $${usd.toFixed(2)} — above your $${effectiveCap.toFixed(2)} per-signature cap. Raise it in Limits if you meant to.`,
    )
  }
  if (asset.toLowerCase() !== USDC_BASE.toLowerCase()) {
    throw new Error('The gateway quoted an asset other than USDC, which this page will not sign for.')
  }

  const chainId = CHAIN_IDS[network] ?? Number.parseInt(network.split(':')[1] ?? '', 10)
  if (!Number.isFinite(chainId)) {
    throw new Error(`Unrecognised network ${network}.`)
  }
  if (account.chainId !== chainId) {
    throw new Error(
      `Your wallet is on chain ${account.chainId} but this payment is on ${chainId}. Switch network and try again.`,
    )
  }

  const nowSec = Math.floor(Date.now() / 1000)
  // validAfter is backdated: a signature stamped exactly "now" can be rejected by a
  // facilitator whose clock is a second behind. The SDK backdates by the same 600s.
  const validAfter = String(nowSec - 600)
  const validBefore = String(nowSec + maxTimeout)
  const nonce = randomNonce()

  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    domain: {
      name: (req.extra?.name as string) ?? USDC_NAME,
      version: (req.extra?.version as string) ?? USDC_VERSION,
      chainId,
      verifyingContract: asset,
    },
    message: {
      from: account.address,
      to: payTo,
      value: amount,
      validAfter,
      validBefore,
      nonce,
    },
  }

  const signature = (await provider.request({
    method: 'eth_signTypedData_v4',
    // Order matters and the data must be a string: some wallets reject an object here.
    params: [account.address, JSON.stringify(typedData)],
  })) as string

  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new Error('The wallet returned no signature.')
  }

  const payload = {
    x402Version: 2,
    resource: { url: resourceUrl, description: 'API request', mimeType: 'application/json' },
    accepted: {
      scheme: req.scheme ?? 'exact',
      network,
      amount,
      asset,
      payTo,
      maxTimeoutSeconds: maxTimeout,
      extra: req.extra && Object.keys(req.extra).length > 0
        ? req.extra
        : { name: USDC_NAME, version: USDC_VERSION },
    },
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: payTo,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
    },
    extensions: {},
  }

  return { header: base64Utf8(JSON.stringify(payload)), usd }
}

/**
 * base64 of a UTF-8 string.
 *
 * `btoa` alone throws on any character above U+00FF, and a description or extra field can
 * carry one. Encoding to UTF-8 bytes first is what makes this safe for arbitrary content.
 */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** True when the wallet reported the user rejecting the prompt, rather than a real failure. */
export function isUserRejection(err: unknown): boolean {
  const code = (err as { code?: number }).code
  // 4001 is EIP-1193's "user rejected request". Some wallets only set the message.
  if (code === 4001) return true
  const message = err instanceof Error ? err.message.toLowerCase() : ''
  return message.includes('user rejected') || message.includes('user denied')
}
