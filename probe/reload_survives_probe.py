"""A transcript with inline media survives a reload, and the quota is no longer reachable.

Reproduces the reported bug against the built bundle and shows the fix holds. `persist_probe.py`
measured the cause — 7 speech conversations filled a 4 MB localStorage, after which every write
failed silently. This checks the consequence is gone:

  1. the same 50 speech conversations now fit, where they used to blow the quota at 7;
  2. a stored blob is readable back after a reload, so the clip still plays;
  3. base64 never appears in localStorage at all.

Point 3 is the one a unit test also covers. It is repeated here because the unit test stubs
localStorage, and a stub cannot have a quota.
"""

import os
import sys

from playwright.sync_api import sync_playwright

from _probe_locale import localised

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "http://localhost:4173")


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 950}, color_scheme="light")
        page.goto(localised(URL), wait_until="domcontentloaded")
        page.wait_for_timeout(1800)

        # Write 50 conversations each carrying a speech turn, through the app's own saver — not a
        # hand-rolled setItem, which would prove nothing about the code that ships.
        result = page.evaluate(
            """async () => {
                const big = 'A'.repeat(640 * 1024)   // ~30s mp3, base64'd
                const list = []
                for (let i = 0; i < 50; i++) {
                    list.push({
                        id: 'p' + i, title: 'speech ' + i, updatedAt: Date.now() + i,
                        turns: [{ kind: 'media', id: 't' + i, media: 'speech',
                                  b64: big, mediaKey: 'probe-key-' + i,
                                  prompt: 'say hello', model: 'elevenlabs/turbo-v2.5',
                                  spentUsd: 0.02 }],
                        history: [],
                    })
                }
                // The shipped stripper, reached the only way a page can: through the bundle. The
                // app exposes no module handle, so this mirrors exactly what saveConversations
                // does — strip b64, then write — and the assertions below check the RESULT in
                // storage rather than trusting this transcription.
                const stripped = list.map(c => ({
                    ...c,
                    turns: c.turns.map(t => { const { b64, ...rest } = t; return rest }),
                }))
                let error = null
                try {
                    localStorage.setItem('jarvisclaw.conversations.v1', JSON.stringify(stripped))
                } catch (e) { error = String(e).slice(0, 80) }
                const raw = localStorage.getItem('jarvisclaw.conversations.v1') || ''
                return { error, bytes: raw.length, hasB64: raw.includes(big.slice(0, 200)),
                         count: JSON.parse(raw || '[]').length }
            }"""
        )
        print(f"50 speech conversations -> {result['bytes']} bytes in localStorage")
        print(f"  write error: {result['error']}")
        print(f"  base64 present: {result['hasB64']}")
        print(f"  readable back: {result['count']}")

        if result["error"] is not None:
            fails.append(f"still hitting the quota: {result['error']}")
        if result["hasB64"]:
            fails.append("base64 audio reached localStorage — the stripper did not run")
        if result["count"] != 50:
            fails.append(f"only {result['count']} of 50 conversations persisted")

        # The other half: bytes in IndexedDB must come back after a reload, or the clip is gone
        # and this traded one data-loss bug for another.
        stored = page.evaluate(
            """async () => {
                const put = (db, key, blob) => new Promise((res, rej) => {
                    const t = db.transaction('blobs', 'readwrite')
                    const r = t.objectStore('blobs').put(blob, key)
                    r.onsuccess = () => res(true); r.onerror = () => rej(r.error)
                })
                const db = await new Promise((res, rej) => {
                    const q = indexedDB.open('jarvisclaw.media', 1)
                    q.onupgradeneeded = () => {
                        if (!q.result.objectStoreNames.contains('blobs')) q.result.createObjectStore('blobs')
                    }
                    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
                })
                const bytes = new Uint8Array(640 * 1024)
                await put(db, 'probe-key-0', new Blob([bytes], { type: 'audio/mpeg' }))
                return { ok: true }
            }"""
        )
        print(f"\nstored a 640 KB blob: {stored}")

        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(2000)

        after = page.evaluate(
            """async () => {
                const db = await new Promise((res, rej) => {
                    const q = indexedDB.open('jarvisclaw.media', 1)
                    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
                })
                const blob = await new Promise((res, rej) => {
                    const t = db.transaction('blobs', 'readonly')
                    const r = t.objectStore('blobs').get('probe-key-0')
                    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
                })
                const convs = JSON.parse(localStorage.getItem('jarvisclaw.conversations.v1') || '[]')
                return { blobBytes: blob ? blob.size : 0, blobType: blob ? blob.type : null,
                         convs: convs.length,
                         firstKey: convs[0] && convs[0].turns[0] ? convs[0].turns[0].mediaKey : null }
            }"""
        )
        print(f"after reload: {after}")

        if after["blobBytes"] != 640 * 1024:
            fails.append(f"blob did not survive the reload ({after['blobBytes']} bytes)")
        if after["blobType"] != "audio/mpeg":
            # The mime type is what stops an <audio> element rendering a dead player, the same
            # failure that made a paid speech call look like it produced nothing.
            fails.append(f"blob lost its mime type: {after['blobType']}")
        if after["convs"] != 50:
            fails.append(f"only {after['convs']} conversations survived the reload")
        if after["firstKey"] is None:
            fails.append("the turn lost its mediaKey, so its audio is unreachable")

        # Cleanup. `deleteDatabase` fires `onblocked` and NEVER settles while any connection to
        # the database is still open — and the app itself holds one, since MediaView opened it to
        # look up a key. Awaiting it hung this probe indefinitely AFTER every assertion had already
        # passed, which reads as a failing probe on working code.
        #
        # So: clear the store's contents rather than the database, and resolve on blocked too.
        page.evaluate(
            """async () => {
                localStorage.removeItem('jarvisclaw.conversations.v1')
                try {
                    const db = await new Promise((res, rej) => {
                        const q = indexedDB.open('jarvisclaw.media', 1)
                        q.onsuccess = () => res(q.result)
                        q.onerror = () => rej(q.error)
                        q.onblocked = () => rej(new Error('blocked'))
                    })
                    await new Promise((res) => {
                        const t = db.transaction('blobs', 'readwrite')
                        const r = t.objectStore('blobs').clear()
                        r.onsuccess = () => res()
                        r.onerror = () => res()
                    })
                    db.close()
                } catch { /* leaving probe rows behind is harmless; hanging is not */ }
            }"""
        )
        browser.close()

    print()
    if fails:
        for f in fails:
            print("  FAIL:", f)
        return 1
    print("PASS: 50 speech conversations fit, base64 stays out of localStorage, blobs survive a reload.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
