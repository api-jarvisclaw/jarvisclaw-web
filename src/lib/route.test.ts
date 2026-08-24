import { describe, expect, it, vi, afterEach } from 'vitest'

import { GatewayError, isModelUnavailable, listFreeModels, FREE_MODEL } from './gateway'
import { ModelRouter, freeCandidates } from './route'

afterEach(() => {
  vi.unstubAllGlobals()
})

const OPTS = { baseUrl: 'https://gw.test' }

function stubFreeModels(models: Array<{ model: string; free: boolean }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ free: models }), { status: 200 })),
  )
}

describe('isModelUnavailable', () => {
  it('recognises the live "Unknown model" failure', () => {
    // The exact shape observed on prod (2026-08-24): auto/free resolved to
    // zai/glm-4-flash and the upstream answered "Unknown model: zai/glm-4-flash",
    // while that same model requested by name worked. Matching is on the message
    // because the gateway wraps this as a generic bad_response_status_code rather than
    // giving it a distinct code.
    const err = new GatewayError(
      'Unknown model: zai/glm-4-flash. Try one of: openai/gpt-5.6-sol',
      500,
    )
    expect(isModelUnavailable(err)).toBe(true)
  })

  it('recognises exhausted free capacity', () => {
    expect(
      isModelUnavailable(new GatewayError('Free model capacity exhausted — retry shortly', 429)),
    ).toBe(true)
  })

  it('does not treat a rate limit as the model being gone', () => {
    // Retiring a model on a 429 would burn the whole candidate list over one bad
    // minute, leaving the session with nothing to fall back to when it recovers.
    expect(isModelUnavailable(new GatewayError('too many requests', 429))).toBe(false)
  })

  it('does not treat an auth failure as the model being gone', () => {
    expect(isModelUnavailable(new GatewayError('token.invalid', 401))).toBe(false)
  })

  it('does not treat a plain network error as the model being gone', () => {
    expect(isModelUnavailable(new TypeError('Failed to fetch'))).toBe(false)
  })
})

describe('listFreeModels', () => {
  it('returns only the models the gateway calls free', () => {
    stubFreeModels([
      { model: 'nvidia/step-3.7-flash', free: true },
      { model: 'zai/glm-4-air', free: false },
    ])
    return expect(listFreeModels(OPTS)).resolves.toEqual(['nvidia/step-3.7-flash'])
  })

  it('drops the virtual auto/* names', async () => {
    // auto/free is priced at zero and so appears in this list. Falling back from
    // auto/free to auto/free retries the exact failure that triggered the fallback.
    stubFreeModels([
      { model: 'auto/free', free: true },
      { model: 'nvidia/step-3.7-flash', free: true },
    ])
    expect(await listFreeModels(OPTS)).toEqual(['nvidia/step-3.7-flash'])
  })
})

describe('freeCandidates', () => {
  it('tries auto/free first, then named models', async () => {
    // auto/free picks per prompt when it works, which beats any fixed order this file
    // could impose. The named models exist for when its resolution lands on something
    // its channel cannot serve.
    stubFreeModels([{ model: 'nvidia/step-3.7-flash', free: true }])
    expect(await freeCandidates(OPTS)).toEqual([FREE_MODEL, 'nvidia/step-3.7-flash'])
  })

  it('still offers auto/free when discovery is unreachable', async () => {
    // Failing here would turn a degraded first run into no first run at all.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    expect(await freeCandidates(OPTS)).toEqual([FREE_MODEL])
  })

  it('does not list a model twice', async () => {
    stubFreeModels([
      { model: 'nvidia/a', free: true },
      { model: 'nvidia/a', free: true },
    ])
    expect(await freeCandidates(OPTS)).toEqual([FREE_MODEL, 'nvidia/a'])
  })
})

describe('ModelRouter', () => {
  it('starts on auto/free', async () => {
    stubFreeModels([{ model: 'nvidia/a', free: true }])
    const r = new ModelRouter(OPTS)
    expect(await r.current()).toBe(FREE_MODEL)
  })

  it('moves to the next candidate after an unavailability', async () => {
    stubFreeModels([{ model: 'nvidia/a', free: true }])
    const r = new ModelRouter(OPTS)
    const first = await r.current()

    expect(await r.markFailed(first!, new GatewayError('Unknown model: x', 500))).toBe('try-next')
    expect(await r.current()).toBe('nvidia/a')
  })

  it('reports when nothing is left to try', async () => {
    stubFreeModels([{ model: 'nvidia/a', free: true }])
    const r = new ModelRouter(OPTS)

    expect(await r.markFailed(FREE_MODEL, new GatewayError('Unknown model: x', 500))).toBe('try-next')
    // The last candidate failing is its own outcome: reporting it as a plain failure
    // would make the caller print the raw upstream error instead of saying the free
    // tier is out of capacity.
    expect(await r.markFailed('nvidia/a', new GatewayError('Unknown model: y', 500))).toBe(
      'exhausted',
    )
    expect(await r.current()).toBeUndefined()
  })

  it('does not retire a model over a rate limit', async () => {
    stubFreeModels([{ model: 'nvidia/a', free: true }])
    const r = new ModelRouter(OPTS)

    expect(await r.markFailed(FREE_MODEL, new GatewayError('too many requests', 429))).toBe(
      'not-a-model-problem',
    )
    expect(await r.current()).toBe(FREE_MODEL)
    expect(r.retired).toEqual([])
  })

  it('remembers a failure across calls', async () => {
    // The whole reason this is stateful: without it, every message re-tries the broken
    // model first and pays the same latency to learn the same thing.
    stubFreeModels([{ model: 'nvidia/a', free: true }])
    const r = new ModelRouter(OPTS)

    await r.markFailed(FREE_MODEL, new GatewayError('Unknown model: x', 500))
    expect(await r.current()).toBe('nvidia/a')
    expect(await r.current()).toBe('nvidia/a')
    expect(r.retired).toEqual([FREE_MODEL])
  })

  it('loads the candidate list only once', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ free: [{ model: 'nvidia/a', free: true }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const r = new ModelRouter(OPTS)

    await r.current()
    await r.current()
    await r.current()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
