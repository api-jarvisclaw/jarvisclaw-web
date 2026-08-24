import type { Settings } from '../lib/settings'
import type { SpendPolicy } from '../lib/spend'
import type { WalletAccount } from '../lib/wallet'
import { LimitsPanel } from './LimitsPanel'
import { WalletPanel } from './WalletPanel'

export function Sidebar({
  wallet,
  spend,
  settings,
  onSettings,
  onWallet,
}: {
  wallet: WalletAccount | null
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
