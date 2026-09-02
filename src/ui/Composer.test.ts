import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GENERATIONS, type GenerationKind } from '../lib/modality'
import { translate } from '../lib/strings'
import { COMPOSER_MODES } from './Composer'

/**
 * Reported from the live console, in the user's own words: "这里一旦切到 image 或者其他的
 * 就回不去正常聊天了" — once you switch to Image, you cannot get back to normal chat.
 *
 * The mechanism was never broken, and that is the point of these tests. Measured on the live
 * site with a real browser, reading the DOM:
 *
 *   START       Ask anything…            | auto/free free
 *   ->Image     Describe the image…      | openai/gpt-image-2 AUTO
 *   ->Video     Describe the video…      | bytedance/seedance-2.0-mini AUTO
 *   ->Music     Describe the track…      | minimax/music-2.5+ AUTO
 *   ->Music x2  Ask anything…            | auto/free free      <- it DOES go back
 *   answered?   True
 *
 * The placeholder returns, the model resets, and a question then answers. What the same run
 * also measured is the actual defect:
 *
 *   buttons labelled exactly "Chat": 0
 *
 * Four buttons taught the rule "press the mode you want". Chat was the sole exception, and its
 * only escape was pressing a button that already looked pressed — which reads as "already
 * active, this does nothing". A toggle whose off-switch is its on-switch is discoverable only
 * to whoever wrote it.
 *
 * So the assertions below are about what is OFFERED, not about whether switching works. A test
 * of the switching would have passed on the broken build, which is exactly how this shipped.
 */
describe('the composer offers a way back to chat', () => {
  it('includes chat as one of the mode buttons', () => {
    expect(COMPOSER_MODES).toContain('chat')
  })

  it('offers chat FIRST, before any paid mode', () => {
    // Order matters for the reported problem: someone hunting for "put it back" scans the row
    // from the left, and the leftmost entries being paid generation modes is what made pressing
    // one of them the obvious guess.
    expect(COMPOSER_MODES[0]).toBe('chat')
  })

  it('still offers every generation mode', () => {
    // The control. "Add a chat button" must not be satisfied by dropping the others — a row
    // with only Chat would pass the two assertions above and be a worse product.
    for (const kind of Object.keys(GENERATIONS) as GenerationKind[]) {
      expect(COMPOSER_MODES).toContain(kind)
    }
  })

  it('has a Chinese label, so the button is not English-only on the zh site', () => {
    // The zh table falls through to the English key when an entry is missing, which renders
    // "Chat" beside 图片/视频/音乐/语音 — legible, but visibly untranslated next to four
    // translated peers.
    expect(translate('zh', 'Chat')).not.toBe('Chat')
  })
})

/**
 * The list above is only meaningful if the component actually renders from it. Extracting a
 * constant and leaving the JSX iterating its own hard-coded array would leave every assertion
 * above passing while the row on screen was unchanged — a shape this repo has hit before.
 *
 * A source read rather than a DOM render because there is no testing-library here (jsdom
 * alone), and adding one for a single assertion is a bigger change than the fix. The narrow
 * risk of a source scan is that a comment can satisfy it, so the match is anchored on the
 * call syntax `COMPOSER_MODES.map(` rather than on the bare name, which appears in the prose
 * above the constant.
 */
describe('the component renders from that list', () => {
  const source = readFileSync(join(__dirname, 'Composer.tsx'), 'utf8')

  it('maps over COMPOSER_MODES to build the row', () => {
    expect(source).toContain('COMPOSER_MODES.map(')
  })

  it('does not iterate a second hard-coded mode array beside it', () => {
    // The exact literal that used to be there. Its return would mean the constant is
    // decoration and the rendered row is once again missing chat.
    expect(source).not.toContain("['image', 'video', 'music', 'speech'] as const).map")
  })
})
