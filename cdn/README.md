# cdn.jarvisclaw.ai

The media Worker and its R2 bucket. `worker.js` here is the source of what serves that host.

## Why this directory exists

The Worker was already live — created 2026-06-07 with source `Upload`, meaning by hand, with no
repository behind it. Nothing in any repo described what was serving the CDN, so the only way to
learn its behaviour was to download the compiled bundle from Cloudflare. This directory makes a
deploy reproducible from source instead of from whoever last uploaded a zip.

It also corrects a wrong conclusion recorded elsewhere: that the platform had no media storage
layer, so a gallery was impossible. The bucket and Worker were live the whole time. Two facts
made it *look* unused, and both are benign:

- `object_count: 0` — the lifecycle rule was expiring everything daily (see below);
- `GET /` returns 404 — the Worker only claims `/media/` and `/gallery/`.

## Routes

| route | method | what it does |
|---|---|---|
| `/health` | GET | liveness |
| `/media/<key>` | GET, HEAD | read-through cache. R2 miss fetches `blockrun.ai/api/<key>`, stores it, serves it |
| `/gallery` | POST | copies one artifact into permanent storage. Body: `{"source": "https://…"}` |
| `/gallery/<key>` | GET, HEAD | serves a stored artifact. No upstream fallback — we were the only copy |

## Why `/gallery` copies from a URL instead of accepting bytes

This endpoint is unauthenticated. It cannot verify that the caller paid: the x402 signature was
spent at the gateway, and re-checking it here would mean building a second settlement path.

An endpoint that accepted a request body would therefore be free file hosting under our own
domain — and an HTML or SVG payload served from `cdn.jarvisclaw.ai` is a stored-XSS vector
against everything else on it. Copying from an allowlisted host bounds the worst case to a
duplicate of something those hosts already serve.

Layered on that:

- source must be `https` and its host must be in `COPY_FROM_HOSTS`;
- the content type comes from the **upstream response**, never from the caller, and must be in
  `GALLERY_TYPES` (no HTML, no SVG);
- 25 MB cap, enforced on the bytes in hand rather than on `Content-Length` (a chunked response
  can omit that header entirely);
- keys are generated here, so a caller cannot overwrite another object or escape the prefix;
- `/gallery/*` sources are refused — copying gallery to gallery is unbounded amplification.

A Worker **cannot fetch its own hostname** (Cloudflare answers 522 on the loopback), and almost
every gallery source *is* a `cdn.jarvisclaw.ai` URL because the gateway rewrites media there. So
same-host sources are read straight out of R2, which is both the fix and one less round trip.

## Lifecycle — the load-bearing bit

The bucket had one rule, `auto-cleanup`: **expire after 1 day, all prefixes**. Correct for a
cache, fatal for a gallery — stored artifacts would vanish overnight, and someone would find a
paid image gone with no explanation. It is also why the bucket read as empty.

Replaced with a prefix-scoped rule:

```
media-cache-1d    prefix media/    expire after 1 day     # cache, still disposable
(none)            prefix gallery/  never expires          # paid artifacts, kept
```

Applied with:

```sh
wrangler r2 bucket lifecycle add jarvisclaw-media media-cache-1d media/ --expire-days 1 --force
wrangler r2 bucket lifecycle remove jarvisclaw-media --name auto-cleanup
```

**Do not re-add an all-prefixes expiry.** It would silently delete everything in every gallery.

## Deploy

```sh
cd cdn && bunx wrangler deploy
```

`name` must stay `jarvisclaw-media-cdn` and the binding must stay `MEDIA_BUCKET`. Renaming
either succeeds at deploy time and breaks at runtime — a new Worker the custom domain does not
point at, or `env.MEDIA_BUCKET` being undefined.

## Verifying

```sh
curl -s https://cdn.jarvisclaw.ai/health                      # ok
curl -s -X POST https://cdn.jarvisclaw.ai/gallery \
  -H 'Content-Type: application/json' \
  -d '{"source":"https://evil.example/x.png"}'                # 403, host not allowed
```

`wrangler r2 object put` writes to a **local simulated bucket** unless you pass `--remote`. It
prints "Upload complete" either way, and the object is then unreadable through the live Worker.
