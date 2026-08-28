import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export interface PendingSpend {
  tool: string
  description: string
  usd: number
  remainingUsd: number
  /** Resolves the promise the agent loop is awaiting. */
  resolve: (approved: boolean) => void
}

/**
 * Asks about one charge, before it happens.
 *
 * The amount shown is the price the catalogue quoted, read before the call was made —
 * not an estimate. A charge the user learns about afterwards is not one they consented
 * to, which is why the price lookup failing refuses the call rather than proceeding.
 */
export function ConsentDialog({
  pending,
  onDecide,
}: {
  pending: PendingSpend
  onDecide: (approved: boolean) => void
}) {
  const declineRef = useRef<HTMLButtonElement>(null)

  // Focus starts on Decline, and Escape declines. The safe choice is the default for
  // anything that spends money.
  useEffect(() => {
    declineRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDecide(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecide])

  /**
   * Portalled to `document.body`, and this is the dialog where it matters most.
   *
   * `.scrim` is `position: fixed; z-index: 10`, but it was rendered inside `.shell`
   * (`position: relative; z-index: 1`) — a stacking context, so that 10 only ranked it against its
   * own siblings while the whole shell competed as one `z: 1` layer. `.topbar` at `z: 2` won.
   * Measured with this dialog open: elementFromPoint(960, 60) returned HEADER.topbar and
   * (200, 600) returned DIV.rail-list.
   *
   * This is the gate in front of a paid call. A backdrop you can click behind is a consent prompt
   * that can be worked around, and no z-index value escapes a stacking context — leaving it is the
   * only fix. The role/aria stay on the scrim element itself rather than moving to the shared
   * Scrim component, because this dialog labels itself and the others label their inner panel.
   */
  return createPortal(
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      onClick={(e) => {
        // Clicking the backdrop declines rather than dismissing silently, so the agent's
        // await always resolves.
        if (e.target === e.currentTarget) onDecide(false)
      }}
    >
      <div className="dialog">
        <h3 id="consent-title">Approve this charge?</h3>
        <p>{pending.description}</p>
        <div className="amount">${pending.usd.toFixed(6)}</div>
        <p>
          ${pending.remainingUsd.toFixed(4)} left of your session budget. Paid in USDC from your
          wallet.
        </p>
        <div className="dialog-actions">
          <button ref={declineRef} className="decline" onClick={() => onDecide(false)}>
            Don't spend
          </button>
          <button className="approve" onClick={() => onDecide(true)}>
            Approve
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
