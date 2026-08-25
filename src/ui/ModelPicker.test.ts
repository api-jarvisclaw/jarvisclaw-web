import { describe, expect, it } from 'vitest'

import type { CatalogueModel } from '../lib/catalogue'
import { GENERATIONS } from '../lib/modality'
import { effectiveModel } from './ModelPicker'

/**
 * These pin a bug reported from the live site, in the user's own words: "I switched to Music,
 * and the model below is still the one I chose myself — this isn't smart."
 *
 * The override itself was never broken. With `bytedance/seedance-2.0-fast` picked and Music
 * selected, the app correctly ran `minimax/music-2.5+` — but the picker kept showing the video
 * model while a line of small print underneath said "Using minimax/music-2.5+". Two names, both
 * on screen, disagreeing, and the true one in the smaller text. Reproduced in a browser:
 *
 *   picker shows : bytedance/seedance-2.0-fast
 *   hint says    : … Using minimax/music-2.5+.
 *
 * So the interesting assertions are not "does the override happen" but "do the picker and the
 * hint agree", which is why this function is shared by both and pure.
 */

function model(name: string, modality: CatalogueModel['modality']): CatalogueModel {
  return {
    model: name,
    modality,
    free: false,
    virtual: false,
    inputPerMTokenUsd: 0,
    outputPerMTokenUsd: 0,
    pricingType: 'per_call',
  }
}

const CATALOGUE: CatalogueModel[] = [
  model('bytedance/seedance-2.0-fast', 'video'),
  model('minimax/music-2.5+', 'audio'),
  model('elevenlabs/turbo-v2.5', 'audio'),
  model('openai/gpt-image-2', 'image'),
  model('nvidia/step-3.7-flash', 'text'),
]

describe('effectiveModel', () => {
  it('replaces a video model with the music default when Music is selected', () => {
    // The exact reported case.
    expect(effectiveModel(CATALOGUE, 'bytedance/seedance-2.0-fast', 'music')).toBe(
      GENERATIONS.music.defaultModel,
    )
  })

  it('keeps the user’s own pick when it can serve the mode', () => {
    // The other half, and the one that makes the picker worth having: an explicit choice must
    // survive. A version that always returned the default would pass the test above.
    expect(effectiveModel(CATALOGUE, 'minimax/music-2.5+', 'music')).toBe('minimax/music-2.5+')
    expect(effectiveModel(CATALOGUE, 'openai/gpt-image-2', 'image')).toBe('openai/gpt-image-2')
    expect(effectiveModel(CATALOGUE, 'bytedance/seedance-2.0-fast', 'video')).toBe(
      'bytedance/seedance-2.0-fast',
    )
  })

  it('separates music from speech, which share the audio modality', () => {
    // `audio` covers two different endpoints: /v1/audio/generations (per track) and
    // /v1/audio/speech (per clip). Matching on modality alone would let a voice model serve
    // Music, which 400s — the same class of mistake that once sent auto/tts to the chat
    // endpoint and billed it as chat.
    expect(effectiveModel(CATALOGUE, 'elevenlabs/turbo-v2.5', 'music')).toBe(
      GENERATIONS.music.defaultModel,
    )
    expect(effectiveModel(CATALOGUE, 'minimax/music-2.5+', 'speech')).toBe(
      GENERATIONS.speech.defaultModel,
    )
    // And each is kept in its own mode.
    expect(effectiveModel(CATALOGUE, 'elevenlabs/turbo-v2.5', 'speech')).toBe(
      'elevenlabs/turbo-v2.5',
    )
  })

  it('changes nothing in chat mode', () => {
    // Chat has no default to fall back to, and a text model is the one thing that always
    // works there. Overriding here would take the choice away for no reason.
    expect(effectiveModel(CATALOGUE, 'nvidia/step-3.7-flash', 'chat')).toBe(
      'nvidia/step-3.7-flash',
    )
    // Even a non-text model: App.tsx routes it to its own endpoint instead, and rewriting the
    // name here would hide which model that routing is about to use.
    expect(effectiveModel(CATALOGUE, 'minimax/music-2.5+', 'chat')).toBe('minimax/music-2.5+')
  })

  it('falls back to the default for a model the catalogue does not know', () => {
    // The catalogue loads asynchronously, so `models` is empty on the first render. Showing
    // the picked name then would claim it serves the mode without any evidence — and the empty
    // list is exactly when a wrong claim is least visible.
    expect(effectiveModel([], 'bytedance/seedance-2.0-fast', 'music')).toBe(
      GENERATIONS.music.defaultModel,
    )
    expect(effectiveModel(CATALOGUE, 'some/model-that-was-retired', 'video')).toBe(
      GENERATIONS.video.defaultModel,
    )
  })

  it('never returns a name the mode cannot serve', () => {
    // The property behind all of the above, checked across the whole catalogue rather than at
    // the cases I happened to think of. Whatever is selected, the result must be servable —
    // that is the entire contract, and it is what the picker now displays.
    const modes = ['image', 'video', 'music', 'speech'] as const
    for (const mode of modes) {
      for (const m of [...CATALOGUE.map((c) => c.model), 'unknown/model']) {
        const out = effectiveModel(CATALOGUE, m, mode)
        const row = CATALOGUE.find((c) => c.model === out)
        const servable = out === GENERATIONS[mode].defaultModel || row !== undefined
        expect(servable, `${m} in ${mode} gave ${out}`).toBe(true)
      }
    }
  })
})
