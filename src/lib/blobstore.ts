/**
 * Where inline media bytes live, so they stop destroying the conversation history.
 *
 * ## The bug this fixes, measured
 *
 * Speech endpoints return audio as base64 in the response body, not as a URL. That string went
 * straight into a turn, and turns are persisted by `saveConversations` into a single localStorage
 * value. Measured in a browser:
 *
 *   localStorage holds ~4 MB for this origin
 *   one 30s speech clip is ~640 KB of base64
 *   7 such conversations were written, then QuotaExceededError
 *   13 of the next 20 were NEVER PERSISTED — and nothing said so
 *
 * `saveConversations` catches its exception on the reasoning that a full store is not worth
 * interrupting a working conversation over. That is right about the interruption and wrong about
 * the silence: after the first failure every later write fails too, so a refresh returns the user
 * to whatever was last written successfully. They lose work with no way to know why. That is
 * exactly the complaint — "generated content disappears when I refresh".
 *
 * ## Why IndexedDB rather than a bigger localStorage budget
 *
 * There is no bigger budget. Measured on this origin: `localStorage` ~4 MB, `navigator.storage
 * .estimate().quota` 6144 MB. IndexedDB is three orders of magnitude larger and stores Blobs
 * natively, so audio is kept as bytes rather than as base64 — which is itself a 33% saving before
 * the quota even matters.
 *
 * The conversation JSON then holds a short key instead of the payload, and a transcript with ten
 * speech clips costs a few hundred bytes rather than 6 MB.
 *
 * ## What this is NOT
 *
 * Not a replacement for the R2 archive. Anything with an http(s) URL is copied to the CDN by
 * `archive()` and is permanent and shareable. This is only for results that arrive as inline bytes,
 * which the CDN Worker cannot fetch — it copies from an allowlisted host and a `data:` URL has no
 * host. Those bytes exist in one browser and nowhere else, and the UI has to say so.
 */

const DB_NAME = 'jarvisclaw.media'
const STORE = 'blobs'
const DB_VERSION = 1

/**
 * Opened lazily and cached, because opening is async and every caller would otherwise pay for it.
 *
 * A rejected promise is NOT cached: IndexedDB is unavailable in some private-browsing modes and
 * blocked outright by some enterprise policies, and caching that rejection would make a transient
 * failure permanent for the session.
 */
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('could not open the media store'))
    // A blocked open means another tab holds an older version. Not fatal and not worth hanging
    // on: the caller falls back to keeping bytes in memory for this page load.
    req.onblocked = () => reject(new Error('the media store is blocked by another tab'))
  }).catch((err) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('media store request failed'))
      }),
  )
}

/** Turns base64 into a Blob without a data: URL round trip. */
function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

/**
 * Stores inline bytes and returns the key to put in the turn.
 *
 * Returns null on any failure rather than throwing. The media is already on screen and already
 * paid for; failing to persist it must not also break the conversation it belongs to. The caller
 * keeps the bytes in memory for this page load and the turn simply does not survive a reload —
 * which is the old behaviour, not a regression.
 */
export async function putMedia(id: string, b64: string, mime: string): Promise<string | null> {
  try {
    const blob = b64ToBlob(b64, mime)
    await tx('readwrite', (s) => s.put(blob, id))
    return id
  } catch {
    return null
  }
}

/**
 * Reads stored bytes back as an object URL, or null when there are none.
 *
 * An object URL rather than a data: URL, deliberately. A data: URL for a 640 KB clip is an 850 KB
 * string that has to be built, held, and handed to the DOM; an object URL is a short handle to
 * bytes the browser already has. It also keeps the CSP simpler — `blob:` is covered by
 * `media-src 'self'`, where `data:` needs its own source.
 */
export async function getMediaUrl(id: string): Promise<string | null> {
  try {
    const blob = await tx<Blob | undefined>('readonly', (s) => s.get(id))
    if (!(blob instanceof Blob)) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

export async function deleteMedia(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id))
  } catch {
    // Nothing to do about it, and nothing depends on it succeeding.
  }
}

/**
 * Drops stored blobs whose key no longer appears in any conversation.
 *
 * Without this the store grows forever: deleting a conversation removes the key from localStorage
 * and leaves the bytes orphaned in IndexedDB, invisible and unreachable. 6 GB is a lot of room to
 * leak into before anyone notices.
 *
 * Takes the live key set rather than reading conversations itself, so this module stays unaware of
 * the conversation format — the thing most likely to change around it.
 */
export async function pruneMedia(liveKeys: Set<string>): Promise<number> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
    const dead = keys.filter((k) => typeof k === 'string' && !liveKeys.has(k))
    for (const k of dead) await tx('readwrite', (s) => s.delete(k))
    return dead.length
  } catch {
    return 0
  }
}

/** Whether inline bytes can be persisted at all here. Used to tell the user the truth. */
export async function mediaStoreAvailable(): Promise<boolean> {
  try {
    await openDb()
    return true
  } catch {
    return false
  }
}
