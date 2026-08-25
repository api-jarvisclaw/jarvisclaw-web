/**
 * Signing in with a main-site account, and using its API keys here.
 *
 * This exists because the answer to "how do my main-site users use this?" was, until now,
 * "they can't" — the console only offered a wallet, so an existing customer with quota on the
 * platform had no way to spend it here.
 *
 * ## Why this works now when it could not before
 *
 * A previous version of this app had an API key box, and I removed it saying a key could never
 * work from a browser: `Authorization` was absent from the gateway's
 * `Access-Control-Allow-Headers`, so every keyed request was blocked before it was sent.
 *
 * That was true then and is not true now. api-server#528 added `Authorization`, `X-PAYMENT` and
 * `x-api-key` to the allowlist and put this origin on the whitelist. Measured against
 * production from `https://chat.jarvisclaw.ai`:
 *
 *   preflight with `authorization` -> 204, allow-origin: https://chat.jarvisclaw.ai
 *   POST with a bogus key          -> 401 "Invalid token", WITH the CORS header present
 *
 * A 401 carrying the CORS header is the proof: the gateway read the key and rejected it. The
 * browser was not in the way. So keys work here, and the old objection is obsolete.
 *
 * ## Why the session is not stored, and the key is
 *
 * Sign-in uses the platform's own cookie session. The cookie is `HttpOnly` and `SameSite=Strict`
 * — `chat.` and `api.jarvisclaw.ai` share a registrable domain, so they are same-site and the
 * cookie travels. This code never sees it and could not read it if it tried, which is the point:
 * the session is the browser's, not ours.
 *
 * The selected API KEY is held in memory only, never in localStorage. A key is a bearer
 * credential that can mint more keys and read the account, so persisting it would leave it on a
 * shared machine after the tab closed. Conversations and limits are persisted; this is not.
 */

import { DEFAULT_BASE_URL } from './gateway'

export interface Account {
  id: number
  username: string
  displayName: string
  /** Remaining quota in the platform's own units. */
  quota: number
  usedQuota: number
}

export interface ApiKeyRef {
  id: number
  name: string
  /** Remaining quota for this key, or null when it is unlimited. */
  remainQuota: number | null
  unlimited: boolean
  expired: boolean
  exhausted: boolean
}

/**
 * The platform's quota-to-dollars divisor.
 *
 * 500000 quota = $1. Hardcoding the ratio is not ideal, but the alternative is worse: the
 * endpoint that reports it needs an admin session, and showing a raw six-digit quota number
 * where a person expects a balance is how "$0.00" bugs get reported. If the platform ever
 * changes this, the displayed balance is wrong by a constant factor — visible, not silent.
 */
const QUOTA_PER_USD = 500_000

export function quotaToUsd(quota: number): number {
  return Number.isFinite(quota) ? quota / QUOTA_PER_USD : 0
}

interface ApiEnvelope<T> {
  success?: boolean
  message?: string
  data?: T
}

/**
 * Calls a platform API endpoint with the browser's own session.
 *
 * Two things here are load-bearing:
 *
 *   credentials: 'include' — without it the session cookie is not sent at all, and every call
 *   answers "not logged in" even in a browser that is.
 *
 *   New-Api-User — the platform requires this header on every session-authenticated route and
 *   compares it against the session's own user id, answering 401 on a mismatch. So it cannot be
 *   guessed or omitted; it comes from the /api/user/self response.
 */
async function platformCall<T>(
  path: string,
  opts: { baseUrl?: string; userId?: number; method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.userId !== undefined) headers['New-Api-User'] = String(opts.userId)

  const res = await fetch((opts.baseUrl ?? DEFAULT_BASE_URL) + path, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: opts.signal,
  })

  // The platform answers 200 with {success:false} for auth failures as often as it uses a 4xx,
  // so the status alone is not the verdict — reading only res.ok would treat "not logged in" as
  // a successful empty response.
  const body = (await res.json().catch(() => ({}))) as ApiEnvelope<T>
  if (!res.ok || body.success === false) {
    throw new Error(body.message ?? `the platform answered ${res.status}`)
  }
  if (body.data === undefined) {
    throw new Error('the platform returned no data')
  }
  return body.data
}

