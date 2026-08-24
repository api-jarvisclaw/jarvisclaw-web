import { afterEach, describe, expect, it, vi } from 'vitest'

import { challengeGeneration, extractMedia, generate, GENERATIONS } from './modality'

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

describe('generate', () => {
  it('says the payment was not accepted when the call still answers 402', async () => {
    // A second 402 after paying means the signature was refused — a funded wallet is the
    // fix, and the message has to say so rather than repeat the price.
    stubResponse(402, { accepts: [{ amount: '64000' }] })
    await expect(
      generate('image', 'a red cube', { cred: { payment: 'eyJ4NDAy' } }),
    ).rejects.toThrow(/did not accept the payment/)
  })

  it('sends the payment as X-PAYMENT', async () => {
    const spy = stubResponse(200, { data: [{ url: 'https://cdn/x.png' }] })
    await generate('image', 'x', { cred: { payment: 'PAYLOAD' } })
    const headers = (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers['X-PAYMENT']).toBe('PAYLOAD')
  })

  it('spends the signature on the exact body it was issued for', async () => {
    // A payment signed for one body and spent on another is a signature the facilitator may
    // settle while the gateway serves something else. The caller passes the challenge's own
    // url and body through, and they must be used verbatim.
    const spy = stubResponse(200, { data: [{ url: 'https://cdn/x.png' }] })
    await generate('video', 'ignored prompt', {
      cred: { payment: 'P' },
      url: 'https://api.example/v1/videos/generations',
      body: { model: 'bytedance/seedance-2.0-mini', prompt: 'the quoted prompt', duration: 5 },
    })
    expect(spy.mock.calls[0]?.[0]).toBe('https://api.example/v1/videos/generations')
    expect(sentBody(spy)).toMatchObject({ prompt: 'the quoted prompt', duration: 5 })
  })

  it('reports a failure status rather than returning an empty result', async () => {
    stubResponse(500, { error: 'upstream exploded' })
    await expect(generate('image', 'x', { cred: { payment: 'P' } })).rejects.toThrow(/failed \(500\)/)
  })
})

describe('challengeGeneration', () => {
  it('returns the whole challenge, so a wallet can sign the gateway’s own terms', async () => {
    // Not just the price: the signature is made over payTo, asset and network as the gateway
    // stated them. Re-deriving those from a price would be inventing them.
    stubResponse(402, {
      accepts: [
        { amount: '64000', payTo: '0xDC59', asset: '0x8335', network: 'eip155:8453', scheme: 'exact' },
      ],
    })
    const q = await challengeGeneration('image', 'a red cube')
    expect(q.usd).toBeCloseTo(0.064, 6)
    expect(q.challenge.accepts?.[0]).toMatchObject({ payTo: '0xDC59', network: 'eip155:8453' })
    expect(q.url).toContain('/v1/images/generations')
    expect(q.body).toMatchObject({ prompt: 'a red cube' })
  })

  it('asks for the price with no credential at all', async () => {
    // The quote must work for an unconnected visitor: that is how someone learns a video
    // costs $0.40 before deciding whether to connect a wallet.
    const spy = stubResponse(402, { accepts: [{ amount: '1000' }] })
    await challengeGeneration('image', 'x')
    const headers = (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['X-PAYMENT']).toBeUndefined()
  })

  it('refuses a challenge with no usable amount', async () => {
    stubResponse(402, { accepts: [{ payTo: '0xDC59' }] })
    await expect(challengeGeneration('image', 'x')).rejects.toThrow(/no usable price/)
  })

  it('converts a video quote at the right magnitude', async () => {
    // 6-decimal atomic USDC. Getting this wrong shows $1,136,480 or $0.0000011 to someone
    // deciding whether to sign.
    stubResponse(402, { accepts: [{ amount: '1136480' }] })
    await expect(challengeGeneration('video', 'a cat')).resolves.toMatchObject({
      usd: expect.closeTo(1.13648, 5),
    })
  })

  it('sends duration for video, because the price depends on it', async () => {
    // Quoting without duration prices a different call than the one the signature pays for.
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('video', 'a cat', { model: 'bytedance/seedance-2.0-mini' })
    expect(sentBody(spy)).toMatchObject({ duration: 5, model: 'bytedance/seedance-2.0-mini' })
  })

  it('does not send duration for an image', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('image', 'a red cube')
    expect(sentBody(spy)).not.toHaveProperty('duration')
  })

  it('names the unservable model on a 400 instead of repeating a cause-free message', async () => {
    // The gateway answers a deliberately cause-free 400, and the actual fix is choosing
    // another model — `auto/music` and `ali/qwen-image` are both advertised and both refuse.
    stubResponse(400, { error: { message: 'Request rejected: this request was not accepted as-is.' } })
    await expect(
      challengeGeneration('music', 'a synth loop', { model: 'auto/music' }),
    ).rejects.toThrow(/auto\/music is listed but not currently servable/)
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
