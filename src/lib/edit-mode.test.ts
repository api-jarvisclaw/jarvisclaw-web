import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildBody, encodeBody, GENERATIONS, modeForModel, toMultipart } from './modality'

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

/**
 * The paid call is multipart, and the image is a FILE part.
 *
 * Reported as `Edit generation failed (400)`, with the gateway relaying the upstream's words:
 *
 *     {"message":"Invalid multipart form","type":"bad_response_status_code"}
 *
 * I had concluded from the 402 that a JSON body was fine. The quote could not have told me: this
 * endpoint prices a JSON body, an empty body, and four field spellings identically, because the
 * price is issued before the body is read. The refusal comes from the upstream — the blockrun
 * channel forwards our body verbatim (`PassThroughBodyEnabled`) — and only on the PAID call.
 *
 * So the sequence was quote, approve, pay, 400. That is the exact failure this mode was built to
 * prevent, and I introduced it by treating a price as evidence about a body. These tests exist
 * because nothing cheaper can catch it: every earlier signal was a 402.
 */
describe('an edit is encoded the way the upstream can read', () => {
  it('sends the image as a file part, not a base64 text field', () => {
    // The gateway reads MultipartForm.File["image"] and answers "image is required" when the
    // field is only a value — another after-the-charge failure.
    const form = toMultipart({
      model: 'ali/qwen-image-edit-plus',
      prompt: 'make it blue',
      image: 'data:image/png;base64,iVBORw0KGgo=',
    })
    const image = form.get('image')
    expect(image, 'the image must be present').not.toBeNull()
    expect(image instanceof File, 'the image must be a File, not a string').toBe(true)
    expect((image as File).type).toBe('image/png')
    // The gateway derives the part's MIME type from the FILENAME, so an extensionless name is
    // sent as the wrong type.
    expect((image as File).name).toMatch(/\.png$/)
  })

  it('keeps the other quoted fields, so the paid body matches the priced one', () => {
    const form = toMultipart({
      model: 'ali/qwen-image-edit-plus',
      prompt: 'make it blue',
      size: '1024x1024',
      n: 1,
      image: 'data:image/png;base64,iVBORw0KGgo=',
    })
    expect(form.get('model')).toBe('ali/qwen-image-edit-plus')
    expect(form.get('prompt')).toBe('make it blue')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.get('n')).toBe('1')
  })

  it('picks the extension from the mime type', () => {
    const jpeg = toMultipart({ image: 'data:image/jpeg;base64,/9j/4AA=' }).get('image') as File
    expect(jpeg.name).toMatch(/\.jpg$/)
    expect(jpeg.type).toBe('image/jpeg')
  })

  it('drops an undecodable data URL rather than sending it as text', () => {
    // A giant base64 string in a text field would be refused upstream — after the charge.
    const form = toMultipart({ prompt: 'x', image: 'data:image/png;base64,%%%not-base64%%%' })
    expect(form.get('prompt')).toBe('x')
    expect(form.get('image')).toBeNull()
  })

  it('encodes only the modes that need it', () => {
    // Chat, image generation, video, music and speech all take JSON today. Switching them to
    // multipart would break every one of them, so the choice is keyed on the spec flag.
    expect(encodeBody({ requiresSourceImage: true }, { a: 1 }).headers).toEqual({})
    expect(encodeBody({}, { a: 1 }).headers).toEqual({ 'Content-Type': 'application/json' })
    expect(typeof encodeBody({}, { a: 1 }).body).toBe('string')
    expect(encodeBody({ requiresSourceImage: true }, { a: 1 }).body instanceof FormData).toBe(true)
  })

  it('encodes the QUOTE the same way as the paid call', () => {
    /**
     * Both fetches, not one. My first attempt changed only `generate`; the live wire still read
     * `content-type: application/json` because the quote is a separate fetch. A price issued for
     * a JSON body and spent on a multipart one is a signature paying for a request the gateway
     * never priced — so the two must go through one encoder.
     */
    const src = stripComments(readFileSync(new URL('./modality.ts', import.meta.url), 'utf8'))
    const uses = src.match(/encodeBody\(spec, body\)/g) ?? []
    expect(uses.length, 'both challengeGeneration and generate must encode via encodeBody')
      .toBeGreaterThanOrEqual(2)
    // And neither may hand-roll a JSON body beside it, which is how they drifted.
    // Sliced to challengeGeneration ALONE. My first version ran to extractMedia, which swept in
    // encodeBody's own definition — where that header legitimately appears — so the guard failed
    // on correct code.
    const qs = src.indexOf('export async function challengeGeneration')
    const qe = src.indexOf('\nexport ', qs + 10)
    const quote = src.slice(qs, qe)
    expect(quote).toContain('encodeBody(spec, body)')
    expect(quote, 'the quote must not hand-roll its own JSON body').not.toContain(
      "'Content-Type': 'application/json'",
    )
  })

  it('lets the browser set the multipart Content-Type', () => {
    // Only the browser knows the boundary token it generated. A hand-written header yields a body
    // the server cannot split — the same "Invalid multipart form" by another route. So the
    // multipart branch must contribute NO content-type at all.
    const headers = encodeBody({ requiresSourceImage: true }, { a: 1 }).headers
    expect(Object.keys(headers)).toEqual([])
    expect(JSON.stringify(headers)).not.toContain('multipart')
  })
})

/**
 * The options panel cannot be resized by its own contents.
 *
 * Reported as "页面比例不协调" with a screenshot: the panel filled the viewport and pushed its own
 * Size and Count rows off the edge. It had `min-width` and no maximum, so its width was whatever
 * its widest child asked for — and the new thumbnail was an <img> with no dimensions, which
 * contributes its INTRINSIC size. A 2240px screenshot therefore set the panel's width.
 */
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
