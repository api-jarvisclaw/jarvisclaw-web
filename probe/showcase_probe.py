"""The prompt gallery renders, its media loads, and a prompt reaches the composer.

Franklin's gallery is a SHOWCASE — curated prompts with their results, meant to be copied and
re-run. That is a different thing from the gallery this app already had (media the user paid for),
which is why they are two tabs rather than one merged list.

What a unit test cannot check, and this does:

  - the images actually LOAD. Every asset had to be copied to our own R2, because the page's CSP
    allows images only from self/data:/https: and the CDN Worker refuses franklin.run as a copy
    source (measured: 403, host not allowed). A wrong path or a `--remote`-less upload gives 32
    blank tiles with the markup perfectly intact.
  - the media is served from R2 rather than proxied from somewhere. `X-Cache: HIT` is the proof.
  - "Make your own" lands the prompt in the composer in the right mode, which is the whole point
    of transcribing the gallery at all.
"""

import os
import re
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai/")


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 950})

        # cloudflareinsights is excluded, and that exclusion is the correct reading rather than
        # a convenience. Cloudflare injects its own analytics beacon into every response from the
        # edge; our `script-src 'self'` blocks it, which is the policy doing exactly its job on a
        # page that handles an API key. Counting it as a violation means this probe can never pass
        # in production — and a probe that always fails is one whose findings get ignored.
        csp_errors = []
        page.on(
            "console",
            lambda m: csp_errors.append(m.text)
            if m.type == "error"
            and "Content Security Policy" in m.text
            and "cloudflareinsights" not in m.text
            else None,
        )
        # Aborted requests are NOT failures, and conflating them cost me a false positive.
        # Scrolling the grid to force lazy images to load also cancels the ones still in flight —
        # a <video preload="metadata"> that is scrolled away mid-fetch reports
        # net::ERR_ABORTED. My first run reported "8 showcase requests failed outright" and "2
        # images did not decode" on a page that renders perfectly; a still run showed zero of
        # both. A probe that blames the app for its own scrolling is a probe whose findings get
        # ignored, so only genuine transport errors count here.
        failed_media = []
        page.on(
            "requestfailed",
            lambda r: failed_media.append((r.url.split("/")[-1], r.failure))
            if "/showcase/" in r.url and "ABORTED" not in (r.failure or "")
            else None,
        )
        cdn_status = {}
        page.on(
            "response",
            lambda r: cdn_status.setdefault(r.url.split("/")[-1], (r.status, r.headers.get("x-cache")))
            if "/showcase/" in r.url
            else None,
        )

        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".composer-shell textarea", timeout=30000)
        page.wait_for_timeout(2000)

        # ── open the gallery ──
        gal = page.get_by_role("button", name=re.compile("Gallery", re.I))
        if not gal.count():
            print("FAIL: no Gallery entry in the rail")
            return 1
        gal.first.click()
        page.wait_for_timeout(1500)

        tabs = page.locator(".gallery-tab").all_inner_texts()
        print("== tabs ==")
        for t in tabs:
            print("   ", t.strip().replace("\n", " "))
        # Named, not counted. This asserted `len(tabs) == 2` and failed the moment a third
        # collection was added — reporting a working gallery as broken, which is exactly how a
        # probe trains you to ignore it. What this probe is about is that the showcase and the
        # user's own creations are SEPARATE tabs; how many others exist is not its business.
        joined = " ".join(tabs).lower()
        for want in ("prompt gallery", "your creations"):
            if want not in joined:
                fails.append(f"no {want!r} tab: {tabs}")

        # ── the showcase grid ──
        page.wait_for_selector(".showcase-card", timeout=20000)
        cards = page.locator(".showcase-card").count()
        print(f"\n== grid ==\n   cards: {cards}")
        if cards != 32:
            fails.append(f"{cards} cards, expected 32")

        # Drives the SCROLL CONTAINER and then waits for decoding to settle.
        #
        # Three wrong versions of this check preceded it, each failing a page that renders
        # perfectly, and the lessons are worth keeping:
        #
        #   - `page.mouse.wheel` did nothing at all here. The transcript is its own scroll
        #     container and the cursor was outside it, so `transcript.scrollTop` stayed at 0
        #     through every scroll — measured. All the "scrolling" was decorative.
        #   - `loading="lazy"` only fetches what is near the viewport, so the grid has to be
        #     walked, not jumped.
        #   - scrolling back UP cancels requests the scroll just started, and those aborts read
        #     as broken assets.
        #   - decoding 28 images off the CDN takes ~19s on this connection. Any fixed wait short
        #     of that reports a healthy page as broken, which is the failure mode that gets a
        #     probe ignored.
        #
        # So: step the container down, then wait on the CONDITION rather than a duration.
        for i in range(1, 7):
            page.evaluate(
                f"() => {{ const t = document.querySelector('.transcript');"
                f" t.scrollTop = t.scrollHeight * {i} / 6 }}"
            )
            page.wait_for_timeout(1000)
        try:
            page.wait_for_function(
                """() => {
                  const imgs = Array.from(document.querySelectorAll('.showcase-card img'));
                  return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0);
                }""",
                timeout=60000,
            )
        except Exception:
            pass  # the assertions below report exactly what was missing

        loaded = page.evaluate(
            """() => {
              const imgs = Array.from(document.querySelectorAll('.showcase-card img'));
              const vids = Array.from(document.querySelectorAll('.showcase-card video'));
              return {
                imgs: imgs.length,
                imgsLoaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
                vids: vids.length,
                vidsReady: vids.filter(v => v.readyState >= 1 || v.poster).length,
                blank: imgs.filter(i => i.complete && i.naturalWidth === 0)
                           .map(i => i.src.split('/').pop()),
              };
            }"""
        )
        print(f"   images decoded: {loaded['imgsLoaded']}/{loaded['imgs']}")
        print(f"   videos ready  : {loaded['vidsReady']}/{loaded['vids']}")
        if loaded["blank"]:
            print(f"   blank: {loaded['blank'][:6]}")
        if loaded["imgs"] and loaded["imgsLoaded"] < loaded["imgs"]:
            fails.append(f"{loaded['imgs'] - loaded['imgsLoaded']} images did not decode")
        if loaded["vids"] and loaded["vidsReady"] < loaded["vids"]:
            fails.append(f"{loaded['vids'] - loaded['vidsReady']} videos have no poster or data")

        served = [(f, s) for f, s in cdn_status.items() if s[0] == 200]
        from_r2 = [f for f, s in served if s[1] == "HIT"]
        print(f"   served 200: {len(served)}   with X-Cache HIT: {len(from_r2)}")
        if served and not from_r2:
            # A MISS would mean the Worker went to an origin for these, which for showcase/ keys
            # is impossible by design — so this would mean the objects are not in R2 at all.
            fails.append("no showcase asset came from R2")

        # ── the detail view ──
        page.locator(".showcase-card").first.click()
        page.wait_for_selector(".showcase-detail", timeout=15000)
        page.wait_for_timeout(1200)

        title = page.inner_text(".showcase-detail-head h3").strip()
        meta = re.sub(r"\s+", " ", page.inner_text(".showcase-detail-meta")).strip()
        prompt = page.inner_text(".showcase-prompt").strip() if page.locator(".showcase-prompt").count() else ""
        print(f"\n== detail ==\n   title : {title}")
        print(f"   meta  : {meta[:80]}")
        print(f"   prompt: {len(prompt)} chars")

        if len(prompt) < 200:
            fails.append(f"the prompt is only {len(prompt)} chars")
        if "SeeDance" not in meta and "GPT Image" not in meta:
            fails.append("no model named in the detail view")
        if "prompt source" not in meta.lower() and "@" not in meta:
            # Attribution: these are other people's prompts, and dropping the credit to save a
            # line would be taking credit for writing that is not ours.
            fails.append("no attribution shown in the detail view")

        actions = page.locator(".showcase-prompt-actions button").all_inner_texts()
        print(f"   actions: {[a.strip() for a in actions]}")
        if not any("Copy" in a for a in actions):
            fails.append("no copy button")
        if not any("Make your own" in a for a in actions):
            fails.append("no run button")

        # ── "Make your own" reaches the composer ──
        page.get_by_role("button", name=re.compile("Make your own")).first.click()
        page.wait_for_timeout(1500)
        box = page.locator(".composer-shell textarea")
        text = box.input_value()
        active_mode = page.evaluate(
            "() => Array.from(document.querySelectorAll('.mode-btn'))"
            ".filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim())"
        )
        print(f"\n== after Make your own ==")
        print(f"   composer: {len(text)} chars   starts {text[:48]!r}")
        print(f"   mode    : {active_mode}")

        if len(text) < 200:
            fails.append(f"the prompt did not reach the composer ({len(text)} chars)")
        if text.strip() != prompt.strip():
            fails.append("the composer text differs from the prompt shown")
        if not active_mode:
            # A prompt written for video, left in chat mode, is a paid chat call that describes a
            # video instead of making one — the exact defect that cost $0.068 once already.
            fails.append("no generation mode was selected")

        # ── the other tab still works ──
        gal.first.click()
        page.wait_for_timeout(1200)
        page.get_by_role("tab", name=re.compile("Your creations")).click()
        page.wait_for_timeout(1000)
        mine = re.sub(r"\s+", " ", page.inner_text(".transcript")).strip()
        print(f"\n== your creations ==\n   {mine[:110]}")
        if "Nothing here yet" not in mine and page.locator(".gallery-card").count() == 0:
            fails.append("the paid-media tab rendered neither items nor an empty state")

        if csp_errors:
            print(f"\n   CSP errors: {csp_errors[:2]}")
            fails.append(f"{len(csp_errors)} CSP violations")
        if failed_media:
            print(f"   failed media requests: {failed_media[:3]}")
            fails.append(f"{len(failed_media)} showcase requests failed outright")

        browser.close()

    print()
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS: 32 examples render from our own R2, and a prompt reaches the composer in mode.")
    return 0


sys.exit(main())
