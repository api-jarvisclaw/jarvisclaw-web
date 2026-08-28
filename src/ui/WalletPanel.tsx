import { useState } from 'react'

import {
  connectWallet,
  hasWallet,
  isUserRejection,
  PER_SIGNATURE_CAP_USDC,
  switchToBase,
  type WalletAccount,
} from '../lib/wallet'
import { useT } from './LocaleContext'

const BASE_CHAIN_ID = 8453

/**
 * Wallet connection, in place of the API-key box.
 *
 * The key box is gone for two reasons. A pasted key is a plaintext bearer credential that
 * can mint more keys and read the account, with no way to scope it to one call. And it never
 * worked from a browser: `Authorization` was not in the gateway's
 * Access-Control-Allow-Headers, so every keyed request was blocked by CORS before leaving
 * the page — anonymous returned 200, keyed returned "Failed to fetch".
 *
 * Nothing here ever sees a private key. The wallet signs a typed message that names the
 * amount, the recipient and the expiry, and shows those to the user itself.
 */
export function WalletPanel({
  account,
  onAccount,
}: {
  account: WalletAccount | null
  onAccount: (a: WalletAccount | null) => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const installed = hasWallet()
  const wrongChain = account !== null && account.chainId !== BASE_CHAIN_ID

  const connect = async () => {
    setBusy(true)
    setError('')
    try {
      onAccount(await connectWallet())
    } catch (err) {
      // Declining is not a failure to report as one — the user chose it, and an error
      // banner for a deliberate "no" trains people to ignore error banners.
      if (!isUserRejection(err)) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const switchChain = async () => {
    setBusy(true)
    setError('')
    try {
      await switchToBase()
      // Re-read rather than assume: the user can approve the prompt and then switch away
      // again, and a remembered chain id would make us sign against the wrong domain.
      onAccount(await connectWallet())
    } catch (err) {
      if (!isUserRejection(err)) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2>{t('Wallet')}</h2>

      {!installed ? (
        <>
          <p>
            Paid models and callable APIs are paid per call in USDC on Base. Install a browser
            wallet to use them — free models work without one.
          </p>
          <a
            className="wallet-btn"
            href="https://rabby.io"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get a wallet
          </a>
        </>
      ) : account === null ? (
        <>
          <p>
            Connect a wallet to reach paid models and callable APIs. Every charge is signed by
            you, in your wallet, showing the exact amount before it happens.
          </p>
          <button className="wallet-btn" onClick={connect} disabled={busy}>
            {busy ? t('Waiting for your wallet…') : t('Connect wallet')}
          </button>
        </>
      ) : (
        <>
          <div className="panel">
            <div className="kv">
              <span>Address</span>
              {/* Middle-truncated, not cut off: the last four characters are how a person
                  recognises their own address. */}
              <span title={account.address}>
                {account.address.slice(0, 6)}…{account.address.slice(-4)}
              </span>
            </div>
            <div className="kv">
              <span>Network</span>
              <span className={wrongChain ? 'wallet-warn' : undefined}>
                {account.chainId === BASE_CHAIN_ID ? 'Base' : `chain ${account.chainId}`}
              </span>
            </div>
            <div className="kv">
              <span>Max per signature</span>
              <span>${PER_SIGNATURE_CAP_USDC.toFixed(2)}</span>
            </div>
          </div>

          {wrongChain && (
            <>
              <p className="wallet-warn">
                Payments settle on Base. Switch network to pay.
              </p>
              <button className="wallet-btn" onClick={switchChain} disabled={busy}>
                {busy ? 'Waiting…' : 'Switch to Base'}
              </button>
            </>
          )}

          <button className="wallet-link" onClick={() => onAccount(null)}>
            {t('Disconnect')}
          </button>
        </>
      )}

      {error !== '' && <p className="wallet-error">{error}</p>}

      <p className="wallet-note">
        {/* Said plainly because it is the whole difference from the old key box. */}
        Your keys stay in your wallet. This page never sees them, and nothing is stored — a
        reload asks again.
      </p>
    </section>
  )
}
