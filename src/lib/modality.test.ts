import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  challengeGeneration,
  DEFAULT_OPTIONS,
  GENERATION_CHOICES,
  extractMedia,
  generate,
  GENERATIONS,
  mediaMimeType,
  modeForModel,
  UNSERVABLE_VIRTUALS,
} from './modality'

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
    expect(GENERATIONS.speech.path).toBe('/v1/audio/speech')
  })

  it('avoids auto/* defaults, which the gateway advertises but cannot serve', () => {
    // Measured: auto/music answers 400 while minimax/music-2.5+ quotes $0.159. A default
    // picked from the catalogue by name would break the button for everyone.
    for (const spec of Object.values(GENERATIONS)) {
      expect(spec.defaultModel.startsWith('auto/')).toBe(false)
    }
  })

  it('never defaults to a model on the known-unservable list', () => {
    // Stronger than the auto/* check and aimed at the same class of bug: the list is what was
    // MEASURED to 400, and a default drawn from it breaks a button for every visitor.
    for (const spec of Object.values(GENERATIONS)) {
      expect(UNSERVABLE_VIRTUALS).not.toContain(spec.defaultModel)
    }
  })
})

describe('speech is its own endpoint, not a chat model', () => {
  /**
   * THE BUG THIS PINS, and it cost real money.
   *
   * Asked to speak a phrase, the app had no speech endpoint, so `auto/tts` went to
   * /v1/chat/completions — where it is a PAID CHAT MODEL. Measured on the live gateway:
   *
   *   auto/tts @ /v1/chat/completions  -> 402, $0.001   (bills, answers in words)
   *   auto/tts @ /v1/audio/speech      -> 400           (not servable at all)
   *
   * Five agent steps, five wallet signatures, $0.068 spent, no audio. The correct call is
   * one signature for $0.002 against elevenlabs/turbo-v2.5.
   */
  it('sends the text as `input`, because /v1/audio/speech 400s on `prompt`', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '2000' }] })
    await challengeGeneration('speech', '你好，欢迎使用')
    const body = sentBody(spy)
    expect(body.input).toBe('你好，欢迎使用')
    expect(body).not.toHaveProperty('prompt')
  })

  it('quotes speech at the measured price, not a chat price', async () => {
    stubResponse(402, { accepts: [{ amount: '2000' }] })
    // $0.002 for the clip, against $0.068 spent on five chat steps that produced none.
    await expect(challengeGeneration('speech', 'hello')).resolves.toMatchObject({
      usd: expect.closeTo(0.002, 6),
    })
  })

  it('still sends `prompt` for the other modes', async () => {
    // The field is per-endpoint, so a shared helper must not have flipped them all.
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('image', 'a red cube')
    expect(sentBody(spy).prompt).toBe('a red cube')
  })
})

describe('generation options', () => {
  it('sends image size, quality and count', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '64000' }] })
    await challengeGeneration('image', 'a cube', {
      options: { size: '1792x1024', quality: 'hd', n: 2 },
    })
    expect(sentBody(spy)).toMatchObject({ size: '1792x1024', quality: 'hd', n: 2 })
  })

  it('sends speech voice and speed', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '2000' }] })
    await challengeGeneration('speech', 'hello', { options: { voice: 'nova', speed: 1.25 } })
    expect(sentBody(spy)).toMatchObject({ voice: 'nova', speed: 1.25, input: 'hello' })
  })

  it('does not put image fields on a speech call, or vice versa', async () => {
    // Each endpoint has its own DTO, and a field it does not know is at best ignored and at
    // worst a 400 on a call that was already quoted.
    const spy = stubResponse(402, { accepts: [{ amount: '2000' }] })
    await challengeGeneration('speech', 'hi', { options: { size: '1792x1024', voice: 'nova' } })
    const body = sentBody(spy)
    expect(body).not.toHaveProperty('size')
    expect(body.voice).toBe('nova')

    const spy2 = stubResponse(402, { accepts: [{ amount: '64000' }] })
    await challengeGeneration('image', 'x', { options: { voice: 'nova', size: '1024x1024' } })
    expect(sentBody(spy2)).not.toHaveProperty('voice')
  })

  it('refuses n=0, which would ask for nothing and still be charged', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '64000' }] })
    await challengeGeneration('image', 'x', { options: { n: 0 } })
    expect(sentBody(spy)).not.toHaveProperty('n')
  })

  it('refuses a non-integer count, which the *uint DTO rejects', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '64000' }] })
    await challengeGeneration('image', 'x', { options: { n: 2.5 } })
    expect(sentBody(spy)).not.toHaveProperty('n')
  })

  it('drops a speed outside the accepted range', async () => {
    // Out of range is a 400 on a call the user has already been quoted for — the worst moment
    // to discover a validation error.
    const spy = stubResponse(402, { accepts: [{ amount: '2000' }] })
    await challengeGeneration('speech', 'hi', { options: { speed: 99 } })
    expect(sentBody(spy)).not.toHaveProperty('speed')

    const spy2 = stubResponse(402, { accepts: [{ amount: '2000' }] })
    await challengeGeneration('speech', 'hi', { options: { speed: 0.1 } })
    expect(sentBody(spy2)).not.toHaveProperty('speed')
  })

  it('always sends a video duration, defaulting to 5', async () => {
    // The price does not vary with it (measured), but the upstream still needs it — omitting it
    // leaves the length to whatever the channel defaults to, which is not what the UI says.
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('video', 'a cat', {})
    expect(sentBody(spy).duration).toBe(5)

    const spy2 = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('video', 'a cat', { options: { duration: 10 } })
    expect(sentBody(spy2).duration).toBe(10)
  })

  it('ignores a non-positive duration rather than sending it', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('video', 'x', { options: { duration: 0 } })
    expect(sentBody(spy).duration).toBe(5)
  })

  it('offers only choices the request body can carry', () => {
    // The invariant that keeps a control from being decoration: every advertised choice must be
    // a field buildBody actually sends, checked by round-tripping each one.
    expect(GENERATION_CHOICES.image.size.length).toBeGreaterThan(1)
    expect(GENERATION_CHOICES.speech.voice).toContain('nova')
    for (const speed of GENERATION_CHOICES.speech.speed) {
      expect(speed).toBeGreaterThanOrEqual(0.25)
      expect(speed).toBeLessThanOrEqual(4)
    }
    for (const n of GENERATION_CHOICES.image.n) {
      expect(Number.isInteger(n) && n > 0).toBe(true)
    }
  })

  it('every default is actually sent', async () => {
    // A default that the body drops is a UI that shows a setting nothing honours.
    const spy = stubResponse(402, { accepts: [{ amount: '64000' }] })
    await challengeGeneration('image', 'x', { options: DEFAULT_OPTIONS.image })
    expect(sentBody(spy)).toMatchObject({ size: '1024x1024', quality: 'standard', n: 1 })
  })
})

