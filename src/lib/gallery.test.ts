import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addToGallery,
  archive,
  galleryTotalUsd,
  loadGallery,
  removeFromGallery,
  saveGallery,
  type GalleryItem,
} from './gallery'

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  })
  return store
}

function item(over: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: 'i1',
    kind: 'image',
    url: 'https://cdn.jarvisclaw.ai/gallery/2026-08-24/a.png',
    prompt: 'a red cube',
    model: 'openai/gpt-image-2',
    usd: 0.064,
    createdAt: 1000,
    ...over,
  }
}

beforeEach(() => {
  stubStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('archive', () => {
  it('returns the permanent CDN url', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ url: 'https://cdn.jarvisclaw.ai/gallery/2026-08-24/x.png' }), {
        status: 201,
      }),
    )
    vi.stubGlobal('fetch', spy)
    await expect(archive('https://upstream.example/tmp/x.png')).resolves.toBe(
      'https://cdn.jarvisclaw.ai/gallery/2026-08-24/x.png',
    )
  })

  it('sends the source as JSON to /gallery', async () => {
    const spy = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      new Response(JSON.stringify({ url: 'https://cdn/x.png' }), { status: 201 }),
    )
    vi.stubGlobal('fetch', spy)
    await archive('https://upstream.example/x.png', { cdnBase: 'https://cdn.test' })
    expect(String(spy.mock.calls[0]?.[0])).toBe('https://cdn.test/gallery')
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({
      source: 'https://upstream.example/x.png',
    })
  })

  it('refuses a data: url without calling the network', async () => {
    // The Worker copies from an allowlisted HOST, so it cannot reach a data: url at all —
    // inlined bytes (what speech returns) have no archive path. Attempting it would be a
    // guaranteed-failed request on every clip.
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(archive('data:image/png;base64,QUJD')).resolves.toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns null rather than throwing when the CDN rejects it', async () => {
    // Failing to archive must not lose media the user already paid for: the caller falls back
    // to the original URL, so a throw here would turn a cosmetic failure into a lost artifact.
    //
    // Note on what this does and does not pin: because the whole body sits in a try/catch,
    // replacing this `return null` with a `throw` is a no-op — the catch converts it back. So
    // this test alone cannot prove the no-throw contract. `resolvesNullOnEveryFailure` below
    // pins the contract itself, across every failure shape, which is what the caller relies on.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 415 })))
    await expect(archive('https://upstream.example/x.svg')).resolves.toBeNull()
  })

  it('never rejects, whatever the CDN does', async () => {
    // The contract the caller depends on. App.tsx awaits archive() between taking payment and
    // rendering the result: a rejection there would skip the render inside the same try block,
    // so the user would be charged and shown an error instead of the media they paid for.
    const failures: Array<() => Promise<Response>> = [
      async () => new Response('', { status: 500 }),
      async () => new Response('not json', { status: 201 }),
      async () => {
        throw new TypeError('Failed to fetch')
      },
      async () => new Response(JSON.stringify({ url: 42 }), { status: 201 }),
      async () => new Response(JSON.stringify({ url: '' }), { status: 201 }),
    ]
    for (const f of failures) {
      vi.stubGlobal('fetch', vi.fn(f))
      // Not `.rejects` — the assertion is that it resolves at all, and to null specifically.
      await expect(archive('https://upstream.example/x.png')).resolves.toBeNull()
    }
  })

  it('returns null when the network fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('CORS')
    }))
    await expect(archive('https://upstream.example/x.png')).resolves.toBeNull()
  })

  it('returns null when the response carries no url', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 })))
    await expect(archive('https://upstream.example/x.png')).resolves.toBeNull()
  })
})

describe('the index', () => {
  it('round-trips through storage, newest first', () => {
    saveGallery([item({ id: 'a', createdAt: 1 }), item({ id: 'b', url: 'u2', createdAt: 9 })])
    expect(loadGallery().map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('de-duplicates by url', () => {
    // Re-archiving the same object (a retry, a re-render) must not add a second row, while two
    // genuinely different generations of the same prompt must both be kept.
    const one = addToGallery([], item({ id: 'a' }))
    const again = addToGallery(one, item({ id: 'b' }))
    expect(again).toHaveLength(1)
    const other = addToGallery(again, item({ id: 'c', url: 'https://cdn/other.png' }))
    expect(other).toHaveLength(2)
  })

  it('drops malformed rows instead of blanking the gallery', () => {
    stubStorage({
      'jarvisclaw.gallery.v1': JSON.stringify([{ nonsense: true }, item({ id: 'good' })]),
    })
    expect(loadGallery().map((i) => i.id)).toEqual(['good'])
  })

  it('survives corrupt storage', () => {
    stubStorage({ 'jarvisclaw.gallery.v1': 'not json' })
    expect(loadGallery()).toEqual([])
  })

  it('does not throw when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(() => loadGallery()).not.toThrow()
    expect(() => saveGallery([item()])).not.toThrow()
  })

  it('removes by id', () => {
    const list = [item({ id: 'a' }), item({ id: 'b', url: 'u2' })]
    expect(removeFromGallery(list, 'a').map((i) => i.id)).toEqual(['b'])
  })

  it('caps what it writes', () => {
    const many = Array.from({ length: 260 }, (_, i) =>
      item({ id: `i${i}`, url: `https://cdn/${i}.png`, createdAt: i }),
    )
    saveGallery(many)
    expect(loadGallery()).toHaveLength(200)
  })
})

describe('galleryTotalUsd', () => {
  it('sums what was spent', () => {
    expect(galleryTotalUsd([item({ usd: 0.064 }), item({ url: 'u2', usd: 1.13648 })])).toBeCloseTo(
      1.20048,
      5,
    )
  })

  it('ignores an unreadable price instead of returning NaN', () => {
    // One bad row would otherwise make the whole total render as "$NaN".
    expect(galleryTotalUsd([item({ usd: Number.NaN }), item({ url: 'u2', usd: 0.5 })])).toBeCloseTo(
      0.5,
      6,
    )
  })

  it('is zero for an empty gallery', () => {
    expect(galleryTotalUsd([])).toBe(0)
  })
})
