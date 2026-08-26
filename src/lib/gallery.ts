/**
 * The gallery: media the user paid for, kept.
 *
 * Two halves, and the split is what makes this work at all:
 *
 *   the BYTES live in R2 behind cdn.jarvisclaw.ai, because a generated media URL is temporary.
 *   An image that cost $0.064 is a dead link within hours, so a gallery of upstream URLs is a
 *   gallery of broken thumbnails.
 *
 *   the INDEX lives in localStorage, because there is no account. Nothing here identifies a
 *   person, and a server-side index would need one.
 *
 * The consequence is stated rather than hidden: the index is per-browser. Clearing site data
 * loses the list even though the files remain, and the list does not follow anyone to another
 * device. That is the honest cost of a console with no sign-in, and the UI says so.
 */

const KEY = 'jarvisclaw.gallery.v1'
const MAX_ITEMS = 200

/** Where the CDN worker lives. Not user-editable, for the same reason the gateway is not. */
export const CDN_BASE_URL =
  (import.meta.env?.VITE_CDN_URL as string | undefined) ?? 'https://cdn.jarvisclaw.ai'

export type GalleryKind = 'image' | 'video' | 'music' | 'speech'

/**
 * How long a stored artifact actually survives.
 *
 * The gallery said "stored permanently" about every row, and that is true of the archived ones and
 * false of the rest. Three genuinely different fates, and the difference is not cosmetic — one of
 * them is a file that will be gone tomorrow:
 *
 *   'kept'      — `cdn.jarvisclaw.ai/gallery/…`. Verified against the live bucket: the only
 *                 lifecycle rule is `media-cache-1d` on prefix `media/`, so `gallery/` has no
 *                 expiry at all. This is the normal case and the one worth having.
 *   'cache'     — `cdn.jarvisclaw.ai/media/…`. The read-through cache, and it EXPIRES AFTER ONE
 *                 DAY. A row here means `archive()` did not run or did not need to; the file is
 *                 real today and gone tomorrow.
 *   'upstream'  — someone else's host. `archive()` returned null (network failure, a source host
 *                 the CDN Worker will not copy from) and the row kept the provider's own URL.
 *                 Those links are short-lived by design — hours, in the cases measured.
 *   'thisTab'   — inline bytes in IndexedDB, for speech. Not on any CDN, because the Worker copies
 *                 from an allowlisted host and inline bytes have no host. Survives a reload; does
 *                 not survive clearing site data and does not exist on another device.
 *
 * Derived from the URL rather than stored on the item, deliberately: a stored field would be
 * whatever was true when the row was written, and the retention rule is a property of where the
 * bytes live now.
 */
export type Retention = 'kept' | 'cache' | 'upstream' | 'thisTab'

export function retentionOf(item: { url?: string; mediaKey?: string }, cdnBase = CDN_BASE_URL): Retention {
  if (!item.url) return item.mediaKey ? 'thisTab' : 'upstream'
  // Prefix-matched against the CDN origin, then the path. Checking the path alone would call any
  // host's `/gallery/…` permanent, which is exactly the kind of URL a provider might also use.
  if (item.url.startsWith(`${cdnBase}/gallery/`)) return 'kept'
  if (item.url.startsWith(`${cdnBase}/media/`)) return 'cache'
  return 'upstream'
}

/** One line a person can act on, per retention class. */
export const RETENTION_NOTE: Record<Retention, string> = {
  kept: 'Stored on our CDN. No expiry.',
  cache: 'In the CDN cache — this one expires about a day after it was made. Download it to keep it.',
  upstream: 'Still on the provider’s own host, which expires these within hours. Download it now.',
  thisTab: 'Held in this browser only. Survives a reload, but not clearing site data — and it is not on your other devices.',
}

/** Whether this row needs a warning rather than a note. */
export function retentionIsAtRisk(r: Retention): boolean {
  return r === 'cache' || r === 'upstream'
}

export interface GalleryItem {
  id: string
  kind: GalleryKind
  /**
   * Where the bytes are.
   *
   * NOT necessarily permanent, despite what this comment used to claim. `archive()` returns null on
   * failure and the caller keeps the provider's own URL — which expires in hours. `retentionOf`
   * reads this field to tell the two apart, and the UI says which one a row is.
   *
   * Empty for inline bytes (speech), which have no URL at all; those carry `mediaKey` instead.
   */
  url: string
  /** Set for media held as bytes in IndexedDB rather than on a CDN. See `retentionOf`. */
  mediaKey?: string
  prompt: string
  model: string
  usd: number
  createdAt: number
}

/**
 * Stores one artifact permanently and returns its CDN URL.
 *
 * `source` may be a temporary upstream URL or a `data:` URL. The two take different paths for a
 * reason that is not obvious: the Worker copies from an allowlisted HOST, so it cannot reach a
 * `data:` URL at all — inlined bytes (which is what speech returns) have to be uploaded, and
 * the Worker has no upload door by design. So a `data:` result is kept as-is by the caller and
 * only http(s) media is promoted to a permanent URL.
 *
 * Returns null when it could not be stored, rather than throwing: failing to archive a clip the
 * user already paid for must not lose the clip. The caller keeps the original URL.
 */
export async function archive(
  source: string,
  opts: { signal?: AbortSignal; cdnBase?: string } = {},
): Promise<string | null> {
  if (!/^https?:\/\//i.test(source)) return null
  try {
    const res = await fetch(`${opts.cdnBase ?? CDN_BASE_URL}/gallery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
      signal: opts.signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { url?: unknown }
    return typeof body.url === 'string' && body.url !== '' ? body.url : null
  } catch {
    // Network failure, CORS, an aborted navigation. None of them are worth surfacing: the media
    // is already on screen and the only thing lost is its place in the gallery.
    return null
  }
}

function isItem(v: unknown): v is GalleryItem {
  if (typeof v !== 'object' || v === null) return false
  const i = v as Partial<GalleryItem>
  return (
    typeof i.id === 'string' &&
    typeof i.url === 'string' &&
    typeof i.kind === 'string' &&
    typeof i.createdAt === 'number'
  )
}

export function loadGallery(): GalleryItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Filtered rather than trusted: one malformed row written by an older version must not
    // blank the whole gallery.
    return parsed.filter(isItem).sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export function saveGallery(items: GalleryItem[]): void {
  try {
    const trimmed = [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS)
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch {
    // Quota or a blocked store. The media itself is unaffected — only the index is.
  }
}

export function addToGallery(items: GalleryItem[], item: GalleryItem): GalleryItem[] {
  // De-duplicated by URL: pressing generate twice on an identical prompt yields two distinct
  // objects, but re-archiving the SAME url (a retry, a re-render) must not add a second row.
  const next = items.filter((i) => i.url !== item.url)
  next.unshift(item)
  return next
}

export function removeFromGallery(items: GalleryItem[], id: string): GalleryItem[] {
  return items.filter((i) => i.id !== id)
}

/**
 * Total spent on what is in the gallery.
 *
 * Worth showing: a gallery is the one place where the money already spent is visible as
 * artifacts, and the sum answers "what have I actually paid for" better than a session ledger
 * that resets.
 */
export function galleryTotalUsd(items: GalleryItem[]): number {
  return items.reduce((sum, i) => sum + (Number.isFinite(i.usd) ? i.usd : 0), 0)
}