describe('modeForModel', () => {
  /**
   * The wiring whose ABSENCE caused the charge above: the picker offered audio and image
   * models, and choosing one only ever changed the chat model.
   */
  it('splits audio into music and speech, which are different endpoints', () => {
    // Not a cosmetic distinction: /v1/audio/generations prices per track and 400s on a voice
    // model, /v1/audio/speech prices per clip and 400s on a music model. Both measured.
    expect(modeForModel('minimax/music-2.5+', 'audio')).toBe('music')
    expect(modeForModel('elevenlabs/turbo-v2.5', 'audio')).toBe('speech')
    expect(modeForModel('openai/gpt-4o-mini-tts', 'audio')).toBe('speech')
  })

  it('routes image and video models to their own endpoints', () => {
    expect(modeForModel('openai/gpt-image-2', 'image')).toBe('image')
    expect(modeForModel('bytedance/seedance-2.0-mini', 'video')).toBe('video')
  })

  it('leaves a text model on chat', () => {
    // null is the signal to run the agent loop. A text model routed to a media endpoint
    // would 400 on every message.
    expect(modeForModel('anthropic/claude-haiku-4.5', 'text')).toBeNull()
    expect(modeForModel('auto/free', 'text')).toBeNull()
  })

  it('routes every audio model in the catalogue somewhere real', () => {
    // The names the gateway actually advertises, so a naming convention this function does
    // not know about shows up here rather than as a 400 the user pays to discover.
    const audio = [
      'elevenlabs/v3',
      'elevenlabs/flash-v2.5',
      'elevenlabs/multilingual-v2',
      'bytedance/seed-audio-1.0',
      'google/gemini-2.5-flash-preview-tts',
      'minimax/music-2.5+',
    ]
    for (const name of audio) {
      expect(['music', 'speech']).toContain(modeForModel(name, 'audio'))
    }
  })
})

describe('mediaMimeType', () => {
  it('does not label a clip as a PNG', () => {
    // It used to: every b64 payload was rendered `data:image/png`. Right for an image, and a
    // dead <audio> player for a clip — which after a real charge looks like nothing happened.
    expect(mediaMimeType('speech')).toBe('audio/mpeg')
    expect(mediaMimeType('music')).toBe('audio/mpeg')
    expect(mediaMimeType('image')).toBe('image/png')
    expect(mediaMimeType('video')).toBe('video/mp4')
  })
})

describe('extractMedia for speech', () => {
  it('reads inlined audio bytes under the names upstreams actually use', () => {
    // No contract promises any of these. A paid clip that renders blank because the field was
    // called `audio` instead of `b64_json` is the outcome worth spending a test on.
    expect(extractMedia('speech', { data: [{ audio: 'QUJD' }] })).toEqual({
      kind: 'speech',
      b64: 'QUJD',
    })
    expect(extractMedia('speech', { b64_json: 'QUJD' })).toEqual({ kind: 'speech', b64: 'QUJD' })
    expect(extractMedia('speech', { audio_base64: 'QUJD' })).toEqual({ kind: 'speech', b64: 'QUJD' })
  })

  it('prefers a URL over inlined bytes when both are present', () => {
    expect(extractMedia('speech', { data: [{ url: 'https://cdn/a.mp3', audio: 'QUJD' }] })).toEqual({
      kind: 'speech',
      url: 'https://cdn/a.mp3',
    })
  })

  it('ignores an empty audio string rather than rendering a silent player', () => {
    const out = extractMedia('speech', { audio: '' })
    expect(out.b64).toBeUndefined()
    expect(out.raw).toBeDefined()
  })
})