/**
 * Origins the gateway will accept a credentialed request from.
 *
 * This is not defensive coding — it fixes a defect a probe caught. The session check is a
 * credentialed request, so the gateway answers it from an origin whitelist. Fired from anywhere
 * else, the browser logs
 *
 *   "Access to fetch … blocked by CORS policy … No 'Access-Control-Allow-Origin'"
 *
 * on EVERY page load. That is unavoidable at the network level — a blocked preflight is reported
 * by the browser itself and no `catch` can suppress it — so the only way not to log it is not to
 * make the request. A console full of CORS failures on a working page is how a real error gets
 * ignored.
 *
 * The consequence is honest and worth stating: signing in works on the deployed site and on a
 * dev server the gateway whitelists, and is simply unavailable elsewhere. The panel then shows
 * the sign-in link, which is the same thing a signed-out visitor sees.
 */
/**
 * MEASURED against production, not assumed. I first listed the localhost dev origins here on the
 * grounds that they appear in this app's CSP — and a probe still logged the CORS error, because
 * the CSP and the GATEWAY's whitelist are different lists maintained in different places:
 *
 *   https://chat.jarvisclaw.ai  -> access-control-allow-origin: https://chat.jarvisclaw.ai
 *   http://localhost:3000       -> no header at all (rejected)
 *   http://127.0.0.1:3000       -> no header at all (rejected)
 *
 * So account sign-in works on the deployed site only. Adding a dev origin here does not make it
 * work; it has to be added to CORS_ALLOWED_ORIGINS on the gateway host first, and then here.
 */
const CREDENTIALED_ORIGINS = ['https://chat.jarvisclaw.ai']

function sessionCheckAllowed(): boolean {
  if (typeof window === 'undefined') return false
  return CREDENTIALED_ORIGINS.includes(window.location.origin)
}

interface RawSelf {
  id?: number
  username?: string
  display_name?: string
  quota?: number
  used_quota?: number
}

/**
 * Who is signed in, or null when nobody is.
 *
 * Returns null rather than throwing on failure: "not signed in" is the ordinary state on a first
 * visit, and treating it as an error would put a red banner on the page for every new visitor.
 */
export async function whoami(opts: { baseUrl?: string; signal?: AbortSignal } = {}): Promise<Account | null> {
  if (!sessionCheckAllowed()) return null
  try {
    /**
     * Two calls, and the first one is the fix for a real bug.
     *
     * `/api/user/self` sits behind UserAuth, which requires a `New-Api-User` header carrying the
     * caller's own user id. Measured against production from this origin:
     *
     *   /api/user/self WITHOUT the header -> 401 "Unauthorized, New-Api-User header not provided"
     *   /api/user/self WITH    the header -> 200
     *
     * So the very first call could never succeed: it is asking who the session belongs to, and it
     * cannot send an id it does not have yet. A signed-in user pressed "I've signed in" and was
     * told, permanently, that they were signed out. The console never hits this because its login
     * response gives it the id and it keeps it in `localStorage` — which is per-origin, so nothing
     * here can read it.
     *
     * `/api/user/session` (added in the gateway alongside this) answers with the id using nothing
     * but the session cookie. Everything after that goes through the header-requiring routes as
     * normal.
     */
    const ident = await platformCall<{ id?: number }>('/api/user/session', opts)
    if (typeof ident.id !== 'number' || ident.id <= 0) return null

    const self = await platformCall<RawSelf>('/api/user/self', { ...opts, userId: ident.id })
    if (typeof self.id !== 'number') return null
    return {
      id: self.id,
      username: self.username ?? '',
      displayName: self.display_name || self.username || `user ${self.id}`,
      quota: Number(self.quota ?? 0),
      usedQuota: Number(self.used_quota ?? 0),
    }
  } catch {
    return null
  }
}

interface RawToken {
  id?: number
  name?: string
  status?: number
  remain_quota?: number
  unlimited_quota?: boolean
  expired_time?: number
}

/** Platform token status codes. 1 is enabled; these two are why a key will not work. */
const STATUS_EXPIRED = 3
const STATUS_EXHAUSTED = 4

/**
 * The account's API keys — metadata only. The secret is fetched separately, per key.
 *
 * Listing is deliberately separate from revealing: the list is what the picker shows, and
 * pulling every secret to render a dropdown would put credentials the user did not ask for into
 * this page's memory.
 */
