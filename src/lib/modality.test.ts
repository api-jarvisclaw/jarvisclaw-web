import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractMedia, generate, GENERATIONS, quoteGeneration } from './modality'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Typed with the fetch signature rather than `async () => Response`, so the tests below
 * can read the request body they sent. A zero-arg mock records no arguments, and asserting
 * on `calls[0][1]` then needs a cast that tsc rejects outright.
 */
function stubResponse(status: number, body: unknown) {
  const spy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

/** The JSON body of the nth fetch this test made. */
function sentBody(spy: ReturnType<typeof stubResponse>, n = 0): Record<string, unknown> {
  const init = spy.mock.calls[n]?.[1]
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

describe('quoteGeneration', () => {
  it('reads the price out of the 402 challenge', async () => {
    // 64000 atomic USDC is what the live gateway quoted for openai/gpt-image-2. Getting
    // the 6-decimal conversion wrong here would show $64,000 or $0.000064 to someone
    // deciding whether to spend.
    stubResponse(402, { accepts: [{ amount: '64000', asset: '0x833589f' }] })
    await expect(quoteGeneration('image', 'a red cube')).resolves.toBeCloseTo(0.064, 6)
  })

  it('converts a video quote at the right magnitude', async () => {
    stubResponse(402, { accepts: [{ amount: '1136480' }] })
    await expect(quoteGeneration('video', 'a cat walking')).resolves.toBeCloseTo(1.13648, 5)
  })

  it('sends duration for video, because the price depends on it', async () => {
    // Quoting without duration would price a different call than the one that runs.
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await quoteGeneration('video', 'a cat', { model: 'bytedance/seedance-2.0-mini' })
    const body = sentBody(spy)
    expect(body).toMatchObject({ duration: 5, model: 'bytedance/seedance-2.0-mini' })
  })

  it('does not send duration for an image', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await quoteGeneration('image', 'a red cube')
    const body = sentBody(spy)
    expect(body).not.toHaveProperty('duration')
  })

  it('names the unservable model on a 400 instead of repeating a cause-free message', async () => {
    // The gateway answers a deliberately cause-free 400 here, and the actual fix is
    // choosing another model — `auto/music` and `ali/qwen-image` are both advertised in
    // the catalogue and both refuse. Passing the gateway's wording through would leave the
    // user with nothing to act on.
    stubResponse(400, { error: { message: 'Request rejected: this request was not accepted as-is.' } })
    await expect(
      quoteGeneration('music', 'a synth loop', { model: 'auto/music' }),
    ).rejects.toThrow(/auto\/music is listed but not currently servable/)
  })

  it('refuses a quote with no amount rather than treating it as free', async () => {
    stubResponse(402, { accepts: [{}] })
    await expect(quoteGeneration('image', 'x')).rejects.toThrow(/quoted no price/)
  })

  it('refuses an unparseable amount rather than passing NaN to a consent dialog', async () => {
    // NaN would render as "$NaN" in the approval prompt, and NaN comparisons are false —
    // so a budget check on it would silently allow the spend.
    stubResponse(402, { accepts: [{ amount: 'not-a-number' }] })
    await expect(quoteGeneration('image', 'x')).rejects.toThrow(/unreadable price/)
  })
})

describe('generate', () => {
  it('says a funded key is needed when the call still answers 402', async () => {
    stubResponse(402, { accepts: [{ amount: '64000' }] })
    await expect(
      generate('image', 'a red cube', { cred: { apiKey: 'k' } }),
    ).rejects.toThrow(/needs a funded key/)
  })

  it('reports a failure status rather than returning an empty result', async () => {
    stubResponse(500, { error: 'upstream exploded' })
    await expect(generate('image', 'x', { cred: { apiKey: 'k' } })).rejects.toThrow(/failed \(500\)/)
  })
})

describe('extractMedia', () => {
  it('reads the OpenAI image shape', () => {
    expect(extractMedia('image', { data: [{ url: 'https://cdn/x.png' }] })).toEqual({
      kind: 'image',
      url: 'https://cdn/x.png',
    })
  })

  it('reads an inlined base64 image', () => {
    expect(extractMedia('image', { data: [{ b64_json: 'AAAA' }] })).toEqual({
      kind: 'image',
      b64: 'AAAA',
    })
  })

  it('reads a top-level url', () => {
    expect(extractMedia('video', { url: 'https://cdn/v.mp4' })).toEqual({
      kind: 'video',
      url: 'https://cdn/v.mp4',
    })
  })

  it('reads a nested video url', () => {
    // The MixRoute task adaptor showed both locations in one API, and the contract
    // promises neither — so both are read rather than guessed at.
    expect(extractMedia('video', { data: { video_url: 'https://cdn/n.mp4' } })).toEqual({
      kind: 'video',
      url: 'https://cdn/n.mp4',
    })
  })

  it('returns the raw body when nothing matches, so a paid call is never silently blank', () => {
    // The important case: money was spent. Showing an empty player would be
    // indistinguishable from a charge that produced nothing.
    const out = extractMedia('music', { status: 'succeeded', id: 'abc' })
    expect(out.url).toBeUndefined()
    expect(out.b64).toBeUndefined()
    expect(out.raw).toContain('succeeded')
  })

  it('ignores a non-string url instead of rendering it', () => {
    const out = extractMedia('image', { data: [{ url: 42 }] })
    expect(out.url).toBeUndefined()
    expect(out.raw).toBeDefined()
  })
})

describe('GENERATIONS defaults', () => {
  it('points every mode at an endpoint verified against the live gateway', () => {
    expect(GENERATIONS.image.path).toBe('/v1/images/generations')
    expect(GENERATIONS.video.path).toBe('/v1/videos/generations')
    expect(GENERATIONS.music.path).toBe('/v1/audio/generations')
  })

  it('avoids auto/* defaults, which the gateway advertises but cannot serve', () => {
    // Measured: auto/music answers 400 while minimax/music-2.5+ quotes $0.159. A default
    // picked from the catalogue by name would break the button for everyone.
    for (const spec of Object.values(GENERATIONS)) {
      expect(spec.defaultModel.startsWith('auto/')).toBe(false)
    }
  })
})
