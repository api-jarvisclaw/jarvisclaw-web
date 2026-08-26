import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  deriveTitle,
  loadConversations,
  newId,
  relativeAge,
  remove,
  saveConversations,
  search,
  upsert,
  type Conversation,
} from './conversations'
import type { Turn } from '../ui/Transcript'

/** Minimal in-memory localStorage, since the test env is node. */
function installStore(): Map<string, string> {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  })
  return map
}

function conv(id: string, title: string, updatedAt: number, turns: Turn[] = []): Conversation {
  return { id, title, updatedAt, turns, history: [] }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('deriveTitle', () => {
  it('names a conversation after the first human message', () => {
    const turns: Turn[] = [
      { kind: 'user', text: 'What does a video cost?' },
      { kind: 'agent', text: 'About $0.40.', reasoning: '', steps: [] },
    ]
    expect(deriveTitle(turns)).toBe('What does a video cost?')
  })

  it('skips non-user turns rather than titling a chat with an error', () => {
    // A run that failed before the user's turn was recorded would otherwise be titled
    // "Refused: ..." in the list, which reads as the user's own words.
    const turns: Turn[] = [
      { kind: 'error', text: 'Refused: session budget exhausted.' },
      { kind: 'user', text: 'try again' },
    ]
    expect(deriveTitle(turns)).toBe('try again')
  })

  it('collapses newlines so a multi-line prompt stays one row', () => {
    expect(deriveTitle([{ kind: 'user', text: 'line one\n\nline two' }])).toBe('line one line two')
  })

  it('truncates with an ellipsis instead of overflowing the rail', () => {
    const title = deriveTitle([{ kind: 'user', text: 'x'.repeat(200) }])
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)
  })

  it('falls back for an empty transcript', () => {
    expect(deriveTitle([])).toBe('New chat')
    expect(deriveTitle([{ kind: 'user', text: '   ' }])).toBe('New chat')
  })
})

describe('persistence', () => {
  it('round-trips a conversation', () => {
    installStore()
    const list = [conv('a', 'first', 1000)]
    saveConversations(list)
    expect(loadConversations()).toEqual(list)
  })

  it('returns empty rather than throwing when the store is unavailable', () => {
    // Private mode with site data blocked throws on access. A console that cannot save
    // history must still be a console.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(loadConversations()).toEqual([])
    expect(() => saveConversations([conv('a', 'x', 1)])).not.toThrow()
  })

  it('survives corrupt stored data', () => {
    const store = installStore()
    store.set('jarvisclaw.conversations.v1', '{not json')
    expect(loadConversations()).toEqual([])
  })

  it('drops malformed rows without losing the good ones', () => {
    // This is data a previous version of the app wrote. One bad row must not blank the
    // whole list, which is what a naive parse-or-throw would do.
    const store = installStore()
    store.set(
      'jarvisclaw.conversations.v1',
      JSON.stringify([{ id: 'ok', title: 't', updatedAt: 5, turns: [], history: [] }, { id: 'bad' }, null, 7]),
    )
    expect(loadConversations().map((c) => c.id)).toEqual(['ok'])
  })

  it('orders newest first on load', () => {
    const store = installStore()
    store.set(
      'jarvisclaw.conversations.v1',
      JSON.stringify([conv('old', 'o', 100), conv('new', 'n', 900)]),
    )
    expect(loadConversations().map((c) => c.id)).toEqual(['new', 'old'])
  })

  it('caps the stored list so a full quota cannot lose everything', () => {
    const store = installStore()
    saveConversations(Array.from({ length: 80 }, (_, i) => conv(`c${i}`, `t${i}`, i)))
    const stored = JSON.parse(store.get('jarvisclaw.conversations.v1') ?? '[]') as Conversation[]
    expect(stored).toHaveLength(50)
    // The newest are the ones kept.
    expect(stored[0].id).toBe('c79')
  })
})

describe('upsert / remove', () => {
  it('replaces an existing conversation rather than duplicating it', () => {
    const list = [conv('a', 'old title', 1), conv('b', 'other', 2)]
    const next = upsert(list, conv('a', 'new title', 3))
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ id: 'a', title: 'new title' })
  })

  it('moves the updated conversation to the top', () => {
    const list = [conv('a', 'a', 1), conv('b', 'b', 2)]
    expect(upsert(list, conv('b', 'b', 9))[0].id).toBe('b')
  })

  it('removes by id', () => {
    expect(remove([conv('a', 'a', 1), conv('b', 'b', 2)], 'a').map((c) => c.id)).toEqual(['b'])
  })
})

