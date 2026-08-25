import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canUseAccount,
  KEYS_URL,
  listKeys,
  quotaToUsd,
  revealKey,
  SIGN_IN_URL,
  whoami,
} from './account'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * A whitelisted origin.
 *
 * Required by `whoami`, which refuses to make a credentialed request from an origin the gateway
 * would reject — otherwise the browser logs a CORS failure on every page load that no `catch`
 * can suppress. Without this stub the tests exercise that refusal instead of the code under
 * test, and `returns null when nobody is signed in` passes for entirely the wrong reason.
 */
function stubOrigin(origin = 'https://chat.jarvisclaw.ai') {
  vi.stubGlobal('window', { location: { origin } })
}

beforeEach(() => {
  stubOrigin()
})

/** Typed with the fetch signature so the tests can read the request that was sent. */
function stub(status: number, body: unknown) {
  const spy = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
    new Response(JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

/**
 * Routes each path to its own response.
 *
 * `whoami` makes TWO calls now — `/api/user/session` to learn the id, then `/api/user/self` with
 * it — and the single-response `stub` above answers both with the same body. Every existing test
 * still passed after that change, because `{id: 7}` happens to satisfy both shapes. Passing for
 * the wrong reason is the failure mode this helper exists to avoid: with it, a test can assert
 * that the id from the FIRST call is what the second one sends.
 */
function stubPaths(routes: Record<string, { status: number; body: unknown }>) {
  const spy = vi.fn(async (u: string | URL | Request, _i?: RequestInit) => {
    const url = String(u)
    const hit = Object.keys(routes).find((path) => url.includes(path))
    if (!hit) return new Response(JSON.stringify({ success: false, message: 'no stub' }), { status: 404 })
    return new Response(JSON.stringify(routes[hit].body), { status: routes[hit].status })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('whoami', () => {
  it('reads the platform’s own field names', () => {
    // The response uses snake_case and `display_name`; guessing camelCase here would render
    // "user 7" for an account that has a name.
    stub(200, {
      success: true,
      data: { id: 7, username: 'ada', display_name: 'Ada L', quota: 750_000, used_quota: 250_000 },
    })
    return expect(whoami()).resolves.toEqual({
      id: 7,
      username: 'ada',
      displayName: 'Ada L',
      quota: 750_000,
      usedQuota: 250_000,
    })
  })

  it('falls back to the username when there is no display name', () => {
    stub(200, { success: true, data: { id: 7, username: 'ada', display_name: '' } })
    return expect(whoami()).resolves.toMatchObject({ displayName: 'ada' })
  })

  it('returns null when nobody is signed in', async () => {
    // The ordinary state on a first visit. Throwing would put an error banner in front of every
    // new visitor.
    stub(401, { success: false, message: 'Unauthorized, not logged in' })
    await expect(whoami()).resolves.toBeNull()
  })

  it('returns null on a 200 that carries success:false', async () => {
    // The platform answers 200 with success:false for auth failures as often as it uses a 4xx.
    // Reading only res.ok would treat "not logged in" as a signed-in account with no fields.
    stub(200, { success: false, message: 'no session' })
    await expect(whoami()).resolves.toBeNull()
  })

  it('sends the session cookie', async () => {
    // Without credentials:'include' the cookie is not sent at all, and every call reports "not
    // logged in" even in a browser that is signed in.
    const spy = stub(200, { success: true, data: { id: 1, username: 'a' } })
    await whoami()
    expect(spy.mock.calls[0]?.[1]?.credentials).toBe('include')
  })

  it('never sends an Authorization header of its own', async () => {
    // This flow is cookie-based. Sending a bearer token here would make the platform validate an
    // access token instead of the session, which is a different credential entirely.
    const spy = stub(200, { success: true, data: { id: 1, username: 'a' } })
    await whoami()
    const headers = (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it('learns the user id from the session route before asking for the account', async () => {
    // The bug this pins, measured against production from https://chat.jarvisclaw.ai:
    //
    //   /api/user/self WITHOUT New-Api-User -> 401 "New-Api-User header not provided"
    //   /api/user/self WITH    New-Api-User -> 200
    //
    // UserAuth requires that header to carry the caller's own id, so the FIRST call could never
    // succeed — it is asking who the session belongs to and cannot send an id it does not have.
    // A signed-in user pressed "I've signed in" and was told, permanently, that they were not.
    const spy = stubPaths({
      '/api/user/session': { status: 200, body: { success: true, data: { id: 42, username: 'ada' } } },
      '/api/user/self': {
        status: 200,
        body: { success: true, data: { id: 42, username: 'ada', display_name: 'Ada L', quota: 500_000 } },
      },
    })

    await expect(whoami()).resolves.toMatchObject({ id: 42, displayName: 'Ada L' })

    // The session call must NOT send the header — that is the whole point.
    const first = spy.mock.calls[0]
    expect(String(first[0])).toContain('/api/user/session')
    expect((first[1]?.headers as Record<string, string>)['New-Api-User']).toBeUndefined()

    // And the account call must send the id the session call returned.
    const second = spy.mock.calls[1]
    expect(String(second[0])).toContain('/api/user/self')
    expect((second[1]?.headers as Record<string, string>)['New-Api-User']).toBe('42')
  })

  it('sends the session cookie on the identity call', async () => {
    // Without credentials:'include' the cookie is not sent at all and the route answers
    // "no session" in a browser that is signed in.
    const spy = stubPaths({
      '/api/user/session': { status: 200, body: { success: true, data: { id: 1 } } },
      '/api/user/self': { status: 200, body: { success: true, data: { id: 1, username: 'x' } } },
    })
    await whoami()
    expect(spy.mock.calls[0][1]?.credentials).toBe('include')
  })

  it('returns null without calling /self when there is no session', async () => {
    // A 401 from the identity route is the ordinary signed-out state. Going on to call /self
    // would produce a second guaranteed-401 on every page load.
    const spy = stubPaths({
      '/api/user/session': { status: 401, body: { success: false, message: 'no session' } },
    })
    await expect(whoami()).resolves.toBeNull()
    expect(spy.mock.calls.every((c) => !String(c[0]).includes('/api/user/self'))).toBe(true)
  })

  it('refuses an id of zero from the identity route', async () => {
    // user 0 is not a user. Trusting it would show a signed-in panel for an account that cannot
    // exist, and then fail on every keyed call afterwards.
    stubPaths({
      '/api/user/session': { status: 200, body: { success: true, data: { id: 0 } } },
    })
    await expect(whoami()).resolves.toBeNull()
  })

})

describe('listKeys', () => {
  it('reads the paginated envelope, not a bare array', async () => {
    // GetAllTokens answers {data:{items:[…]}}. Treating data as an array finds nothing and
    // reports an empty key list for an account that has keys.
    stub(200, {
      success: true,
      data: {
        items: [
          { id: 1, name: 'prod', status: 1, remain_quota: 500_000, unlimited_quota: false },
        ],
      },
    })
    await expect(listKeys({ userId: 7 })).resolves.toEqual([
      { id: 1, name: 'prod', unlimited: false, remainQuota: 500_000, expired: false, exhausted: false },
    ])
  })

  it('sends New-Api-User, which the platform requires', async () => {
    // authHelper answers 401 when the header is missing, and again when it does not match the
    // session's own user id. So it can neither be omitted nor guessed.
    const spy = stub(200, { success: true, data: { items: [] } })
    await listKeys({ userId: 42 })
    const headers = (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers['New-Api-User']).toBe('42')
  })

  it('uses the platform’s own pagination parameter names', async () => {
    const spy = stub(200, { success: true, data: { items: [] } })
    await listKeys({ userId: 1 })
    const url = String(spy.mock.calls[0]?.[0])
    expect(url).toContain('p=1')
    expect(url).toContain('page_size=100')
  })

  it('marks an expired key rather than hiding it', async () => {
    // Status 3 is expired. Hiding it leaves someone hunting for a key they know exists; marking
    // it tells them why it will not work.
    stub(200, { success: true, data: { items: [{ id: 2, name: 'old', status: 3 }] } })
    const keys = await listKeys({ userId: 1 })
    expect(keys[0]).toMatchObject({ name: 'old', expired: true })
  })

  it('marks an exhausted key', async () => {
    stub(200, { success: true, data: { items: [{ id: 3, name: 'spent', status: 4 }] } })
    await expect(listKeys({ userId: 1 })).resolves.toMatchObject([{ exhausted: true }])
  })

  it('reports unlimited as null quota, not as zero', async () => {
    // Zero would render "$0.0000" for a key with no limit at all — the most misleading possible
    // reading of it.
    stub(200, { success: true, data: { items: [{ id: 4, name: 'inf', status: 1, unlimited_quota: true }] } })
    const keys = await listKeys({ userId: 1 })
    expect(keys[0].unlimited).toBe(true)
    expect(keys[0].remainQuota).toBeNull()
  })

  it('sorts usable keys before unusable ones', async () => {
    stub(200, {
      success: true,
      data: {
        items: [
          { id: 1, name: 'aaa-expired', status: 3 },
          { id: 2, name: 'zzz-good', status: 1 },
        ],
      },
    })
    const keys = await listKeys({ userId: 1 })
    expect(keys.map((k) => k.name)).toEqual(['zzz-good', 'aaa-expired'])
  })

  it('survives a response with no items', async () => {
    stub(200, { success: true, data: {} })
    await expect(listKeys({ userId: 1 })).resolves.toEqual([])
  })
})

describe('revealKey', () => {
  it('POSTs, because the platform rate-limits this route', async () => {
    const spy = stub(200, { success: true, data: { key: 'abc123' } })
    await revealKey({ userId: 1, keyId: 9 })
    expect(spy.mock.calls[0]?.[1]?.method).toBe('POST')
    expect(String(spy.mock.calls[0]?.[0])).toContain('/api/token/9/key')
  })

  it('adds the sk- prefix the relay expects', async () => {
    // The platform stores the key without it; the Authorization header needs it.
    stub(200, { success: true, data: { key: 'abc123' } })
    await expect(revealKey({ userId: 1, keyId: 9 })).resolves.toBe('sk-abc123')
  })

  it('does not double up a prefix that is already there', async () => {
    stub(200, { success: true, data: { key: 'sk-abc123' } })
    await expect(revealKey({ userId: 1, keyId: 9 })).resolves.toBe('sk-abc123')
  })

  it('throws rather than returning an empty credential', async () => {
    // An empty string would be sent as `Authorization: Bearer ` and 401 on every call, which is
    // far harder to diagnose than a failure at the point of reveal.
    stub(200, { success: true, data: { key: '' } })
    await expect(revealKey({ userId: 1, keyId: 9 })).rejects.toThrow(/no key/)
  })

  it('surfaces the platform’s own message on failure', async () => {
    stub(200, { success: false, message: 'rate limited, try again' })
    await expect(revealKey({ userId: 1, keyId: 9 })).rejects.toThrow(/rate limited/)
  })
})

describe('quotaToUsd', () => {
  it('converts at the platform’s ratio', () => {
    // 500000 quota = $1. Getting this wrong shows a balance off by orders of magnitude.
    expect(quotaToUsd(500_000)).toBe(1)
    expect(quotaToUsd(750_000)).toBe(1.5)
    expect(quotaToUsd(0)).toBe(0)
  })

  it('returns zero rather than NaN for junk', () => {
    // "$NaN" in a balance field is worse than "$0.0000".
    expect(quotaToUsd(Number.NaN)).toBe(0)
    expect(quotaToUsd(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('the origin guard', () => {
  /**
   * This exists because a probe caught a real defect: the session check fired from any origin, and
   * from a non-whitelisted one the browser logged
   *
   *   "Access to fetch … blocked by CORS policy … No 'Access-Control-Allow-Origin'"
   *
   * on EVERY page load. A blocked preflight is reported by the browser itself, so no try/catch
   * can silence it — the only way not to log it is not to send the request. A console full of
   * CORS failures on a working page is how a real error gets ignored.
   */
  it('makes no request at all from an origin the gateway would reject', async () => {
    const spy = stub(200, { success: true, data: { id: 1 } })
    stubOrigin('http://127.0.0.1:4175')
    await expect(whoami()).resolves.toBeNull()
    // The assertion that matters: not that it returned null, but that nothing was SENT. A version
    // that fetched and swallowed the error would satisfy a null check and still log.
    expect(spy).not.toHaveBeenCalled()
  })

  it('does make the request from the deployed origin', async () => {
    const spy = stub(200, { success: true, data: { id: 1, username: 'a' } })
    stubOrigin('https://chat.jarvisclaw.ai')
    await expect(whoami()).resolves.not.toBeNull()
    expect(spy).toHaveBeenCalled()
  })

  it('does NOT allow the localhost dev origins', () => {
    // Counter-intuitive, and measured: these are in this app's CSP but NOT in the gateway's
    // CORS_ALLOWED_ORIGINS — two different lists in two different places. Listing them here on
    // the strength of the CSP alone is exactly the mistake that left the probe still logging a
    // CORS error. Pinned so nobody "helpfully" adds them back without changing the gateway.
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      stubOrigin(origin)
      expect(canUseAccount()).toBe(false)
    }
  })

  it('reports unavailability so the panel can say so', () => {
    // The panel reads this to explain the state instead of offering a re-check button that can
    // only ever report nothing. A control that silently does nothing is worse than its absence.
    stubOrigin('https://somewhere.else')
    expect(canUseAccount()).toBe(false)
  })

  it('does not match an origin by prefix', () => {
    // `https://chat.jarvisclaw.ai.evil.com` must not pass. A `startsWith` check would admit it,
    // and this is a list that gates sending credentials.
    stubOrigin('https://chat.jarvisclaw.ai.evil.com')
    expect(canUseAccount()).toBe(false)
  })
})

describe('the links point at real pages', () => {
  it('sends people to the platform, not to a form on this page', () => {
    // Load-bearing, and the reason there is no password field in this app: a page that asks for
    // platform credentials teaches users that any page may ask for them.
    expect(SIGN_IN_URL.startsWith('https://api.jarvisclaw.ai/')).toBe(true)
    expect(KEYS_URL.startsWith('https://api.jarvisclaw.ai/')).toBe(true)
  })

  it('uses /en/sign-in, the route that exists', () => {
    // I shipped /en/login and "verified" it by checking for a 200. That proves nothing about an
    // SPA — the host serves index.html for every path, so a nonsense URL answers 200 too. In a
    // browser, /en/login renders "Not Found", identical to /en/nonsense-xyz, while /en/sign-in
    // renders a real form.
    //
    // Pinned as a substring rather than a full literal because the previous full-literal
    // assertion was itself the wrong URL: it asserted exactly what the code said, so it could
    // only ever confirm the typo. What matters is the path segment.
    expect(SIGN_IN_URL).toContain('/en/sign-in')
    expect(SIGN_IN_URL).not.toContain('/en/login')
  })

  it('carries the redirect the console itself uses', () => {
    // Visiting /en/keys unauthenticated bounces to /en/sign-in?redirect=%2Fen%2Fkeys, so passing
    // the same parameter lands the user on their keys instead of a dashboard to hunt through.
    expect(SIGN_IN_URL).toContain('redirect=%2Fen%2Fkeys')
  })

  it('names no route this repo cannot verify exists', () => {
    // The only durable check available offline: every path referenced here must correspond to a
    // route file in the console. A status-code check cannot do this, and that gap is what let
    // /en/login ship.
    for (const url of [SIGN_IN_URL, KEYS_URL]) {
      const path = new URL(url).pathname
      expect(KNOWN_CONSOLE_ROUTES).toContain(path)
    }
  })
})

/**
 * Console routes confirmed to render real pages, both by file and in a browser.
 *
 *   src/routes/{-$lang}/(auth)/sign-in.tsx        -> /en/sign-in
 *   src/routes/{-$lang}/_authenticated/keys/      -> /en/keys
 *
 * Anything not on this list has not been checked. Adding a path here without confirming the route
 * exists reproduces exactly the bug this list exists to prevent.
 */
const KNOWN_CONSOLE_ROUTES = ['/en/sign-in', '/en/keys']
