import { ExternalLinkIcon, KeyIcon, RefreshCwIcon, UserIcon, UserPlusIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  canUseAccount,
  KEYS_URL,
  listKeys,
  quotaToUsd,
  revealKey,
  SIGN_IN_URL,
  SIGN_UP_URL,
  whoami,
  type Account,
  type ApiKeyRef,
} from '../lib/account'
import { CANONICAL_HOST } from '../lib/host'

/**
 * Sign in with a main-site account, and pick one of its API keys.
 *
 * This is the answer to "how do my existing users use this?". Before it, the console only spoke
 * wallet: a customer with quota already on the platform had no way to spend it here.
 *
 * Sign-in happens ON THE PLATFORM, in a new tab — deliberately, and it is worth being explicit
 * about why. This page could render a username and password form and POST it to /api/user/login;
 * the CORS policy would even allow it. It must not. A page asking for platform credentials
 * teaches users that any page may ask for platform credentials, which is the whole mechanic of a
 * phishing site. The real login page is the only place those belong, and it is also where OAuth
 * and passkeys live. So: send them there, then read the session.
 */
export function AccountPanel({
  account,
  keyName,
  onAccount,
  onKey,
}: {
  account: Account | null
  keyName: string | null
  /** The signed-in account, or null after signing out. */
  onAccount: (a: Account | null) => void
  /** The selected key's secret and its label, or null to clear it. */
  onKey: (v: { key: string; name: string } | null) => void
}) {
  const [checking, setChecking] = useState(true)
  const [keys, setKeys] = useState<ApiKeyRef[]>([])
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async () => {
    setChecking(true)
    const found = await whoami()
    onAccount(found)
    setChecking(false)
    return found
  }, [onAccount])

  // Checked once on mount. Not polled: a session that appears while the tab sits idle is what
  // the "I've signed in" button is for, and polling a credentialed endpoint on a timer is
  // traffic with no user behind it.
  useEffect(() => {
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadKeys = useCallback(
    async (userId: number) => {
      setLoadingKeys(true)
      setError(null)
      try {
        setKeys(await listKeys({ userId }))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingKeys(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (account) void loadKeys(account.id)
    else setKeys([])
  }, [account, loadKeys])

  const pick = async (k: ApiKeyRef) => {
    if (!account) return
    setError(null)
    try {
      const secret = await revealKey({ userId: account.id, keyId: k.id })
      onKey({ key: secret, name: k.name })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (checking) {
    return (
      <section>
        <h2>Account</h2>
        <div className="panel">
          <p className="panel-note">Checking for a signed-in session…</p>
        </div>
      </section>
    )
  }

  if (!account) {
    const available = canUseAccount()
    return (
      <section>
        <h2>Account</h2>
        <div className="panel">
          <p className="account-blurb">
            Sign in to use quota you already have on JarvisClaw. Your key works here exactly as it
            does on the platform.
          </p>
          {/* "Sign in to JarvisClaw", not "Sign in on api.jarvisclaw.ai".
              The host used to be in the label because the button pointed at a DIFFERENT host than
              it named, and deriving the name from the href was the fix for that. But the honest
              reading of the original problem is that a hostname was never the useful thing to say:
              nobody has an account "on api.jarvisclaw.ai", they have one on JarvisClaw. The href is
              still derived from one constant, so the two cannot drift; the label now names the
              product, and the destination is visible in the browser once the tab opens. */}
          <a className="panel-btn" href={SIGN_IN_URL} target="_blank" rel="noopener noreferrer">
            <UserIcon size={14} aria-hidden="true" />
            Sign in to JarvisClaw
            <ExternalLinkIcon size={12} aria-hidden="true" />
          </a>
          {/* The missing half. Sign-in is useless to someone who has no account, and this panel
              offered them nothing but a form they cannot fill — a dead end at exactly the moment a
              new visitor is deciding whether this product is for them. The platform's own sign-in
              page does carry a "Sign up" link, but it is below the form and reached only after the
              user has already gone looking; naming the choice here means they never have to guess
              which of the two they need. */}
          <a
            className="panel-btn panel-btn-quiet"
            href={SIGN_UP_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <UserPlusIcon size={14} aria-hidden="true" />
            New here? Create an account
            <ExternalLinkIcon size={12} aria-hidden="true" />
          </a>
          {available ? (
            // Needed because sign-in happens in another tab: nothing tells this page when it
            // finished, and without a way to re-check the user would have to reload. It covers
            // registering too — a new account is signed in by the time the tab closes.
            <button className="panel-btn panel-btn-quiet" onClick={() => void check()}>
              <RefreshCwIcon size={14} aria-hidden="true" />
              I've signed in
            </button>
          ) : (
            // Said plainly instead of offering a button that cannot work. Reading the session is
            // a credentialed request, and the gateway only accepts those from whitelisted
            // origins — so on any other origin the check is not slow or flaky, it is impossible.
            <p className="panel-note">
              Reading your session only works from {CANONICAL_HOST}. On this origin, paste-free
              sign-in is unavailable — use a wallet, or the free models.
            </p>
          )}
          <p className="panel-note">
            No account needed for free models, or to pay per call with a wallet.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section>
      <h2>Account</h2>
      <div className="panel">
        <div className="kv">
          <span>Signed in</span>
          <span className="account-name">{account.displayName}</span>
        </div>
        <div className="kv">
          <span>Balance</span>
          {/* The platform's own quota, converted. Showing a raw six-digit quota where someone
              expects a balance is how "why does it say 1500000" gets asked. */}
          <span className="price">${quotaToUsd(account.quota).toFixed(4)}</span>
        </div>

        <div className="account-keys">
          <div className="account-keys-head">
            <span>API key</span>
            {keyName !== null && (
              <button className="link-btn" onClick={() => onKey(null)}>
                use wallet instead
              </button>
            )}
          </div>

          {keyName !== null ? (
            <p className="account-active">
              <KeyIcon size={13} aria-hidden="true" />
              <span className="tool-name">{keyName}</span>
              {/* The secret itself is never rendered. It is a bearer credential; showing it
                  invites a screenshot, and the user already has it on the platform. */}
              <span className="account-hint">in use for paid calls</span>
            </p>
          ) : loadingKeys ? (
            <p className="panel-note">Loading your keys…</p>
          ) : keys.length === 0 ? (
            <p className="panel-note">
              This account has no API keys yet.{' '}
              <a href={KEYS_URL} target="_blank" rel="noopener noreferrer">
                Make one
              </a>
              .
            </p>
          ) : (
            <div className="account-key-list">
              {keys.map((k) => {
                const unusable = k.expired || k.exhausted
                return (
                  <button
                    key={k.id}
                    className="account-key"
                    onClick={() => void pick(k)}
                    // Offered but disabled, with the reason. Hiding it would leave someone
                    // hunting for a key they know exists.
                    disabled={unusable}
                    title={
                      k.expired
                        ? 'This key has expired'
                        : k.exhausted
                          ? 'This key has no quota left'
                          : undefined
                    }
                  >
                    <span className="account-key-name">{k.name}</span>
                    <span className={unusable ? 'account-key-note is-bad' : 'account-key-note'}>
                      {k.expired
                        ? 'expired'
                        : k.exhausted
                          ? 'no quota'
                          : k.unlimited
                            ? 'unlimited'
                            : `$${quotaToUsd(k.remainQuota ?? 0).toFixed(4)}`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {error !== null && <p className="account-error">{error}</p>}

        <button
          className="panel-btn panel-btn-quiet"
          onClick={() => {
            onKey(null)
            onAccount(null)
          }}
        >
          Sign out
        </button>
        <p className="panel-note">
          The key is held for this tab only and never saved. Signing out drops it.
        </p>
      </div>
    </section>
  )
}
