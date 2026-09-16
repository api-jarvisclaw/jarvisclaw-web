import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The transcript must survive a reload, and a generated image must reach the gallery.
 *
 * Two reports, measured on the deployed page.
 *
 * ## "一刷新就没有了，体验极差"
 *
 *     2 rows on screen -> reload -> 0 rows
 *
 * The only `persist()` on the chat path was in the run's `finally`, so for the whole run the
 * transcript existed in React state alone. An agent run is tens of seconds across up to 8 turns,
 * and that window is exactly when someone reloads — because a long wait looks stuck. Closing the
 * tab or crashing lost it the same way. `runGeneration` was worse: it had NO persist at all, so
 * an anonymous or declined generation was never written even after it had visibly finished.
 *
 * ## "这个图片没有到gallery库里啊"
 *
 * The gallery row was added only `if (shownUrl)`. `gpt-image-2` returns `b64_json`, not a URL, so
 * a paid image appeared in the transcript and nowhere else. Nothing errored — the row was never
 * created. `retentionOf` already handled the case (it returns 'thisTab' for an item with only a
 * `mediaKey`) and `GalleryItem.url` is documented "empty for inline bytes", so the gallery was
 * built for this and the write site was the sole exclusion.
 *
 * ## Why source text
 *
 * Both properties are about WHERE a call sits inside a long `useCallback` closing over React
 * state, a wallet and IndexedDB. Standing that up would test the harness; the defect is one
 * call's presence and another's ordering. Comments are stripped first, so no assertion can be
 * satisfied by the prose explaining it — a guard here once passed on its own comment.
 */
const raw = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** One `const <name> = useCallback(` body, sliced at the next such declaration. */
function fn(name: string): string {
  const src = stripComments(raw)
  const start = src.indexOf(`const ${name} = useCallback(`)
  expect(start, `${name} must exist — this guard scans it`).toBeGreaterThan(-1)
  const rest = src.slice(start + 10)
  const nextIdx = rest.search(/\n  const \w+ = useCallback\(/)
  const body = src.slice(start, nextIdx === -1 ? src.length : start + 10 + nextIdx)
  expect(body.length, `${name} slice looks empty`).toBeGreaterThan(300)
  return body
}

describe('the transcript is written while the run is going', () => {
  it('checkpoints during the stream, not only at the end', () => {
    const send = fn('send')
    // A persist reachable from the event loop. Without it the only write is the `finally`, and
    // everything before it is lost to a reload — measured 2 rows -> 0.
    expect(send).toContain('checkpoint()')
    const applyAt = send.indexOf('apply(event)')
    expect(applyAt).toBeGreaterThan(-1)
    // In the same loop body as the event application, not somewhere after it.
    expect(send.slice(applyAt, applyAt + 200)).toContain('checkpoint()')
  })

  it('throttles the write instead of running it per token', () => {
    // `saveConversations` serialises every conversation and writes one localStorage key,
    // synchronously. Per-token that is hundreds of writes per answer, on the streaming path.
    const send = fn('send')
    expect(send).toMatch(/lastSave/)
    expect(send).toMatch(/now - lastSave < \d+/)
  })

  it('reads the turns through a state setter rather than the closure', () => {
    // `turns` in this closure is the value from BEFORE the run, so persisting it directly would
    // save an empty transcript over a full one — a save that causes the loss it prevents.
    const send = fn('send')
    const cp = send.indexOf('const checkpoint')
    const body = send.slice(cp, cp + 400)
    expect(body).toContain('setTurns((t) =>')
    expect(body).toContain('persist(convId, t, history.current)')
  })

  it('writes a generation that ended without media', () => {
    // The anonymous price notice, a decline, a refusal. These are terminal and visible, and
    // before this none of them was ever persisted — runGeneration had no persist() at all.
    const run = fn('runGeneration')
    const drop = run.indexOf('const dropPlaceholder')
    expect(drop).toBeGreaterThan(-1)
    expect(run.slice(drop, drop + 400)).toContain('persist(convId,')
  })

  it('writes a generation that failed after the charge', () => {
    // Money may already be spent. The record of a paid failure must survive a reload.
    const run = fn('runGeneration')
    const c = run.lastIndexOf('} catch (err) {')
    expect(c).toBeGreaterThan(-1)
    expect(run.slice(c)).toContain('persist(convId,')
  })
})

describe('generated media reaches the gallery however it arrived', () => {
  it('does not require a URL', () => {
    // `if (shownUrl)` excluded every medium that returns base64 — which is what gpt-image-2
    // does. The gallery itself already supported it.
    const settle = fn('settleMedia')
    expect(settle).toContain('if (shownUrl || mediaKey)')
    expect(settle).not.toMatch(/if \(shownUrl\) \{/)
  })

  it('stores the bytes BEFORE building the gallery row', () => {
    // Ordering, not just the condition: the row needs `mediaKey` to be reachable, and the key
    // does not exist until putMedia has run. Widening the condition alone would add a row
    // pointing at nothing.
    const settle = fn('settleMedia')
    const put = settle.indexOf('putMedia(')
    const row = settle.indexOf('addToGallery(')
    expect(put).toBeGreaterThan(-1)
    expect(row).toBeGreaterThan(-1)
    expect(put, 'putMedia must run before the gallery row is built').toBeLessThan(row)
  })

  it('carries the key onto the item', () => {
    const settle = fn('settleMedia')
    const row = settle.indexOf('const item: GalleryItem')
    expect(settle.slice(row, row + 400)).toContain('mediaKey,')
  })
})