describe('search', () => {
  const list = [
    conv('a', 'Ethereum gas prices', 2, [{ kind: 'user', text: 'Ethereum gas prices' }]),
    conv('b', 'Video costs', 1, [
      { kind: 'agent', text: 'Seedance runs about forty cents.', reasoning: '', steps: [] },
    ]),
  ]

  it('matches titles case-insensitively', () => {
    expect(search(list, 'ETHEREUM').map((c) => c.id)).toEqual(['a'])
  })

  it('matches text inside the transcript, not just the title', () => {
    // Searching only titles would miss the answer the user actually remembers.
    expect(search(list, 'forty cents').map((c) => c.id)).toEqual(['b'])
  })

  it('returns everything for an empty query', () => {
    expect(search(list, '   ')).toHaveLength(2)
  })

  it('does not crash on turns without text', () => {
    const withMedia = [
      conv('m', 'a picture', 1, [
        { kind: 'media', id: 'm1', media: 'image', prompt: 'a red cube', model: 'x', spentUsd: 0.06 },
      ]),
    ]
    expect(() => search(withMedia, 'cube')).not.toThrow()
  })
})

describe('newId', () => {
  it('produces distinct ids even without crypto.randomUUID', () => {
    // Older mobile browsers lack randomUUID, and an id collision would overwrite
    // someone's conversation.
    vi.stubGlobal('crypto', {})
    const ids = new Set(Array.from({ length: 500 }, () => newId()))
    expect(ids.size).toBe(500)
  })
})

describe('relativeAge', () => {
  it('reads as a short age', () => {
    const now = 1_000_000_000_000
    expect(relativeAge(now - 5_000, now)).toBe('just now')
    expect(relativeAge(now - 5 * 60_000, now)).toBe('5m')
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeAge(now - 5 * 86_400_000, now)).toBe('5d')
    expect(relativeAge(now - 60 * 86_400_000, now)).toBe('2mo')
  })

  it('never shows a negative age from a clock skew', () => {
    const now = 1_000
    expect(relativeAge(now + 60_000, now)).toBe('just now')
  })
})

describe('inline media bytes never reach localStorage', () => {
  /**
   * The bug this pins, measured in a browser before the fix:
   *
   *   this origin's localStorage holds ~4 MB
   *   one 30s speech clip is ~640 KB of base64
   *   7 such conversations were written, then QuotaExceededError
   *   13 of the next 20 were NEVER PERSISTED, silently
   *
   * `saveConversations` catches its own exception, so after the first failure every later write
   * failed too and a refresh returned the user to whatever was last written. That is the reported
   * "generated content disappears when I refresh" — not a missing save call, a save that could not
   * fit and said nothing.
   */
  function speechTurn(b64: string): Turn {
    return {
      kind: 'media',
      id: 't1',
      media: 'speech',
      b64,
      mediaKey: 'blob-key-1',
      prompt: 'say hello',
      model: 'elevenlabs/turbo-v2.5',
      spentUsd: 0.02,
    }
  }

  it('strips the base64 payload but keeps the key that finds it', () => {
    const store = installStore()
    const big = 'A'.repeat(500_000)
    saveConversations([
      { id: 'c1', title: 'x', updatedAt: 1, turns: [speechTurn(big)], history: [] },
    ])
    const raw = store.get('jarvisclaw.conversations.v1') ?? ''
    expect(raw).not.toContain(big)
    // The key must survive, or the clip is unrecoverable after a reload — which would trade one
    // data-loss bug for another.
    expect(raw).toContain('blob-key-1')
  })

  it('keeps a whole transcript small enough that the quota is unreachable', () => {
    const store = installStore()
    const big = 'A'.repeat(640 * 1024)
    const list: Conversation[] = []
    for (let i = 0; i < 50; i++) {
      list.push({
        id: `c${i}`,
        title: `speech ${i}`,
        updatedAt: i,
        turns: [{ ...speechTurn(big), id: `t${i}`, mediaKey: `k${i}` } as Turn],
        history: [],
      })
    }
    saveConversations(list)
    const bytes = (store.get('jarvisclaw.conversations.v1') ?? '').length
    // 50 speech conversations — the cap — used to be ~32 MB and is now a few KB. Asserted against
    // a real budget rather than a ratio: 4 MB is what this origin measured.
    expect(bytes).toBeLessThan(200_000)
  })

  it('leaves a turn with no inline bytes untouched', () => {
    installStore()
    const turn: Turn = {
      kind: 'media',
      id: 't2',
      media: 'video',
      url: 'https://cdn.jarvisclaw.ai/gallery/x.mp4',
      prompt: 'a clip',
      model: 'seedance',
      spentUsd: 0.83,
    }
    saveConversations([{ id: 'c1', title: 'x', updatedAt: 1, turns: [turn], history: [] }])
    const back = loadConversations()
    expect(back[0].turns[0]).toEqual(turn)
  })

  it('round-trips a stripped turn through load without losing the rest of it', () => {
    const store = installStore()
    saveConversations([
      { id: 'c1', title: 'x', updatedAt: 1, turns: [speechTurn('AAAA')], history: [] },
    ])
    const back = loadConversations()
    const t = back[0].turns[0]
    expect(t.kind).toBe('media')
    if (t.kind === 'media') {
      expect(t.b64).toBeUndefined()
      expect(t.mediaKey).toBe('blob-key-1')
      expect(t.spentUsd).toBe(0.02)
      // The price and prompt are the receipt. Losing those alongside the bytes would leave a row
      // that cost money and says nothing about what it was.
      expect(t.prompt).toBe('say hello')
    }
    expect(store.size).toBe(1)
  })
})
