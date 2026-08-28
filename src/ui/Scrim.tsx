import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * The modal backdrop, mounted on `document.body` rather than where it is written.
 *
 * ## Why a portal, and not just a bigger z-index
 *
 * `.scrim` is `position: fixed; z-index: 10`, which reads as covering everything. It did not.
 * Every dialog here is rendered inside `.shell`, which is `position: relative; z-index: 1` — and
 * that combination creates a STACKING CONTEXT. Inside it, `z-index: 10` only ranks the scrim
 * against its siblings; against the rest of the page the whole shell competes as a single `z: 1`
 * layer, and `.topbar` at `z: 2` sits on top of it.
 *
 * Measured with a dialog open, before this existed:
 *
 *     elementFromPoint(12, 12)   -> HEADER.topbar
 *     elementFromPoint(960, 60)  -> HEADER.topbar
 *     elementFromPoint(200, 600) -> DIV.rail-list
 *
 * So the top bar and the conversation rail were both live while a modal was open. Raising the
 * scrim's z-index cannot fix that — no value inside a stacking context escapes it. Leaving the
 * shell's context is the only fix, hence the portal.
 *
 * ## Why this matters most for the one that spends money
 *
 * ConsentDialog is the gate in front of a paid call. A dialog you can click behind is a dialog
 * whose answer can be bypassed, and the fact that a stray click landed on a nav control rather
 * than on "approve" was luck about layout, not about safety.
 *
 * The backdrop stays clickable-to-close (`onClick` on the scrim itself). Panels must keep calling
 * `stopPropagation` on their own click, exactly as they did before.
 */
export function Scrim({ onClose, children }: { onClose?: () => void; children: ReactNode }) {
  return createPortal(
    <div className="scrim" onClick={onClose} role="presentation">
      {children}
    </div>,
    document.body,
  )
}
