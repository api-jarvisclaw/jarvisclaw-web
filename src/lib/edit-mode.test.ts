import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { authHeaders } from './gateway'
import { buildBody, encodeBody, GENERATIONS, modeForModel } from './modality'

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

  it('defaults to a model measured to RETURN AN EDIT, not one with a price', () => {
    /**
     * This test used to accept any of the three qwen-edit names, because they quoted real
     * per-image prices. All three answer 400 upstream — 'does not support image editing', and
     * 'Unknown image model' even on the generation endpoint. The price was our own table.
     */
    expect(['openai/gpt-image-2', 'openai/gpt-image-1']).toContain(GENERATIONS.edit.defaultModel)
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
  it('sends the image under images[].image_url', () => {
    // Was `expect(body).toMatchObject({ image: … })`, taken from our own openapi.go. The call
    // that returns bytes takes `images: [{ image_url: '<data URI>' }]`.
    const body = buildBody('edit', 'make it blue', 'openai/gpt-image-2', {
      sourceImage: 'data:image/png;base64,AAAA',
      size: '1024x1024',
      n: 1,
    })
    expect(body).toMatchObject({
      model: 'openai/gpt-image-2',
      prompt: 'make it blue',
      images: [{ image_url: 'data:image/png;base64,AAAA' }],
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

/**
 * The body shape, established by a call that returned image bytes.
 *
 * I got this wrong twice, and both times by consulting something other than the product.
 *
 *   1. Our own `controller/openapi.go` documents `image` as a binary multipart field, so three
 *      PRs went into building a multipart body. The upstream answers 400 to it.
 *   2. The 402 quote, which prices `image`, `images`, `image_url`, raw base64 and NO image
 *      identically — the price is issued before the body is read.
 *
 * Driving our own gateway with an API key finally ranked the shapes, because the errors are
 * specific and the success is unambiguous:
 *
 *     { image: '<data URI>' }                    400  Invalid multipart form
 *     { images: [{ image_url: { url } }] }       400  expected an image URL, got an object
 *     { images: [{ image_url: '<data URI>' }] }  200  450 KB of real PNG, differing from source
 */
describe('the edit body carries the image the way the upstream reads it', () => {
  it('sends images[].image_url as a data URI string', () => {
    const body = buildBody('edit', 'make it green', 'openai/gpt-image-2', {
      sourceImage: 'data:image/png;base64,AAAA',
    })
    expect(body.images).toEqual([{ image_url: 'data:image/png;base64,AAAA' }])
  })

  it('does not send a bare `image` field', () => {
    // The multipart-era spelling. It answers 400 'Invalid multipart form' on a JSON body.
    const body = buildBody('edit', 'make it green', 'openai/gpt-image-2', {
      sourceImage: 'data:image/png;base64,AAAA',
    })
    expect(body).not.toHaveProperty('image')
  })

  it('does not nest the URL in an object', () => {
    // `{ image_url: { url } }` is refused: 'expected an image URL, but got an object instead'.
    const body = buildBody('edit', 'make it green', 'openai/gpt-image-2', {
      sourceImage: 'data:image/png;base64,AAAA',
    })
    const first = (body.images as Array<{ image_url: unknown }>)[0]
    expect(typeof first.image_url).toBe('string')
  })

  it('sends JSON, not multipart', () => {
    // Every endpoint takes JSON, the edit included. The multipart branch is gone.
    const encoded = encodeBody({ requiresSourceImage: true }, { a: 1 })
    expect(encoded.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(typeof encoded.body).toBe('string')
  })

  it('encodes the quote and the paid call through one function', () => {
    // The property that broke when only `generate` was changed: a price issued for one body and
    // spent on another is a signature paying for a request the gateway never priced.
    const src = stripComments(readFileSync(new URL('./modality.ts', import.meta.url), 'utf8'))
    const uses = src.match(/encodeBody\(spec, body\)/g) ?? []
    expect(uses.length, 'both challengeGeneration and generate must use encodeBody')
      .toBeGreaterThanOrEqual(2)
  })
})

/**
 * Only models MEASURED to return an edited image may be offered.
 *
 * Eight candidates, all eight quoting a price from our own table, and only two producing bytes:
 *
 *     openai/gpt-image-2                 EDITS   png 450458B
 *     openai/gpt-image-1                 EDITS   png 971226B
 *     google/nano-banana{,-2,-pro}       404     no such upstream route
 *     ali/qwen-image-edit{,-plus,-max}   400     'does not support image editing', and
 *                                                'Unknown image model' even on generations
 *
 * The qwen names are the ones I originally shipped as the default and recommended keeping in the
 * catalogue, on the strength of their 402. A 402 from this gateway is our own price table
 * talking; it says nothing about whether an upstream can serve the call.
 */
describe('the edit default is a model that actually edits', () => {
  const MEASURED_TO_EDIT = ['openai/gpt-image-2', 'openai/gpt-image-1']

  it('defaults to one of the two that produced bytes', () => {
    expect(MEASURED_TO_EDIT).toContain(GENERATIONS.edit.defaultModel)
  })

  it('does not default to a model that only quotes a price', () => {
    // Named explicitly so re-introducing one is a failing test rather than a silent regression.
    const QUOTES_BUT_CANNOT_EDIT = [
      'ali/qwen-image-edit',
      'ali/qwen-image-edit-plus',
      'ali/qwen-image-edit-max',
      'google/nano-banana',
      'google/nano-banana-2',
      'google/nano-banana-pro',
    ]
    expect(QUOTES_BUT_CANNOT_EDIT).not.toContain(GENERATIONS.edit.defaultModel)
  })
})
describe('the options panel is bounded', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

  function block(selector: string): string {
    const i = css.indexOf(selector)
    expect(i, `${selector} must exist`).toBeGreaterThan(-1)
    const open = css.indexOf('{', i)
    const close = css.indexOf('}', open)
    // Comments stripped: a guard here once passed on the prose explaining the value it forbade.
    return css.slice(open, close).replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('caps the panel in both axes', () => {
    const rule = block('.genopts-menu {')
    expect(rule).toMatch(/max-width:/)
    expect(rule).toMatch(/max-height:/)
    // A cap that exceeds the viewport is not a cap. min() keeps a narrow phone from scrolling
    // sideways instead.
    expect(rule).toMatch(/min\(/)
  })

  it('bounds the height with a scroll, not just a number', () => {
    // overflow-y: auto without a height bound does nothing — an unconstrained flex/grid child
    // defaults to min-height:auto and simply grows.
    const rule = block('.genopts-menu {')
    expect(rule).toMatch(/overflow-y:\s*auto/)
  })

  it('gives the thumbnail its own size so it cannot drive the layout', () => {
    const rule = block('.genopts-thumb {')
    expect(rule).toMatch(/max-width:/)
    expect(rule).toMatch(/max-height:/)
    // `contain`, not `cover`: this is the picture being edited, and cropping the preview would
    // hide part of what the user is paying to change.
    expect(rule).toMatch(/object-fit:\s*contain/)
  })
})

/**
 * The credential must not change how the body is labelled.
 *
 * The third and last cause of the image-edit 400, and the subtlest. `authHeaders` included
 * `'Content-Type': 'application/json'`, and `generate` spread it AFTER the encoder's headers — so
 * a multipart body went out labelled as JSON. Measured against the live gateway with identical
 * multipart bytes:
 *
 *     correct header       402  $0.028572   <- the real per-edit price
 *     application/json     402  $0.010000   <- the gateway cannot read the body
 *
 * The wrong PRICE is what makes this diagnosable: unable to parse the form, the gateway fell back
 * to a default. On the paid call the same failure read `invalid JSON request body`.
 *
 * And it was invisible anonymously: with no credential `authHeaders` returns nothing, so the quote
 * was correctly labelled and only the PAID call broke. Every cheap signal said the fix worked.
 */
describe('the credential does not relabel the body', () => {
  it('does not let the credential change the content type', () => {
    /**
     * The multipart era is over — every endpoint takes JSON — but the property this caught is
     * still worth holding: `authHeaders` must contribute credentials only. It used to add
     * 'Content-Type: application/json' and, spread second, silently relabelled a body. A
     * function named for credentials deciding an encoding is the defect, whatever the encoding.
     */
    expect(authHeaders({ apiKey: 'sk-abc' })).not.toHaveProperty('Content-Type')
    expect(authHeaders({ payment: 'x402' })).not.toHaveProperty('Content-Type')
    const merged = { ...encodeBody({}, { a: 1 }).headers, ...authHeaders({ apiKey: 'sk-abc' }) }
    expect(merged['Content-Type']).toBe('application/json')
    expect(merged.Authorization).toBe('Bearer sk-abc')
  })

  it('still labels a JSON request as JSON', () => {
    // The control. Removing the header from authHeaders must not leave the JSON modes unlabelled —
    // that would break chat, image generation, video, music and speech all at once.
    const encoded = encodeBody({}, { prompt: 'x' })
    const merged = { ...encoded.headers, ...authHeaders({ apiKey: 'sk-abc' }) }
    expect(merged['Content-Type']).toBe('application/json')
  })
})
