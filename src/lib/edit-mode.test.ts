import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildBody, GENERATIONS, modeForModel } from './modality'

/**
 * Image editing: the mode whose models I wrongly reported as unservable.
 *
 * I found `ali/qwen-image-edit`, `-plus` and `-max` answering 400 and recommended delisting them.
 * That conclusion was not earned. `modeForModel` knows four destinations, so every image-shaped
 * name went to /v1/images/generations — and these are EDIT models, which take a source image. A
 * bare prompt is an incomplete request, not a dead model. Measured at /v1/images/edits:
 *
 *     ali/qwen-image-edit        402  $0.045000
 *     ali/qwen-image-edit-plus   402  $0.028572
 *     ali/qwen-image-edit-max    402  $0.075000
 *
 * Real per-image prices, not the $0.001 facilitator floor — which is the distinction that matters,
 * because that floor is what made 19 unrelated models look servable when quoted on
 * /v1/chat/completions. `$0.001` is what EVERY chat request quotes, including a genuine chat model,
 * so a 402 there says nothing about whether an image comes back.
 *
 * ## The expensive property
 *
 * The gateway does NOT check that the image is present. Measured: /v1/images/edits returns the
 * same 402 with the image, without it, and under four different field spellings (`image`,
 * `images`, `image_url`, raw base64). The quote precedes any inspection of the body. So an edit
 * with nothing attached is quoted, approved, SIGNED, settled on-chain, and only then refused —
 * money gone, nothing produced, no way to reverse it. Every test below about the source image is
 * about that.
 */
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('the edit endpoint is wired to the right place', () => {
  it('posts to /v1/images/edits, not the generation endpoint', () => {
    // The whole reason these looked broken. /v1/images/generations refuses them.
    expect(GENERATIONS.edit.path).toBe('/v1/images/edits')
    expect(GENERATIONS.edit.path).not.toBe(GENERATIONS.image.path)
  })

  it('defaults to a model measured at a real price on that endpoint', () => {
    // One of the three that quoted a genuine per-image price. Naming a model here without having
    // seen it priced is how the earlier defaults in this file went wrong.
    expect(['ali/qwen-image-edit', 'ali/qwen-image-edit-plus', 'ali/qwen-image-edit-max']).toContain(
      GENERATIONS.edit.defaultModel,
    )
  })

  it('declares that it cannot run without a source image', () => {
    expect(GENERATIONS.edit.requiresSourceImage).toBe(true)
    // And the modes that CAN run without one must not claim to need it, or every generation is
    // blocked by a control that does not apply.
    expect(GENERATIONS.image.requiresSourceImage).toBeUndefined()
    expect(GENERATIONS.video.requiresSourceImage).toBeUndefined()
  })
})

describe('the body carries the image under the name our contract documents', () => {
  it('sends `image`', () => {
    // controller/openapi.go declares `image` (binary) and `prompt` as required. That is the
    // authority, because the live 402 cannot distinguish the spellings — it prices all four
    // identically, and with no image at all. Reading the price back would only have confirmed
    // whichever guess was made.
    const body = buildBody('edit', 'make it blue', 'ali/qwen-image-edit-plus', {
      sourceImage: 'data:image/png;base64,AAAA',
      size: '1024x1024',
      n: 1,
    })
    expect(body).toMatchObject({
      model: 'ali/qwen-image-edit-plus',
      prompt: 'make it blue',
      image: 'data:image/png;base64,AAAA',
    })
  })

  it('does not send `quality`, which nothing here establishes is accepted', () => {
    // The measured cause of every gpt-image-2 400 was a field the model refuses. Nothing shows
    // the edit models accept it, and the 402 cannot answer the question, so it is not sent on a
    // hope. Passing it explicitly must still not put it on the wire.
    const body = buildBody('edit', 'make it blue', 'ali/qwen-image-edit-plus', {
      sourceImage: 'data:image/png;base64,AAAA',
      quality: 'high',
    })
    expect(body).not.toHaveProperty('quality')
  })

  it('omits the image field entirely when there is none, rather than sending empty', () => {
    // An empty string is a value the upstream would have to interpret. Absent is unambiguous —
    // and the UI is what stops this body being sent at all.
    const body = buildBody('edit', 'make it blue', 'ali/qwen-image-edit-plus', {})
    expect(body).not.toHaveProperty('image')
  })
})

