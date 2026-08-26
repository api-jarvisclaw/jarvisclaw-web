import { useCallback, useEffect, useRef } from 'react'

import { clampPane, PANE_BOUNDS, type Pane } from '../lib/panes'

/**
 * The draggable divider between a side pane and the transcript.
 *
 * ## Pointer events, not mouse events
 *
 * `setPointerCapture` routes every subsequent move to this element even when the pointer leaves it,
 * which is the normal case for a 6px-wide target — a fast drag outruns the handle within a frame.
 * With mouse events the alternative is listeners on `window` plus a manual teardown, and the drag
 * dies the moment the pointer crosses an iframe or leaves the window. Pointer events also make the
 * same code work for touch and pen without a second path.
 *
 * ## Why it also responds to the keyboard
 *
 * A drag handle reachable only by pointer is a preference nobody using a keyboard can set. It is a
 * `separator` with `aria-valuenow`, and arrow keys move it in steps — which is what the ARIA window
 * splitter pattern specifies, and is genuinely how someone with a tremor would use it. Home and End
 * jump to the bounds, so escaping a too-narrow pane does not require twenty keypresses.
 *
 * ## The width it reports
 *
 * Measured from the viewport edge rather than accumulated from the pointer's delta. Deltas drift:
 * every clamp against the bounds discards the excess, so dragging past the maximum and back leaves
 * the handle offset from the pointer by however far it overshot. An absolute measurement cannot
 * drift, because it never remembers anything.
 */
export function PaneResizer({
  pane,
  width,
  onWidth,
  onCommit,
}: {
  pane: Pane
  /** The pane's current width, for the accessible value and the keyboard steps. */
  width: number
  /** Called on every move — cheap, because it only writes a CSS custom property. */
  onWidth: (px: number) => void
  /** Called once when the drag ends, which is when the choice is persisted. */
  onCommit: () => void
}) {
  const dragging = useRef(false)

  /**
   * Turns a pointer position into a pane width.
   *
   * The right-hand pane grows as the pointer moves LEFT, so its width is measured from the right
   * edge of the window. Getting this backwards makes the sidebar shrink when dragged outward, which
   * reads as the handle being attached to the wrong pane.
   */
  const widthAt = useCallback(
    (clientX: number) =>
      clampPane(pane, pane === 'rail' ? clientX : window.innerWidth - clientX),
    [pane],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Primary button only. A right-click drag would move the pane and open the context menu on
      // top of it, and a middle-click drag is a scroll gesture in most browsers.
      if (e.button !== 0) return
      dragging.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      // Stops the browser turning the drag into a text selection of the transcript behind it, which
      // leaves the whole conversation highlighted when the pointer is released.
      e.preventDefault()
    },
    [],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      onWidth(widthAt(e.clientX))
    },
    [onWidth, widthAt],
  )

  const end = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    onCommit()
  }, [onCommit])

  /**
   * A body-level class while dragging.
   *
   * Two jobs, and both are about what happens OUTSIDE this element. `cursor` has to stay the resize
   * cursor even while the pointer is over the transcript, or a fast drag flickers between two
   * cursors. `user-select: none` stops the drag selecting text in the panes it passes over —
   * `preventDefault` on pointerdown covers the press, not the sixty moves after it.
   *
   * Cleared in an effect teardown as well as on release, because a drag interrupted by an unmount —
   * a route change, a hot reload — would otherwise leave the whole document unselectable with no
   * way to recover but a refresh.
   */
  useEffect(() => {
    return () => document.body.classList.remove('is-resizing')
  }, [])

  const setDragCursor = (on: boolean) => document.body.classList.toggle('is-resizing', on)

  const step = (delta: number) => {
    // The rail grows rightward and the sidebar leftward, so the same arrow key means opposite things
    // for the two. Without this, ArrowRight would widen one pane and narrow the other, which is
    // exactly the confusion the pointer version avoids by construction.
    const signed = pane === 'rail' ? delta : -delta
    onWidth(clampPane(pane, width + signed))
    onCommit()
  }

  return (
    <div
      // The pane modifier is what the breakpoints target. A positional selector would work today and
      // silently stop working the moment a sibling is added or reordered — and the symptom is a
      // draggable strip against the window edge that resizes a pane nobody can see.
      className={`pane-resizer pane-resizer-${pane}`}
      role="separator"
      // Not aria-orientation="vertical". The separator is drawn vertically, but the value it
      // controls moves along the HORIZONTAL axis, and that axis is what the attribute names —
      // getting it wrong makes a screen reader announce the wrong pair of arrow keys.
      aria-orientation="horizontal"
      aria-label={pane === 'rail' ? 'Resize the conversation list' : 'Resize the account panel'}
      aria-valuenow={width}
      aria-valuemin={PANE_BOUNDS[pane].min}
      aria-valuemax={PANE_BOUNDS[pane].max}
      tabIndex={0}
      onPointerDown={(e) => {
        onPointerDown(e)
        if (dragging.current) setDragCursor(true)
      }}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        end()
        setDragCursor(false)
      }}
      // A capture lost to something else — a browser gesture, another element claiming the pointer —
      // must still finish the drag. Without this the ref stays true and the NEXT pointermove over
      // the handle continues a drag the user thought they had ended.
      onLostPointerCapture={() => {
        end()
        setDragCursor(false)
      }}
      onKeyDown={(e) => {
        // 16px per press, 64 with Shift: a 260px pane reaches either bound in a handful of presses
        // rather than fifteen, and the fine step is still fine enough to line up with a title.
        const big = e.shiftKey ? 64 : 16
        if (e.key === 'ArrowLeft') step(-big)
        else if (e.key === 'ArrowRight') step(big)
        else if (e.key === 'Home') step(-9999)
        else if (e.key === 'End') step(9999)
        else return
        // Only for the keys handled above. Returning first means an untouched key still scrolls or
        // tabs — swallowing every keystroke on a focusable divider would trap the keyboard here.
        e.preventDefault()
      }}
      onDoubleClick={() => {
        // Back to the default, which is the only way out of a pane dragged to a width that makes its
        // own content unreadable — the same escape a table column divider offers.
        onWidth(clampPane(pane, pane === 'rail' ? 260 : 320))
        onCommit()
      }}
    />
  )
}
