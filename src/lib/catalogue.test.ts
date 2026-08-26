import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CATEGORY_LABELS,
  categoryLabel,
  displayPrice,
  inferModality,
  listApis,
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

describe('categoryLabel', () => {
  it('names the categories a person would recognise', () => {
    // The wire values are bare mechanism tokens. `blockchain` and `dns` are accurate about how the
    // gateway groups things and useless as navigation for someone deciding where to look.
    expect(categoryLabel('blockchain')).toBe('Crypto & Blockchain')
    expect(categoryLabel('dns')).toBe('Domains & Web Intel')
    expect(categoryLabel('utility')).toBe('Screenshots & Render')
  })

  it('shows an unknown category rather than hiding it', () => {
    // Not hypothetical: the live facet went from 18 categories to 26 during this change. A lookup
    // returning '' for a miss would have hidden six of them from the nav, leaving their endpoints
    // reachable only by search. Falling through to a title-cased wire value is worse-looking and
    // correct — and it is what let `ai tools` and `financial` appear the day they were added.
    expect(categoryLabel('quantum_stuff')).toBe('Quantum Stuff')
    expect(categoryLabel('ai tools')).toBe('Ai Tools')
    expect(categoryLabel('newthing')).toBe('Newthing')
  })

  it('never maps two wire values to one label', () => {
    // `crypto`/`blockchain` and `web scraping`/`web` are near-duplicate categories upstream, and
    // merging their labels is the obvious tidy-up. It must not happen: `category=` takes ONE value
    // (measured — a second is ignored, a comma-joined pair matches nothing), so a merged pill would
    // sum both counts and filter by one, promising 37 endpoints and delivering 35.
    //
    // Checked as a property of the whole table rather than on the two known pairs, because the
    // next overlapping pair will be added upstream without warning.
    const labels = Object.values(CATEGORY_LABELS)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('listApis', () => {
  /**
   * Returns the requested URLs rather than the spy itself.
   *
   * `vi.fn(async () => …)` infers a zero-argument signature, so `mock.calls[0][0]` is a type error
   * — and the tempting fix (casting the spy to `any`) would silently accept a call with no
   * arguments at all, which is exactly what these tests exist to rule out.
   */
  function stubApiPage(body: unknown) {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url))
        return new Response(JSON.stringify({ data: body }), { status: 200 })
      }),
    )
    return urls
  }

  const ROW = {
    resource_id: 3570,
    name: 'Audio To Text',
    description: 'Transcribes audio content into text format.',
    category: 'audio',
    display_price: 0.0115,
    method: 'POST',
  }

  it('reads the paginated envelope, its total and its category facet', async () => {
    stubApiPage({
      items: [ROW],
      total: 2720,
      categories: [
        { category: 'general', count: 1312 },
        { category: 'video', count: 22 },
      ],
    })
    const page = await listApis()
    expect(page.items[0]).toEqual({
      resourceId: 3570,
      name: 'Audio To Text',
      description: 'Transcribes audio content into text format.',
      category: 'audio',
      priceUsd: 0.0115,
      method: 'POST',
    })
    // The total is for the WHOLE filtered catalogue, not the page. A category heading that showed
    // the page length would claim 24 endpoints for a category holding 1,312.
    expect(page.total).toBe(2720)
    expect(page.categories.map((c) => c.label)).toEqual(['General', 'Video'])
  })

  it('filters server-side, which is the only way a count can be true', async () => {
    const urls = stubApiPage({ items: [], total: 22, categories: [] })
    await listApis({ category: 'video', query: 'text', page: 2, pageSize: 24 })
    expect(urls).toHaveLength(1)
    const url = urls[0]
    expect(url).toContain('category=video')
    expect(url).toContain('q=text')
    expect(url).toContain('page=2')
    expect(url).toContain('page_size=24')
  })

  it('omits an empty filter instead of sending it blank', async () => {
    // `category=` with no value is not the same request as no `category` at all, and this code
    // should not depend on the gateway treating them alike.
    const urls = stubApiPage({ items: [], total: 0, categories: [] })
    await listApis({ category: '', query: '' })
    expect(urls).toHaveLength(1)
    const url = urls[0]
    expect(url).not.toContain('category=')
    expect(url).not.toContain('q=')
  })

  it('survives a row missing everything but its id', async () => {
    // Defensive because the alternative is a card reading "undefined — $NaN per call". The id is
    // the one field without a sensible default: it is how the endpoint is addressed, so a row
    // lacking it is dropped rather than rendered as unusable.
    stubApiPage({ items: [{ resource_id: 9 }, { name: 'no id here' }], total: 2 })
    const page = await listApis()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      resourceId: 9,
      name: 'endpoint 9',
      priceUsd: 0,
      method: 'POST',
    })
  })

  it('reads an absent facet as empty rather than throwing', async () => {
    stubApiPage({ items: [ROW] })
    const page = await listApis()
    expect(page.categories).toEqual([])
    expect(page.total).toBe(0)
  })
})
