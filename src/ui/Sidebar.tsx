import type { SpendPolicy } from '../lib/spend'

export function Sidebar({
  anonymous,
  apiKey,
  baseUrl,
  spend,
  onApiKey,
  onBaseUrl,
}: {
  anonymous: boolean
  apiKey: string
  baseUrl: string
  spend: {
    spentUsd: number
    remainingUsd: number
    history: Array<{ label: string; usd: number }>
    policy: SpendPolicy
  }
  onApiKey: (v: string) => void
  onBaseUrl: (v: string) => void
}) {
  return (
    <aside className="sidebar">
      <section>
        <h2>This session</h2>
        <div className="kv">
          <span>Spent</span>
          <span>${spend.spentUsd.toFixed(6)}</span>
        </div>
        <div className="kv">
          <span>Budget left</span>
          <span>${spend.remainingUsd.toFixed(4)}</span>
        </div>
        <div className="kv">
          <span>Asks above</span>
          <span>${spend.policy.perCallUsd.toFixed(2)}</span>
        </div>
        <div className="kv">
          <span>Stops at</span>
          <span>${spend.policy.sessionUsd.toFixed(2)}</span>
        </div>
      </section>

      {spend.history.length > 0 && (
        <section>
          <h2>Charges</h2>
          <div className="ledger">
            {spend.history.map((e, i) => (
              <div key={i} className="ledger-row">
                <span>{e.label}</span>
                <span>${e.usd.toFixed(6)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Access</h2>
        {anonymous ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' }}>
            Running on the free tier. Free models and catalogue search work with no account.
            Paste a key to reach paid models and callable APIs.
          </p>
        ) : null}
        <label className="field">
          API key
          <input
            type="password"
            value={apiKey}
            placeholder="leave empty for the free tier"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onApiKey(e.target.value)}
          />
        </label>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
          {/* Deliberate: a key can mint more keys and read the account, so persisting it
              in this page would outlive the session on a shared machine. */}
          Kept in this tab only — never saved to your browser.
        </p>
      </section>

      <section>
        <h2>Gateway</h2>
        <label className="field">
          Base URL
          <input
            type="text"
            value={baseUrl}
            spellCheck={false}
            onChange={(e) => onBaseUrl(e.target.value)}
          />
        </label>
        {/*
          The deployed site ships a Content-Security-Policy whose connect-src names the
          gateway explicitly — that is what stops injected script from posting the user's
          key somewhere else. The cost is that a different host is refused by the browser
          with an opaque network error, so it has to be said here rather than discovered.
        */}
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
          A different host works when you run this locally. The hosted build's security
          policy only allows the JarvisClaw gateway.
        </p>
      </section>
    </aside>
  )
}
