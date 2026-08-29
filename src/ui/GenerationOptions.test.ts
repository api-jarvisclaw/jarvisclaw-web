import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { reconcileOptions, videoLimitsFor } from '../lib/modality'
import { describe as summarise } from './GenerationOptions'

/**
 * The panel must show what will RUN, not what is in state.
 *
 * The two diverge after a model switch. Options are stored per generation kind — deliberately, so
 * that Image -> Video -> Image remembers the size you chose — while the limits are per model. Pick
 * 30s under seedance-2.5, switch to Sora, and state still holds 30 while Sora accepts 4/8/12.
 * `buildBody` narrows the outgoing value to 12, so a panel rendering the stored 30 would:
 *
 *   - highlight a chip that is not the one being used, and
 *   - label the button "30s" for a twelve-second video.
 *
 * Measured in a browser against the built bundle, which is where this was confirmed rather than
 * assumed: button on 2.5 = "30s", button on sora-2 = "12s", active chip = "12s", and switching back
 * to 2.5 restores "30s".
 */

// `fileURLToPath`, not `new URL(...).pathname` — on Windows the latter yields "/D:/…" and join
// produces "D:\D:\…", which fails to read and makes vitest report the whole file as "no tests".
const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'GenerationOptions.tsx'),
  'utf8',
)

describe('the panel renders the reconciled options, not the stored ones', () => {
  it('labels the button with the value that will actually be sent', () => {
    const stored = { duration: 30 }
    // On the model that accepts it, the user's own choice.
    expect(summarise('video', reconcileOptions('video', 'bytedance/seedance-2.5', stored))).toBe(
      '30s',
    )
    // On one that does not, the value that will run.
    expect(summarise('video', reconcileOptions('video', 'azure/sora-2', stored))).toBe('12s')
  })

  it('names a voice on the button only when that voice is the one being used', () => {
    const stored = { voice: 'george' }
    expect(summarise('speech', reconcileOptions('speech', 'elevenlabs/turbo-v2.5', stored))).toBe(
      'george',
    )
    // Carried to an OpenAI model, `george` is not what runs — and this is the case that costs the
    // payment rather than the call, so the label must not claim it.
    const shown = summarise('speech', reconcileOptions('speech', 'openai/gpt-4o-mini-tts', stored))
    expect(shown).not.toBe('george')
  })

  it('reads every current= from the reconciled view rather than the raw options', () => {
    /**
     * A source-level guard, because this is the kind of regression a reasonable edit reintroduces:
     * adding a control by copying a sibling and writing `current={options.x}` looks right and is
     * wrong. There is no rendering test here to catch it, so the source is checked directly.
     *
     * `onChange` handlers legitimately spread `...options` — the STORED value is what must be
     * written back, so that switching away and back restores the user's real choice — hence only
     * `current=` and `value=` are checked.
     */
    const currents = SRC.match(/current=\{[^}]+\}/g) ?? []
    expect(currents.length).toBeGreaterThan(10)
    const stale = currents.filter((c) => c.includes('options.'))
    expect(stale, `these read stored state instead of the reconciled view: ${stale.join(', ')}`).toEqual(
      [],
    )

    // The textarea's value too — it is not a chip row and so has no `current=`.
    const values = SRC.match(/value=\{[^}]*lyrics[^}]*\}/g) ?? []
    expect(values.length).toBeGreaterThan(0)
    expect(values.filter((v) => v.includes('options.'))).toEqual([])
  })

  it('summarises from the reconciled options, not the stored ones', () => {
    // The button's own label goes through the same view.
    expect(SRC).toContain('describe(mode, shown)')
    expect(SRC).not.toContain('describe(mode, options)')
  })

  it('offers a duration set that its own reconcile agrees with, for every model', () => {
    /**
     * The panel draws chips from `videoLimitsFor` and the wire is narrowed by `reconcileOptions`.
     * If those two ever disagreed, a user could click a chip and have a different value sent — the
     * defect in a subtler form. Checked by round-tripping every offered value through reconcile.
     */
    const models = [
      'azure/sora-2',
      'bytedance/seedance-1.5-pro',
      'bytedance/seedance-2.0',
      'bytedance/seedance-2.0-fast',
      'bytedance/seedance-2.0-mini',
      'bytedance/seedance-2.5',
      'xai/grok-imagine-video',
      'xai/grok-imagine-video-1.5',
      'auto/video',
    ]
    let checked = 0
    for (const model of models) {
      const limits = videoLimitsFor(model)
      for (const duration of limits.durations) {
        expect(reconcileOptions('video', model, { duration }).duration).toBe(duration)
        checked++
      }
      for (const resolution of limits.resolutions) {
        expect(reconcileOptions('video', model, { resolution }).resolution).toBe(resolution)
        checked++
      }
      for (const aspectRatio of limits.aspectRatios) {
        expect(reconcileOptions('video', model, { aspectRatio }).aspectRatio).toBe(aspectRatio)
        checked++
      }
    }
    // The denominator, stated: a silently empty loop would pass every assertion above.
    expect(checked).toBeGreaterThan(100)
  })
})
