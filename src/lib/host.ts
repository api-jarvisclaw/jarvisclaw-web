/**
 * The hostname this app is served from.
 *
 * One constant, because three separate things have to agree on it and each of them fails
 * differently when they drift:
 *
 *   - the credentialed-origin allowlist in account.ts — wrong value means sign-in silently
 *     does nothing, because the gateway rejects the origin and no `catch` can report it;
 *   - the Worker's custom domain in wrangler.jsonc;
 *   - the copy in AccountPanel that tells a visitor where session reading works.
 *
 * ## The move from chat.jarvisclaw.ai
 *
 * The site was served from `chat.jarvisclaw.ai` and is now on `ducat.jarvisclaw.ai`. The old
 * hostname is **detached**, by explicit decision — not left redirecting.
 *
 * Worth recording plainly, because it is the kind of thing someone will come back to when a
 * link fails: any `chat.jarvisclaw.ai` URL already handed out is now dead, and this app has no
 * code path that rescues it. I argued for keeping it attached and serving a redirect, on the
 * grounds that this is the page a user returns to while a paid video is still rendering and a
 * dead host there reads as lost money rather than a moved bookmark. That was considered and
 * declined; the old name had not been distributed widely enough for the cost to be real.
 *
 * If that turns out to be wrong, the fix is not a client-side redirect: re-attach the hostname
 * in wrangler.jsonc and serve a 301 at the edge, which works for crawlers and curl too.
 */

export const CANONICAL_HOST = 'ducat.jarvisclaw.ai'

/** The origin, for comparing against `window.location.origin`. */
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`