describe('an edit with no image never reaches a payment', () => {
  it('is refused before the quote, where refusing is free', () => {
    /**
     * Position is the whole point. Checked before `challengeGeneration`, because after it comes
     * the consent dialog, then the wallet signature, then settlement — and the gateway will
     * quote this request happily. A check placed after the quote would still spend the money.
     */
    const src = stripComments(app)
    const start = src.indexOf('const runGeneration = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, start + 6000)
    const check = body.indexOf('requiresSourceImage')
    const quote = body.indexOf('await challengeGeneration')
    expect(check, 'the source-image check must exist').toBeGreaterThan(-1)
    expect(quote).toBeGreaterThan(-1)
    expect(
      check,
      'the check must come BEFORE the quote — the gateway prices an edit with no image, so a ' +
        'later check spends the money first',
    ).toBeLessThan(quote)
  })

  it('reads the option for the mode being run, not a hardcoded one', () => {
    // `genOptions[kind]`, so switching modes cannot leave the check consulting another mode's
    // state — the shape of a defect this app has had before (a stale option surviving a model
    // switch, which once cost a real charge).
    const src = stripComments(app)
    const i = src.indexOf('requiresSourceImage')
    expect(src.slice(i, i + 160)).toContain('genOptions[kind]')
  })
})

describe('the picker routes an edit model to the edit mode', () => {
  it('does not send an edit model to plain image generation', () => {
    // `modeForModel` maps a catalogue row to a mode. Left alone, an edit model's modality is
    // `image` and it would be POSTed to /v1/images/generations — the original mistake, in code.
    expect(modeForModel('ali/qwen-image-edit-plus', 'image')).toBe('edit')
    expect(modeForModel('ali/qwen-image-edit', 'image')).toBe('edit')
    expect(modeForModel('ali/qwen-image-edit-max', 'image')).toBe('edit')
  })

  it('leaves ordinary image models on image generation', () => {
    // The control. Matching too broadly would send every image model to an endpoint that needs
    // a source picture, breaking the mode that works today.
    expect(modeForModel('openai/gpt-image-2', 'image')).toBe('image')
    expect(modeForModel('ali/qwen-image', 'image')).toBe('image')
    expect(modeForModel('bytedance/seedream-5-pro', 'image')).toBe('image')
  })
})

describe('the source-image control refuses what it cannot send', () => {
  it('is offered for edit mode only', () => {
    const opts = readFileSync(new URL('../ui/GenerationOptions.tsx', import.meta.url), 'utf8')
    const src = stripComments(opts)
    expect(src).toContain("mode === 'edit'")
    expect(src).toContain('<SourceImage')
  })

  it('caps the size, because an inlined photo has cost this app data before', () => {
    // Seven inlined speech clips filled the origin's 4 MB localStorage, after which every
    // conversation write failed silently. A multi-megabyte data: URL in a request body is the
    // same shape of problem.
    const opts = readFileSync(new URL('../ui/GenerationOptions.tsx', import.meta.url), 'utf8')
    expect(opts).toMatch(/MAX_SOURCE_BYTES\s*=/)
    expect(stripComments(opts)).toContain('file.size > MAX_SOURCE_BYTES')
  })

  it('reports a read failure instead of looking like it accepted the file', () => {
    // Without onerror the panel shows nothing and the next thing the user does is pay.
    const opts = stripComments(
      readFileSync(new URL('../ui/GenerationOptions.tsx', import.meta.url), 'utf8'),
    )
    expect(opts).toContain('reader.onerror')
  })
})
