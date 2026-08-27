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
| `/showcase/<key>` | GET, HEAD | serves a curated prompt-gallery asset. Read-only, no write door at all |

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
media-cache-1d    prefix media/     expire after 1 day    # cache, still disposable
(none)            prefix gallery/   never expires         # paid artifacts, kept
(none)            prefix showcase/  never expires         # curated examples, kept
```

Verified live rather than assumed — `wrangler r2 bucket lifecycle list jarvisclaw-media` returns
only `media-cache-1d` (prefix `media/`) plus R2's default multipart-abort rule. So **the 24-hour
expiry applies to the cache alone**; nothing a user paid for and nothing in the prompt gallery is
on a clock.

There is a *separate* 24 hours worth knowing, because it is easy to confuse with this one: the
gateway's own async job store keeps a generation's RESULT for 24h (`ColdTTL` in
`relay/channel/blockrun/handler_video.go`). That is how long the gateway can still hand you a
finished job you never collected — unrelated to how long the stored file survives, which is
forever once `/gallery` has copied it.

Applied with:

```sh
wrangler r2 bucket lifecycle add jarvisclaw-media media-cache-1d media/ --expire-days 1 --force
wrangler r2 bucket lifecycle remove jarvisclaw-media --name auto-cleanup
```

**Do not re-add an all-prefixes expiry.** It would silently delete everything in every gallery.

## The showcase prefix

`showcase/` holds two prompt collections — 146 files in total — uploaded by
`upload-showcase.ps1`. Pass `-Match 'sd-'` to send only the second set; re-uploading all 146 to
add one is slow and each redundant PUT is another chance at a partial write on a file that was
already correct.

| set | files | source |
|---|---|---|
| Franklin gallery | 36 | franklin.run/gallery |
| Seedance prompts | 110 (105 posters + 5 clips) | YouMind-OpenLab/awesome-seedance-2-prompts, CC BY 4.0 |

They are copied to our own R2 rather than hotlinked for two independent reasons, both measured:

- the app's CSP allows images from `self`, `data:` and `https:` — but a third-party host also
  needs to permit hotlinking, and nothing guarantees franklin.run (or pbs.twimg.com, which hosts
  92 of the Seedance frames) will keep those paths. A deleted tweet is a hole in the gallery;
- `POST /gallery` refuses every one of those sources outright: `403 {"error":"source host
  franklin.run is not allowed"}`. That allowlist is doing its job; it is not a bug to route
  around.

### Why only 5 of 105 Seedance entries have a clip

The collection publishes most of its videos as Cloudflare Stream, which serves HLS and DASH
manifests and no direct file. Measured on one of those ids:

```
/manifest/video.m3u8    200 application/vnd.apple.mpegurl
/manifest/video.mpd     200 application/dash+xml
/downloads/default.mp4  404
```

Playing HLS needs a JS player, and `script-src 'self'` has no reason to admit one on a page that
holds an API key. The 5 playable entries are the ones whose MP4 the repo published on GitHub
Releases. The other 100 ship as a result frame plus the prompt, and `seedance.ts` carries a
`playable` flag so the UI renders them as stills rather than as players with nothing behind them.

The upload script is PowerShell, not sh. Running the sh version through Git Bash on Windows
resolves `wrangler` to the npm shim under a `/mnt/c` path whose bundled workerd binary does not
exist for that platform, and it dies inside `generateBinPath` with a stack trace that names
nothing relevant. The script also must NOT use `$ErrorActionPreference = 'Stop'`: wrangler writes
a proxy warning to stderr on every call, Windows PowerShell wraps native stderr in ErrorRecords,
and the first one aborts the loop after a single file.

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