export async function listKeys(opts: {
  baseUrl?: string
  userId: number
  signal?: AbortSignal
}): Promise<ApiKeyRef[]> {
  // `p` and `page_size` are the platform's own query names (common.GetPageQuery), and the
  // response is a paginated envelope — `data.items`, not a bare array. Reading `data` as an
  // array would find no rows and report an empty key list for an account that has keys.
  const page = await platformCall<{ items?: RawToken[] }>('/api/token/?p=1&page_size=100', opts)
  const rows = Array.isArray(page?.items) ? page.items : []
  return rows
    .filter((r): r is RawToken & { id: number } => typeof r.id === 'number')
    .map((r) => ({
      id: r.id,
      name: r.name || `key ${r.id}`,
      unlimited: r.unlimited_quota === true,
      remainQuota: r.unlimited_quota === true ? null : Number(r.remain_quota ?? 0),
      expired: r.status === STATUS_EXPIRED,
      exhausted: r.status === STATUS_EXHAUSTED,
    }))
    // A disabled key is offered but marked, not hidden: someone looking for a key they know
    // exists should find it and learn why it will not work, rather than conclude it is gone.
    .sort((a, b) => {
      const usable = (k: ApiKeyRef) => (k.expired || k.exhausted ? 1 : 0)
      return usable(a) - usable(b) || a.name.localeCompare(b.name)
    })
}

/**
 * Reveals one key's secret.
 *
 * Behind CriticalRateLimit and DisableCache on the platform side, which is why this is only
 * called when the user picks a key rather than eagerly for the whole list.
 */
export async function revealKey(opts: {
  baseUrl?: string
  userId: number
  keyId: number
  signal?: AbortSignal
}): Promise<string> {
  const data = await platformCall<{ key?: string }>(`/api/token/${opts.keyId}/key`, {
    ...opts,
    method: 'POST',
  })
  const key = data.key
  if (typeof key !== 'string' || key === '') {
    throw new Error('the platform returned no key')
  }
  // The platform stores the key without the `sk-` prefix that the relay expects on the
  // Authorization header. Adding it here rather than at each call site keeps one place
  // responsible for the wire format.
  return key.startsWith('sk-') ? key : `sk-${key}`
}

export async function signOut(opts: { baseUrl?: string; userId: number } = { userId: 0 }): Promise<void> {
  try {
    await platformCall('/api/user/logout', { ...opts, method: 'GET' })
  } catch {
    // Best effort. The in-memory key and account are dropped by the caller regardless, which is
    // what actually ends the session's usefulness to this page.
  }
}

/** Where a visitor goes to sign in, or to make a key. Both are real pages on the platform. */
/**
 * The console's real auth and key pages.
 *
 * `/en/sign-in`, NOT `/en/login`. I shipped `/en/login` and "verified" it by checking that it
 * answered 200 — which proves nothing about an SPA, because the static host serves index.html
 * for every path. Checked properly in a browser:
 *
 *   /en/sign-in       -> renders a form (1 password input)
 *   /en/login         -> renders "Not Found"
 *   /en/nonsense-xyz  -> renders "Not Found"      <- indistinguishable from /en/login
 *
 * A status code cannot tell a real route from a client-side 404. The route files are the other
 * source of truth: `src/routes/{-$lang}/(auth)/sign-in.tsx` exists and no login.tsx does.
 *
 * The redirect parameter is the console's own: visiting /en/keys unauthenticated bounces to
 * `/en/sign-in?redirect=%2Fen%2Fkeys`, so passing it sends the user straight to their keys after
 * signing in rather than dropping them on a dashboard to find them.
 */
export const SIGN_IN_URL = `${DEFAULT_BASE_URL}/en/sign-in?redirect=%2Fen%2Fkeys`
export const KEYS_URL = `${DEFAULT_BASE_URL}/en/keys`

/**
 * The host the sign-in link actually opens, derived rather than written out.
 *
 * The button said "Sign in on jarvisclaw.ai" while linking to api.jarvisclaw.ai. Both serve the
 * same SPA, but they are different hosts and the session cookie is set on the one the link opens
 * — so the label was naming a host the flow does not use. Deriving it means the two cannot drift
 * again when DEFAULT_BASE_URL changes.
 */
export const SIGN_IN_HOST = (() => {
  try {
    return new URL(DEFAULT_BASE_URL).host
  } catch {
    // A malformed base URL is not worth breaking the panel over; the link is still correct.
    return 'jarvisclaw.ai'
  }
})()

/**
 * Whether this origin can read a platform session at all.
 *
 * Exposed so the panel can say "not available here" instead of offering a re-check button that
 * can only ever report nothing. A control that silently does nothing is worse than its absence.
 */
export function canUseAccount(): boolean {
  return sessionCheckAllowed()
}
