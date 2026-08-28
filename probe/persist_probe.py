"""What survives a refresh, and what a full localStorage does to the rest.

The reported symptom is "generated content disappears when I refresh". Both the conversation list
and the gallery index ARE written to localStorage, so the interesting question is not whether the
code saves — it does — but whether the write SUCCEEDS.

`saveConversations` and `saveGallery` both swallow their exceptions, on the reasoning that a full
store is not worth interrupting a working conversation over. That is right about the interruption
and wrong about the silence: once the quota is hit, every subsequent write fails, nothing says so,
and a refresh returns the user to whatever state was last written successfully. They lose work and
there is no way for them to know why.

This measures it directly: fill the store to near quota, add a conversation, reload, and see what
came back.
"""

import json
import os
import sys

from playwright.sync_api import sync_playwright

from _probe_locale import localised

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "http://localhost:4173")

CONV_KEY = "jarvisclaw.conversations.v1"
GALLERY_KEY = "jarvisclaw.gallery.v1"


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 950})
        page.goto(localised(URL), wait_until="domcontentloaded")
        page.wait_for_timeout(1500)

        # How much can this origin actually hold? Measured rather than assumed — the 5 MB figure
        # is a convention, not a spec.
        cap = page.evaluate(
            """() => {
                const key = '__probe_cap__'
                let mb = 0
                try {
                    for (; mb < 12; mb++) {
                        localStorage.setItem(key, 'x'.repeat((mb + 1) * 1024 * 1024))
                    }
                } catch { /* hit the wall */ }
                localStorage.removeItem(key)
                return mb
            }"""
        )
        print(f"localStorage holds at least {cap} MB in one value")

        # A speech turn as the app actually writes it: inline base64, because the speech endpoints
        # return bytes rather than a URL and nothing strips them before persisting.
        result = page.evaluate(
            """() => {
                const out = { written: 0, error: null, readBack: 0 }
                const b64 = 'A'.repeat(640 * 1024)   // ~30s of mp3, base64'd
                const list = []
                try {
                    for (let i = 0; i < 20; i++) {
                        list.push({
                            id: 'probe' + i, title: 'speech ' + i, updatedAt: Date.now() + i,
                            turns: [{ kind: 'media', id: 't' + i, media: 'speech', b64,
                                      model: 'elevenlabs/turbo-v2.5', usd: 0.02 }],
                            history: [],
                        })
                        // Exactly what saveConversations does, including the silent catch.
                        try {
                            localStorage.setItem('jarvisclaw.conversations.v1', JSON.stringify(list))
                            out.written = list.length
                        } catch (e) {
                            out.error = String(e).slice(0, 90)
                            break
                        }
                    }
                } catch (e) { out.error = String(e).slice(0, 90) }
                try {
                    const raw = localStorage.getItem('jarvisclaw.conversations.v1')
                    out.readBack = JSON.parse(raw || '[]').length
                } catch { out.readBack = -1 }
                return out
            }"""
        )
        print(f"speech conversations written before the quota bit: {result['written']}")
        print(f"error (which the app catches and ignores): {result['error']}")
        print(f"conversations readable after: {result['readBack']}")

        if result["error"] is None:
            print("NOTE: the store did not fill, so this run proves nothing about the quota path")
        else:
            # The finding. Everything after the first failure is lost, and the app said nothing.
            if result["written"] < 20:
                print(
                    f"\n  -> {20 - result['written']} of 20 conversations were never persisted, "
                    "with no error surfaced to the user"
                )

        # Does a gallery entry survive alongside it? The gallery is the thing the user actually
        # paid for, so it losing its place is the worse half of the same bug.
        gal = page.evaluate(
            """() => {
                try {
                    const item = { id: 'g1', kind: 'video', url: 'https://cdn.jarvisclaw.ai/gallery/x.mp4',
                                   prompt: 'a test', model: 'seedance', usd: 0.83, createdAt: Date.now() }
                    localStorage.setItem('jarvisclaw.gallery.v1', JSON.stringify([item]))
                    return { ok: true }
                } catch (e) { return { ok: false, error: String(e).slice(0, 90) } }
            }"""
        )
        print(f"\ngallery write with the store full: {gal}")
        if not gal.get("ok"):
            fails.append(
                "a PAID artifact could not be recorded because inline speech audio filled the "
                f"store: {gal.get('error')}"
            )

        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(2000)
        after = page.evaluate(
            """() => {
                const n = k => { try { return JSON.parse(localStorage.getItem(k) || '[]').length }
                                 catch { return -1 } }
                return { convs: n('jarvisclaw.conversations.v1'), gallery: n('jarvisclaw.gallery.v1') }
            }"""
        )
        print(f"after reload: {after}")

        page.evaluate(
            """() => { localStorage.removeItem('jarvisclaw.conversations.v1');
                       localStorage.removeItem('jarvisclaw.gallery.v1') }"""
        )
        browser.close()

    print()
    if fails:
        for f in fails:
            print("  FINDING:", f)
        return 1
    print("no quota failure reproduced in this run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
