/**
 * cdn.jarvisclaw.ai — media cache and gallery store.
 *
 * This file is the repo's copy of a Worker that already existed but was only ever created by
 * hand upload (deployed 2026-06-07, source "Upload", no git integration). Committing it is
 * half the point: nothing in any repository described what was serving the CDN, so the only
 * way to know its behaviour was to download the compiled bundle from Cloudflare.
 *
 * Two responsibilities, deliberately kept apart by key prefix:
 *
 *   /media/…    read-through cache for upstream media. UNCHANGED from what was deployed —
 *               R2 miss fetches the upstream, stores it, serves it. Every key must resolve to
 *               an upstream URL, which is why this path cannot store anything generated.
 *
 *   /gallery/…  a place for media the user actually paid for. Needed because the read-through
 *               path has no write door at all: a generated image lives at whatever URL the
 *               upstream gave it, that URL expires, and nothing was keeping a copy. This is
 *               what makes a gallery possible.
 *
 * The prefix split is load-bearing rather than tidy. The bucket has a lifecycle rule
 * (`auto-cleanup`, expire after 1 day, all prefixes) which is right for a cache and fatal for
 * a gallery — objects would vanish overnight, which is also why the bucket reads as empty.
 * A prefix-scoped rule replaces it; see cdn/README.md.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  // Content-Type must be allowed or the browser's preflight for a JSON POST fails before the
  // request is sent — the same class of bug that silently killed credentialed calls to the
  // gateway until api-server#528.
  'Access-Control-Allow-Headers': 'Content-Type',
}

/** Upstream media host. Keys under /media/ are paths beneath it. */
const ORIGIN = 'https://blockrun.ai/api/'
const ORIGIN_ALT = 'https://blockrun.ai/'

/** A gallery object may not exceed this. */
const MAX_GALLERY_BYTES = 25 * 1024 * 1024

/**
 * Hosts a gallery object may be copied FROM.
 *
 * This allowlist is what keeps the write endpoint from being open storage. The client does not
 * send bytes — it sends a URL, and the Worker fetches it. So the worst an abuser can do is ask
 * us to keep a second copy of something already hosted on these hosts, rather than upload
 * arbitrary content to our domain.
 *
 * Taking raw bytes was the obvious design and the wrong one: an unauthenticated endpoint that
 * accepts a body is free file hosting under our own origin, and this Worker cannot verify that
 * the caller paid for anything (the x402 signature was spent at the gateway, and re-checking it
 * here would mean building a second settlement path).
 */
const COPY_FROM_HOSTS = new Set(['cdn.jarvisclaw.ai', 'blockrun.ai', 'api.jarvisclaw.ai'])

/**
 * What may be stored.
 *
 * An allowlist, not a blocklist. An HTML or SVG payload served from our own domain would be a
 * stored-XSS vector against everything else on it, so only media types browsers do not execute
 * are accepted — checked against what the upstream actually returned, not what a caller claims.
 */
const GALLERY_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
])

/**
 * Keys are generated here, never taken from the caller.
 *
 * A caller-supplied key would let one visitor overwrite another's object, or write outside the
 * prefix entirely (`../`), so the client gets to choose nothing but the extension.
 */
function galleryKey(contentType) {
  const ext = EXT[contentType] ?? 'bin'
  const rand = crypto.randomUUID()
  const day = new Date().toISOString().slice(0, 10)
  return `gallery/${day}/${rand}.${ext}`
}

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 })
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    // Gallery writes. Checked before the read paths because it is the only non-GET route, and
    // `/gallery` (no trailing slash) cannot collide with a `/gallery/…` object key.
    if (url.pathname === '/gallery' && request.method === 'POST') {
      return putGallery(request, env)
    }

    const isMedia = url.pathname.startsWith('/media/')
    const isGallery = url.pathname.startsWith('/gallery/')
    if (!isMedia && !isGallery) {
      return new Response('Not Found', { status: 404, headers: CORS })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS })
    }

    const key = url.pathname.slice(1)

    try {
      const cached = await env.MEDIA_BUCKET.get(key)
      if (cached) {
        const headers = new Headers({
          'Content-Type': cached.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=43200',
          'X-Cache': 'HIT',
          ...CORS,
        })
        if (cached.size) headers.set('Content-Length', cached.size.toString())
        return new Response(request.method === 'HEAD' ? null : cached.body, { status: 200, headers })
      }

      // A gallery object that is not in R2 is simply gone — there is no upstream to fall back
      // to, because we were the only copy. Falling through to the origin fetch below would
      // ask blockrun.ai for a key it never had and return a confusing 404 from there.
      if (isGallery) {
        return new Response('Not Found', { status: 404, headers: CORS })
      }

      if (request.method === 'HEAD') {
        const headResp = await fetch(ORIGIN + key, { method: 'HEAD' })
        if (!headResp.ok) return new Response(null, { status: 404, headers: CORS })
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': headResp.headers.get('Content-Type') || 'application/octet-stream',
            'Content-Length': headResp.headers.get('Content-Length') || '0',
            'Cache-Control': 'public, max-age=43200',
            'X-Cache': 'MISS',
            ...CORS,
          },
        })
      }

      const originResp = await fetch(ORIGIN + key, {
        headers: { 'User-Agent': 'JarvisClaw-CDN/1.0' },
      })
      if (!originResp.ok) {
        const altResp = await fetch(ORIGIN_ALT + key, {
          headers: { 'User-Agent': 'JarvisClaw-CDN/1.0' },
        })
        if (!altResp.ok) return new Response('Not Found', { status: 404, headers: CORS })
        return handleOriginResponse(env, key, altResp)
      }
      return handleOriginResponse(env, key, originResp)
    } catch (err) {
      return new Response(`CDN Error: ${err.message}`, { status: 502, headers: CORS })
    }
  },
}

