import { useEffect, useState } from 'react'

import {
  connectWallet,
  hasWallet,
  isUserRejection,
  listWallets,
  PER_SIGNATURE_CAP_USDC,
  startWalletDiscovery,
  switchToBase,
  type WalletAccount,
  type WalletOption,
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
  const [wallets, setWallets] = useState<WalletOption[]>(() => listWallets())

  // Wallets announce synchronously on request, but one that finishes loading later announces on
  // its own — so re-read shortly after, instead of freezing the list at first render.
  useEffect(() => {
    startWalletDiscovery()
    setWallets(listWallets())
    const late = setTimeout(() => setWallets(listWallets()), 500)
    return () => clearTimeout(late)
  }, [])

  const installed = hasWallet()
  const wrongChain = account !== null && account.chainId !== BASE_CHAIN_ID

  const connect = async (uuid?: string) => {
    setBusy(true)
    setError('')
    try {
      onAccount(await connectWallet(uuid))
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
            {t('Paid models and callable APIs are paid per call in USDC on Base. Install a browser wallet to use them — free models work without one.')}
          </p>
          <a
            className="wallet-btn"
            href="https://rabby.io"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('Get a wallet')}
          </a>
        </>
      ) : account === null ? (
        <>
          <p>
            {t('Connect a wallet to reach paid models and callable APIs. Every charge is signed by you, in your wallet, showing the exact amount before it happens.')}
          </p>
          {wallets.length > 1 ? (
            // One button per wallet. With several installed, window.ethereum belongs to whichever
            // loaded last, and that one can be broken while the others work.
            <div className="wallet-choices">
              {wallets.map((w) => (
                <button
                  key={w.uuid}
                  className="wallet-btn"
                  onClick={() => void connect(w.uuid)}
                  disabled={busy}
                >
                  {w.icon !== '' && <img src={w.icon} alt="" width={18} height={18} />}
                  {t('Connect {name}', { name: w.name })}
                </button>
              ))}
            </div>
          ) : (
            <button
              className="wallet-btn"
              onClick={() => void connect(wallets[0]?.uuid)}
              disabled={busy}
            >
              {busy ? t('Waiting for your wallet…') : t('Connect wallet')}
            </button>
          )}
          {busy && wallets.length > 1 && <p>{t('Waiting for your wallet…')}</p>}
        </>
      ) : (
        <>
          <div className="panel">
            <div className="kv">
              <span>{t('Address')}</span>
              {/* Middle-truncated, not cut off: the last four characters are how a person
                  recognises their own address. */}
              <span title={account.address}>
                {account.address.slice(0, 6)}…{account.address.slice(-4)}
              </span>
            </div>
            <div className="kv">
              <span>{t('Network')}</span>
              <span className={wrongChain ? 'wallet-warn' : undefined}>
                {account.chainId === BASE_CHAIN_ID ? 'Base' : `chain ${account.chainId}`}
              </span>
            </div>
            <div className="kv">
              <span>{t('Max per signature')}</span>
              <span>${PER_SIGNATURE_CAP_USDC.toFixed(2)}</span>
            </div>
          </div>

          {wrongChain && (
            <>
              <p className="wallet-warn">
                {t('Payments settle on Base. Switch network to pay.')}
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
        {t('Your keys stay in your wallet. This page never sees them, and nothing is stored — a reload asks again.')}
      </p>
    </section>
  )
}
