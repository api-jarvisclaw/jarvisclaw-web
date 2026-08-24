import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  displayPrice,
  inferModality,
  listCatalogue,
  listMarketplace,
  MODALITY_PATTERNS,
} from './catalogue'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubJson(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

describe('inferModality', () => {
  it('reads the auto/* names exactly rather than by substring', () => {
    // These are the gateway's virtual models. `auto/music` contains no audio keyword and
    // `auto/image` would otherwise be the only one matched, so an exact table is the only
    // thing that gets all four right.
    expect(inferModality('auto/music')).toBe('audio')
    expect(inferModality('auto/tts')).toBe('audio')
    expect(inferModality('auto/video')).toBe('video')
    expect(inferModality('auto/image')).toBe('image')
    expect(inferModality('auto/free')).toBe('text')
  })

  it('files voice models under audio', () => {
    expect(inferModality('google/gemini-2.5-flash-preview-tts')).toBe('audio')
    expect(inferModality('elevenlabs/flash-v2.5')).toBe('audio')
    expect(inferModality('minimax/music-2.5+')).toBe('audio')
  })

  it('classifies every name by exactly one pattern, so branch order is not load-bearing', () => {
    // The property worth pinning. I first wrote a test claiming `flash` collided with the
    // image patterns and that ordering fixed it — neither was true, and swapping the
    // branches left every test green. This asserts the real invariant instead: while no
    // name matches two categories, the order is free; the day one does, this fails and the
    // intended answer has to be chosen deliberately.
    const names = [
      'google/gemini-2.5-flash-preview-tts',
      'elevenlabs/flash-v2.5',
      'xai/grok-imagine-video-1.5',
      'bytedance/seedance-2.0-mini',
      'bytedance/seedream-5-pro',
      'openai/gpt-image-2',
      'ali/qwen-image-edit-max',
      'minimax/music-2.5+',
      'azure/sora-2',
      'openai/text-embedding-3-large',
      'nvidia/step-3.7-flash',
    ]

    for (const name of names) {
      const hits = MODALITY_PATTERNS.filter(([, re]) => re.test(name.toLowerCase())).map(
        ([modality]) => modality,
      )
      expect(hits.length, `${name} matched ${hits.join(', ')}`).toBeLessThanOrEqual(1)
    }
  })

  it('classifies the real catalogue names', () => {
    expect(inferModality('bytedance/seedance-2.0-mini')).toBe('video')
    expect(inferModality('azure/sora-2')).toBe('video')
    expect(inferModality('xai/grok-imagine-video-1.5')).toBe('video')
    expect(inferModality('bytedance/seedream-5-pro')).toBe('image')
    expect(inferModality('openai/gpt-image-2')).toBe('image')
    expect(inferModality('nvidia/step-3.7-flash')).toBe('text')
    expect(inferModality('openai/text-embedding-3-large')).toBe('embedding')
  })
})

describe('displayPrice', () => {
  it('says a per-call model is quoted rather than inventing a rate', () => {
    // The catalogue reports 0/0 for per-call models — seedance, sora, gpt-image-2 all do.
    // Rendering "$0.00/M out" would advertise a $1.14 video as free, which is the worst
    // possible direction for this mistake.
    expect(
      displayPrice({
        model: 'bytedance/seedance-2.0',
        inputPerMTokenUsd: 0,
        outputPerMTokenUsd: 0,
        pricingType: 'per-call',
        free: false,
        virtual: false,
        modality: 'video',
      }),
    ).toBe('quoted per call')
  })

  it('marks a genuinely free model free', () => {
    expect(
      displayPrice({
        model: 'zai/glm-4-flash',
        inputPerMTokenUsd: 0,
        outputPerMTokenUsd: 0,
        pricingType: 'per-token',
        free: true,
        virtual: false,
        modality: 'text',
      }),
    ).toBe('free')
  })

  it('shows the output rate for metered models', () => {
    expect(
      displayPrice({
        model: 'openai/gpt-audio',
        inputPerMTokenUsd: 2.5,
        outputPerMTokenUsd: 10,
        pricingType: 'per-token',
        free: false,
        virtual: false,
        modality: 'audio',
      }),
    ).toBe('$10.00/M out')
  })
})

describe('listCatalogue', () => {
  it('reads the discovery shape and marks auto/* virtual', async () => {
    stubJson({
      data: [
        { model: 'auto/free', input_per_m_token_usd: 0, output_per_m_token_usd: 0, free: true, pricing_type: 'per-token' },
        { model: 'openai/gpt-image-2', input_per_m_token_usd: 0, output_per_m_token_usd: 0, free: false, pricing_type: 'per-call' },
      ],
    })
    const rows = await listCatalogue()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ model: 'auto/free', free: true, virtual: true, modality: 'text' })
    expect(rows[1]).toMatchObject({ model: 'openai/gpt-image-2', virtual: false, modality: 'image' })
  })

  it('drops rows with no model name instead of rendering blanks', async () => {
    // Defensive because this is a public endpoint whose shape we do not own: one malformed
    // row must not put an unclickable empty entry in the picker.
    stubJson({ data: [{ model: '' }, { input_per_m_token_usd: 1 }, { model: 'zai/glm-4-flash', free: true }] })
    const rows = await listCatalogue()
    expect(rows.map((r) => r.model)).toEqual(['zai/glm-4-flash'])
  })

  it('returns empty rather than throwing when data is missing', async () => {
    stubJson({ success: false })
    await expect(listCatalogue()).resolves.toEqual([])
  })
})

describe('listMarketplace', () => {
  it('groups 2700 endpoints into browsable services', async () => {
    stubJson({
      resources: [
        { endpoint: '/v1/marketplace/exa/search', description: 'Neural web search' },
        { endpoint: '/v1/marketplace/exa/contents' },
        { endpoint: '/v1/marketplace/surf/wallet/holdings' },
        // Not a marketplace path — must not become a service called "chat".
        { endpoint: '/v1/chat/completions', description: 'Chat completions' },
      ],
    })
    const services = await listMarketplace()
    expect(services.map((s) => s.service)).toEqual(['exa', 'surf'])
    expect(services[0].endpoints).toBe(2)
    expect(services[0].description).toBe('Neural web search')
  })

  it('sorts by endpoint count so the substantial services come first', async () => {
    stubJson({
      resources: [
        { endpoint: '/v1/marketplace/small/one' },
        { endpoint: '/v1/marketplace/big/a' },
        { endpoint: '/v1/marketplace/big/b' },
        { endpoint: '/v1/marketplace/big/c' },
      ],
    })
    const services = await listMarketplace()
    expect(services[0].service).toBe('big')
  })

  it('takes a description from a later entry when the first has none', async () => {
    // Most entries in the real document carry no description, so keeping only the first
    // row's would leave nearly every card blank.
    stubJson({
      resources: [
        { endpoint: '/v1/marketplace/exa/search' },
        { endpoint: '/v1/marketplace/exa/contents', description: 'Fetch page contents' },
      ],
    })
    const services = await listMarketplace()
    expect(services[0].description).toBe('Fetch page contents')
  })
})