/**
 * Keeps a permanent copy of one paid artifact, by COPYING FROM a URL.
 *
 * Body: {"source": "https://…"}. The Worker fetches that URL and stores what comes back.
 *
 * The indirection is the security model. This endpoint is unauthenticated — it has no way to
 * verify the caller paid, because the x402 signature was spent at the gateway and re-checking
 * it here would mean building a second settlement path. Accepting raw bytes would therefore be
 * free file hosting on our own domain. Accepting only a URL from an allowlisted host means the
 * worst outcome is a duplicate of something those hosts already serve.
 *
 * The content type is taken from the upstream response and re-checked against the allowlist,
 * never from the caller: a caller-declared type is a claim, and the point of the check is what
 * the bytes actually are.
 */
async function putGallery(request, env) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return json({ error: 'body must be JSON: {"source": "https://…"}' }, 400)
  }

  const source = typeof payload?.source === 'string' ? payload.source : ''
  let src
  try {
    src = new URL(source)
  } catch {
    return json({ error: 'source must be an absolute URL' }, 400)
  }
  // https only. An http source would be fetched in cleartext and could be substituted in
  // transit, which is a strange thing to then serve permanently from our own domain.
  if (src.protocol !== 'https:') {
    return json({ error: 'source must be https' }, 400)
  }
  if (!COPY_FROM_HOSTS.has(src.hostname)) {
    return json(
      { error: `source host ${src.hostname} is not allowed`, allowed: [...COPY_FROM_HOSTS] },
      403,
    )
  }

  let body
  let contentType

  // A Worker cannot fetch its OWN hostname — Cloudflare answers 522 on the loopback. This is
  // the common case rather than an edge case: generated media is already rewritten to
  // cdn.jarvisclaw.ai by the gateway, so almost every gallery source is a URL this Worker
  // serves itself. Reading the object straight out of R2 is both the fix and strictly better,
  // since it skips a round trip through the edge.
  const self = new URL(request.url).hostname
  if (src.hostname === self) {
    const key = src.pathname.replace(/^\/+/, '')
    // Only the cache prefix. Copying `gallery/x` to `gallery/y` would let one request duplicate
    // stored objects indefinitely, which is the storage-abuse case the allowlist exists to stop.
    if (!key.startsWith('media/')) {
      return json({ error: 'only /media/ objects can be copied into the gallery' }, 400)
    }
    const obj = await env.MEDIA_BUCKET.get(key)
    if (!obj) {
      return json({ error: 'the source is no longer cached, so there is nothing to copy' }, 404)
    }
    contentType = (obj.httpMetadata?.contentType || '').split(';')[0].trim().toLowerCase()
    body = await obj.arrayBuffer()
  } else {
    let upstream
    try {
      upstream = await fetch(src.toString(), { headers: { 'User-Agent': 'JarvisClaw-CDN/1.0' } })
    } catch (e) {
      return json({ error: `could not fetch the source: ${e.message}` }, 502)
    }
    if (!upstream.ok) {
      return json({ error: `the source answered ${upstream.status}` }, 502)
    }
    contentType = (upstream.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase()
    body = await upstream.arrayBuffer()
  }

  if (!GALLERY_TYPES.has(contentType)) {
    return json({ error: `the source is ${contentType || 'an unknown type'}, not a storable medium` }, 415)
  }
  if (body.byteLength === 0) {
    return json({ error: 'the source returned no bytes' }, 502)
  }
  // Enforced on the bytes in hand, not on Content-Length. A chunked response can omit that
  // header entirely, which would leave the cap unenforced if it were the only check.
  if (body.byteLength > MAX_GALLERY_BYTES) {
    return json({ error: `too large: ${body.byteLength} bytes, limit ${MAX_GALLERY_BYTES}` }, 413)
  }

  const key = galleryKey(contentType)
  await env.MEDIA_BUCKET.put(key, body, { httpMetadata: { contentType } })

  const origin = new URL(request.url).origin
  return json({ key, url: `${origin}/${key}`, bytes: body.byteLength, contentType }, 201)
}

async function handleOriginResponse(env, key, originResp) {
  const contentType = originResp.headers.get('Content-Type') || 'application/octet-stream'
  const body = await originResp.arrayBuffer()
  try {
    await env.MEDIA_BUCKET.put(key, body, { httpMetadata: { contentType } })
  } catch (e) {
    // A failed cache write must not fail the request: the bytes are in hand and the caller
    // wants them. The next request simply misses again.
    console.error(`R2 put failed for ${key}: ${e.message}`)
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': body.byteLength.toString(),
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-Cache': 'MISS',
      ...CORS,
    },
  })
}
