import type { Account } from '../lib/account'
import type { Settings } from '../lib/settings'
import type { SpendPolicy } from '../lib/spend'
import type { WalletAccount } from '../lib/wallet'
import { AccountPanel } from './AccountPanel'
import { LimitsPanel } from './LimitsPanel'
import { WalletPanel } from './WalletPanel'

export function Sidebar({
  wallet,
  spend,
  settings,
  account,
  keyName,
  onSettings,
  onAccount,
  onKey,
  onWallet,
}: {
  wallet: WalletAccount | null
  account: Account | null
  keyName: string | null
  onAccount: (a: Account | null) => void
  onKey: (v: { key: string; name: string } | null) => void
  spend: {
    spentUsd: number
    remainingUsd: number
    history: Array<{ label: string; usd: number }>
    policy: SpendPolicy
  }
  settings: Settings
  onSettings: (next: Settings) => void
  onWallet: (a: WalletAccount | null) => void
}) {
  const budget = spend.policy.sessionUsd
  const usedPct = budget > 0 ? Math.min(100, Math.max(0, (spend.spentUsd / budget) * 100)) : 0

  return (
    <aside className="sidebar">
      <section>
        <h2>This session</h2>
        <div className="panel">
          <div className="kv kv-spent">
            <span>Spent</span>
            <span>${spend.spentUsd.toFixed(6)}</span>
          </div>
          <div className="kv kv-left">
            <span>Budget left</span>
            <span>${spend.remainingUsd.toFixed(4)}</span>
          </div>
          {/* Clamped both ways: a spend that somehow exceeded the budget would otherwise
              render a bar wider than its track, and a zero budget divides to Infinity. */}
          <div
            className="meter"
            role="progressbar"
            aria-label="Session budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usedPct)}
          >
            <div className="meter-fill" style={{ width: `${usedPct}%` }} />
          </div>
          {/* The thresholds themselves live in Limits below, where they can be changed.
              Repeating them read-only here left the reader with two places showing the same
              number and only one that responds — which looks like the edit did not take. */}
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

      {/* Account first, wallet second. Deliberate ordering: an existing customer's answer to
          "how do I pay" is their account, and putting the wallet above it implies installing an
          extension is the primary path. A key is also strictly simpler — no signatures at all. */}
      <AccountPanel account={account} keyName={keyName} onAccount={onAccount} onKey={onKey} />

      <WalletPanel account={wallet} onAccount={onWallet} />

      <LimitsPanel settings={settings} onChange={onSettings} />

      {/*
        No gateway field. Which host this talks to is not a user's decision — it is
        infrastructure, and putting it in the sidebar invited someone to point a page that
        signs payments at a host of their choosing. The deployed CSP would refuse any other
        origin anyway, so the input could only ever break the app or mislead.

        Local development overrides it with VITE_GATEWAY_URL instead (see lib/gateway.ts).
      */}
    </aside>
  )
}
