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

export interface GalleryItem {
  id: string
  kind: GalleryKind
  /** Permanent CDN URL. */
  url: string
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
