/**
 * "Make your own" must reproduce the item the user clicked, on the model that made it.
 *
 * Reported from a screenshot: a Seedance 2.0 showcase prompt loaded into the composer and quoted
 * "One video from bytedance/seedance-2.0-mini costs $0.399554". The mini is the modality default,
 * not the model on the card — so the user was priced for a ~2.8x cheaper model than the example
 * they picked, and the output would not have matched what they were looking at.
 *
 * The gallery had the model all along: every card prints `item.model`. `onUsePrompt` simply did
 * not carry it.
 */
import { describe, expect, it } from 'vitest'
import { gatewayModelFor } from './showcase-model'
import { SHOWCASE, showcaseMode } from './showcase'
import { GENERATIONS, videoLimitsFor } from './modality'

describe('gatewayModelFor', () => {
  it('resolves the published names the showcase actually uses', () => {
    // The population, not a sample: every distinct name in SHOWCASE must resolve, or a card
    // exists whose "Make your own" silently falls back to the modality default.
    const published = [...new Set(SHOWCASE.map((s) => s.model))]
    expect(published.length, 'no showcase models found — this test is scanning nothing').toBeGreaterThan(0)
    for (const name of published) {
      expect(gatewayModelFor(name), `showcase model ${name} does not resolve to a gateway id`)
        .not.toBeNull()
    }
  })

  it('is insensitive to display spelling', () => {
    const id = 'bytedance/seedance-2.0'
    for (const spelling of ['SeeDance 2.0', 'Seedance 2.0', 'seedance-2.0', 'SEEDANCE 2.0']) {
      expect(gatewayModelFor(spelling), spelling).toBe(id)
    }
  })

  it('passes a gateway id straight through', () => {
    // The user's own library stores real ids, and the same button handles both sources.
    expect(gatewayModelFor('bytedance/seedance-2.5')).toBe('bytedance/seedance-2.5')
    expect(gatewayModelFor('openai/gpt-image-2')).toBe('openai/gpt-image-2')
  })

  it('returns null rather than guessing', () => {
    // Falling back to the modality default is the current behaviour and is merely suboptimal.
    // Guessing an id would quote and charge for a model nobody named, which is worse.
    for (const unknown of ['', '   ', 'Some Future Model 9', 'midjourney v7']) {
      expect(gatewayModelFor(unknown), JSON.stringify(unknown)).toBeNull()
    }
    expect(gatewayModelFor(null)).toBeNull()
    expect(gatewayModelFor(undefined)).toBeNull()
  })

  it('resolves to ids this app actually knows how to drive', () => {
    // A resolved id that no limits table covers would take the generation panel's defaults,
    // which is the same class of mismatch this fixes — right name, wrong parameters.
    for (const name of [...new Set(SHOWCASE.map((s) => s.model))]) {
      const id = gatewayModelFor(name)
      expect(id).not.toBeNull()
      if (showcaseMode(SHOWCASE.find((s) => s.model === name)!) === 'video') {
        const limits = videoLimitsFor(id!)
        expect(limits.durations.length, `${id} has no known video durations`).toBeGreaterThan(0)
      }
    }
  })

  it('never resolves a video model to the mini by default', () => {
    /**
     * The specific substitution that was measured. seedance-2.0 must not resolve to
     * seedance-2.0-mini: they are a 2.8x price difference and different parameter ceilings, and
     * the mini being the modality default is exactly why the bug was invisible — the wrong model
     * still produced a plausible quote.
     */
    expect(GENERATIONS.video.defaultModel, 'the measured substitution was to the mini')
      .toBe('bytedance/seedance-2.0-mini')
    expect(gatewayModelFor('SeeDance 2.0')).not.toBe(GENERATIONS.video.defaultModel)
    expect(gatewayModelFor('SeeDance')).not.toBe(GENERATIONS.video.defaultModel)
  })
})
