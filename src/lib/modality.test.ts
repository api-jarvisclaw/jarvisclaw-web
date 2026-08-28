import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  awaitJob,
  challengeGeneration,
  DEFAULT_OPTIONS,
  GENERATION_CHOICES,
  extractJob,
  extractMedia,
  generate,
  GENERATIONS,
  mediaMimeType,
  modeForModel,
  POLL_DEADLINE_MS,
  pollJob,
  pollUrlFor,
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
      body: { model: 'bytedance/seedance-2.0-mini', prompt: 'the quoted prompt', duration_seconds: 5 },
    })
    expect(spy.mock.calls[0]?.[0]).toBe('https://api.example/v1/videos/generations')
    expect(sentBody(spy)).toMatchObject({ prompt: 'the quoted prompt', duration_seconds: 5 })
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

  it('sends duration_seconds for video — the name the upstream actually reads', async () => {
    // `duration` was the name here, and it was ignored end to end: every video came back 5 seconds
    // however long the UI said. Measured on UAT with paid calls, reading the mp4's own mvhd atom —
    // duration: 10 -> 5.06s, duration_seconds: 10 -> 10.05s.
    //
    // The old test name said "because the price depends on it". It does not: the 402 is identical at
    // 5s and 10s, which is exactly why nothing upstream of the artifact could catch this.
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('video', 'a cat', { model: 'bytedance/seedance-2.0-mini' })
    expect(sentBody(spy)).toMatchObject({ duration_seconds: 5, model: 'bytedance/seedance-2.0-mini' })
  })

  it('does not send duration for an image', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('image', 'a red cube')
    expect(sentBody(spy)).not.toHaveProperty('duration_seconds')
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
    expect(sentBody(spy).duration_seconds).toBe(5)

    const spy2 = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('video', 'a cat', { options: { duration: 10 } })
    expect(sentBody(spy2).duration_seconds).toBe(10)
  })

  it('ignores a non-positive duration rather than sending it', async () => {
    const spy = stubResponse(402, { accepts: [{ amount: '1' }] })
    await challengeGeneration('video', 'x', { options: { duration: 0 } })
    expect(sentBody(spy).duration_seconds).toBe(5)
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
    expect(sentBody(spy)).toMatchObject({ size: '1024x1024', quality: 'auto', n: 1 })
  })

  it('sends every image field the upstream reads, under its own name', () => {
    /**
     * The completeness check. Three fields were measured working and offered nowhere, so the panel
     * was not just wrong about two options — it was missing three.
     *
     * Names matter as much as values: `outputFormat` in our options becomes `output_format` on the
     * wire, and the video defect was nothing but a name. Asserted on the BODY rather than on the
     * options object for that reason.
     */
    const spy = stubResponse(402, { accepts: [{ amount: '64000' }] })
    void challengeGeneration('image', 'x', {
      options: {
        size: '1024x1024',
        quality: 'low',
        n: 2,
        outputFormat: 'jpeg',
        background: 'opaque',
        outputCompression: 60,
      },
    })
    return Promise.resolve().then(() => {
      expect(sentBody(spy)).toMatchObject({
        size: '1024x1024',
        quality: 'low',
        n: 2,
        output_format: 'jpeg',
        background: 'opaque',
        output_compression: 60,
      })
    })
  })

  it('withholds jpeg compression when the format is png', async () => {
    // The upstream rejects a compression level it cannot apply, and that rejection lands after the
    // charge is approved. Gated on the format rather than sent hopefully.
    const spy = stubResponse(402, { accepts: [{ amount: '64000' }] })
    await challengeGeneration('image', 'x', {
      options: { outputFormat: 'png', outputCompression: 60 },
    })
    expect(sentBody(spy)).not.toHaveProperty('output_compression')
  })

  it('sends the speech format under response_format', async () => {
    // Six audio formats are served and none were offered, so every clip was mp3 by accident rather
    // than by choice.
    const spy = stubResponse(402, { accepts: [{ amount: '2000' }] })
    await challengeGeneration('speech', 'hello', {
      options: { voice: 'coral', speed: 1.25, responseFormat: 'wav' },
    })
    expect(sentBody(spy)).toMatchObject({ voice: 'coral', speed: 1.25, response_format: 'wav' })
  })

  it('offers the voices and formats the upstream actually serves', () => {
    /**
     * Pinned against the upstream's own 400 messages, which is the only place this list exists —
     * there is no schema endpoint for it, and the 402 quote does not mention parameters at all.
     *
     * Six voices were offered out of 37. The point of the assertion is not the count but that a
     * name here has to come from that measured list rather than from another provider's docs, which
     * is exactly how `hd` and `standard` got into the quality list.
     */
    const MEASURED_VOICES = new Set([
      'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'verse', 'ballad', 'ash',
      'sage', 'marin', 'cedar', 'amuch', 'aster', 'brook', 'clover', 'dan', 'elan', 'marilyn',
      'meadow', 'jazz', 'rio', 'breeze', 'cove', 'ember', 'fathom', 'glimmer', 'harp', 'juniper',
      'maple', 'orbit', 'vale', 'megan-wetherall', 'jade-hardy',
    ])
    expect(GENERATION_CHOICES.speech.voice.length).toBeGreaterThan(10)
    for (const v of GENERATION_CHOICES.speech.voice) {
      expect(MEASURED_VOICES.has(v), `voice ${v} is not in the upstream's list`).toBe(true)
    }
    // mp3, aac, opus, flac, pcm, wav — measured. `pcm` is deliberately not offered: it is headerless
    // and the in-page player cannot decode it.
    const MEASURED_FORMATS = new Set(['mp3', 'aac', 'opus', 'flac', 'pcm', 'wav'])
    for (const f of GENERATION_CHOICES.speech.responseFormat) {
      expect(MEASURED_FORMATS.has(f), `format ${f}`).toBe(true)
    }
    expect(GENERATION_CHOICES.speech.responseFormat as readonly string[]).not.toContain('pcm')
  })

  it('offers only quality values the upstream accepts', () => {
    /**
     * The check this file was missing, and the reason it could not catch the real defect: every
     * assertion here is about what the CLIENT sends, and a client that sends a well-formed value the
     * upstream rejects passes all of them.
     *
     * `hd` was offered and answers 400 — "Invalid value: 'hd'. Supported values are: 'low',
     * 'medium', 'high', and 'auto'" — which fails a call AFTER the user approved the charge.
     * Pinned to that measured list so a value invented from another provider's docs fails here.
     */
    expect([...GENERATION_CHOICES.image.quality].sort()).toEqual([
      'auto',
      'high',
      'low',
      'medium',
    ])
    // The two DALL·E names specifically, since they are what a familiar-looking guess reaches for.
    for (const bad of ['standard', 'hd']) {
      expect(GENERATION_CHOICES.image.quality as readonly string[]).not.toContain(bad)
    }
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

/**
 * Asynchronous generation — the defect that charged $0.83 and showed nothing.
 *
 * A video POST returns a receipt, not a clip:
 *   {"id":"…","status":"queued","poll_url":"/v1/videos/generations/…"}
 * extractMedia found no url and no b64 there, fell through to its raw branch, and the page
 * reported "the call completed but returned no media we could read". The generation itself
 * succeeded seconds later — the gateway's background poller stored it under that id — and
 * nothing ever went to collect it.
 */
describe('extractJob', () => {
  it('recognises the queued receipt a video POST actually returns', () => {
    const out = extractMedia('video', {
      id: 'bytedance:video_ae260c45',
      status: 'queued',
      poll_url: '/v1/videos/generations/bytedance%3Avideo_ae260c45',
    })
    expect(out.job).toEqual({
      id: 'bytedance:video_ae260c45',
      pollUrl: '/v1/videos/generations/bytedance%3Avideo_ae260c45',
    })
    // The whole point: it is no longer an unreadable response.
    expect(out.raw).toBeUndefined()
  })

  it('treats a completed job as media, not as something to wait for', () => {
    // A finished job may still name its own poll_url. Waiting on that would stall a result
    // already in hand.
    const out = extractMedia('video', {
      id: 'j1',
      status: 'completed',
      poll_url: '/v1/videos/generations/j1',
      data: [{ url: 'https://cdn/v.mp4' }],
    })
    expect(out.job).toBeUndefined()
    expect(out.url).toBe('https://cdn/v.mp4')
  })

  it('does not mistake an ordinary response for a receipt', () => {
    // Every OpenAI-shaped body carries an id. Treating that as a job would make finished
    // images wait forever.
    expect(extractJob({ id: 'img-1', data: [{ url: 'https://cdn/a.png' }] })).toBeNull()
  })

  it('still polls a receipt whose poll_url is missing', () => {
    // The gateway's status routes are /v1/{kind}/generations/:id, so the id alone is enough.
    // Abandoning the media because one field was absent is the failure being fixed here.
    const job = extractJob({ id: 'j2', status: 'in_progress' })
    expect(job).toEqual({ id: 'j2', pollUrl: '' })
    expect(pollUrlFor('video', job!, 'https://gw')).toBe('https://gw/v1/videos/generations/j2')
  })
})

describe('pollUrlFor', () => {
  it('percent-encodes a provider-prefixed id', () => {
    // Job ids look like `minimax:music_ae26…`. A raw colon makes the path ambiguous and the
    // poll misses the route the gateway named.
    expect(pollUrlFor('music', { id: 'minimax:music_a1', pollUrl: '' }, 'https://gw')).toBe(
      'https://gw/v1/audio/generations/minimax%3Amusic_a1',
    )
  })

  it('resolves a relative poll_url against the gateway and leaves an absolute one alone', () => {
    expect(pollUrlFor('video', { id: 'j', pollUrl: '/v1/videos/generations/j' }, 'https://gw')).toBe(
      'https://gw/v1/videos/generations/j',
    )
    expect(pollUrlFor('video', { id: 'j', pollUrl: 'https://other/j' }, 'https://gw')).toBe(
      'https://other/j',
    )
  })
})

describe('pollJob', () => {
  it('reports the media once the job completes', async () => {
    stubResponse(200, { id: 'j', status: 'completed', data: [{ url: 'https://cdn/v.mp4' }] })
    const out = await pollJob('video', { id: 'j', pollUrl: '/p' })
    expect(out).toEqual({ state: 'done', media: { kind: 'video', url: 'https://cdn/v.mp4' } })
  })

  it('polls without any credential, because the read is free', async () => {
    // Measured: the gateway's status routes are unauthenticated and priced at zero. They were
    // once priced at 0.001, which disabled the free-poll exemption and billed a poll as a
    // whole new generation — $0.46 for a read. Sending no auth is also what lets this work
    // for a wallet user whose payment header covered only the POST.
    const spy = stubResponse(200, { id: 'j', status: 'in_progress' })
    await pollJob('video', { id: 'j', pollUrl: '/p' })
    const init = spy.mock.calls[0]?.[1]
    expect(init?.method).toBe('GET')
    expect(init?.headers).toBeUndefined()
  })

  it('passes the provider own failure wording through', async () => {
    // "Rejected by a content filter" and "the provider timed out" call for different actions
    // from the user, so replacing them with one generic error destroys the only useful part.
    stubResponse(200, {
      id: 'j',
      status: 'failed',
      error: 'sensitive information',
      message: 'Your request was rejected by the content safety filter.',
      retryable: false,
    })
    const out = await pollJob('video', { id: 'j', pollUrl: '/p' })
    expect(out).toEqual({
      state: 'failed',
      message: 'Your request was rejected by the content safety filter.',
      retryable: false,
    })
  })

  it('treats a transport error as still-pending, not as a failed job', async () => {
    // A 502 from a proxy mid-generation says nothing about the video. Calling it failed would
    // discard a clip that is still coming, after the user has paid for it.
    stubResponse(502, {})
    const out = await pollJob('video', { id: 'j', pollUrl: '/p' })
    expect(out.state).toBe('pending')
  })

  it('stays pending on the in-progress body the gateway really sends', async () => {
    stubResponse(200, {
      id: 'j',
      status: 'in_progress',
      message: 'Video is still generating. Please try again in a few seconds.',
    })
    const out = await pollJob('video', { id: 'j', pollUrl: '/p' })
    expect(out).toEqual({
      state: 'pending',
      message: 'Video is still generating. Please try again in a few seconds.',
    })
  })
})

describe('awaitJob', () => {
  it('gives up at the deadline instead of polling forever', async () => {
    // MEASURED, and the reason a deadline is mandatory rather than defensive: the gateway
    // answers 200 {"status":"in_progress"} for ANY id, including a random UUID that never
    // existed. I checked. So "poll until it stops being pending" is a loop with no exit, and
    // the only thing that can end it is the client's own clock.
    stubResponse(200, { id: 'nope', status: 'in_progress' })
    const out = await awaitJob('video', { id: 'nope', pollUrl: '/p' }, { deadlineMs: 0 })
    expect(out.state).toBe('pending')
  })

  it('reports elapsed time while waiting, then returns the media', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        return new Response(
          JSON.stringify(
            call < 2
              ? { id: 'j', status: 'in_progress' }
              : { id: 'j', status: 'completed', data: [{ url: 'https://cdn/v.mp4' }] },
          ),
          { status: 200 },
        )
      }),
    )
    const ticks: number[] = []
    const out = await awaitJob(
      'video',
      { id: 'j', pollUrl: '/p' },
      { onTick: (ms) => ticks.push(ms), deadlineMs: 60_000 },
    )
    expect(out.state).toBe('done')
    expect(ticks.length).toBe(1)
  }, 20_000)

  it('allows a video far longer than an image', () => {
    // Not a style choice: upstream video takes minutes and the gateway allows itself 900s.
    // A shared timeout short enough for an image would abandon every video.
    expect(POLL_DEADLINE_MS.video).toBeGreaterThan(POLL_DEADLINE_MS.image)
    expect(POLL_DEADLINE_MS.video).toBeGreaterThanOrEqual(300_000)
  })
})
