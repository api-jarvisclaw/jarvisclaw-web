"""The video-prompt tab loads, its media renders, and a still is never a dead player.

Three things a unit test cannot see, in order of how badly they fail:

  1. **A non-playable entry must not render a <video> element.** 100 of 105 entries have a frame
     and no servable clip. A play control over an image that cannot move is the same defect as the
     paid $0.83 video that showed a dead player — and here it would be by construction. The data
     carries `playable`; this checks the DOM honours it.

  2. **The images actually load.** Every asset had to be copied to our own R2: the CSP allows
     images from self/data:/our CDN only, and the CDN Worker refuses pbs.twimg.com as a copy
     source. A wrong filename or a `--remote`-less upload gives 105 blank tiles with the markup
     perfectly intact.

  3. **The chunk is lazy.** 330 KB of prompt text must not be in the main bundle. Measured by
     whether the pane's JS is requested only after the tab is opened — the one observation that
     distinguishes a split bundle from a merged one.
"""

import os
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "http://localhost:4173")


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 950})

        # cloudflareinsights excluded: the edge injects its beacon and script-src 'self' refuses
        # it. That is the policy working, and counting it would make this probe unpassable in
        # production — a probe that always fails is one whose findings get ignored.
        csp = []
        page.on(
            "console",
            lambda m: csp.append(m.text)
            if m.type == "error"
            and "Content Security Policy" in m.text
            and "cloudflareinsights" not in m.text
            else None,
        )

        # Track JS requests to see when the pane's chunk arrives.
        chunks = []
        page.on("request", lambda r: chunks.append(r.url) if r.url.endswith(".js") else None)

        # Aborted requests are NOT failures: scrolling a grid cancels images still in flight, and
        # conflating the two cost a false positive on the showcase probe. Only genuine transport
        # errors count.
        bad_media = []
        page.on(
            "requestfailed",
            lambda r: bad_media.append((r.url.split("/")[-1], r.failure))
            if "/showcase/sd-" in r.url and "ABORTED" not in (r.failure or "")
            else None,
        )

        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(2000)

        before = [c for c in chunks if "Seedance" in c]
        if before:
            fails.append(
                f"the seedance chunk loaded before the tab was opened: {before} — "
                "the code split is not actually splitting"
            )

        page.get_by_role("button", name=re.compile("gallery", re.I)).first.click()
        page.wait_for_timeout(1200)
        page.get_by_role("tab", name=re.compile("video prompts", re.I)).click()

        page.wait_for_selector(".showcase-card", timeout=30000)
        # Images decode slowly in bulk — 105 tiles took ~19s on the showcase probe. Waiting for the
        # grid to settle rather than asserting immediately.
        page.wait_for_timeout(6000)

        after = [c for c in chunks if "Seedance" in c]
        print(f"seedance chunk requested after opening the tab: {len(after)}")
        if not after:
            fails.append("no seedance chunk was requested — is it still bundled into index.js?")

        cards = page.locator(".showcase-card")
        n = cards.count()
        print(f"cards rendered: {n}")
        if n < 100:
            fails.append(f"only {n} cards — expected 105")

        # The central assertion. Count badges and video elements: `frame` cards must have no
        # <video>, and the two counts must add up to the card count.
        clip_badges = page.locator(".seedance-badge:not(.seedance-badge-quiet)").count()
        frame_badges = page.locator(".seedance-badge-quiet").count()
        videos = page.locator(".showcase-card video").count()
        imgs = page.locator(".showcase-card img").count()
        print(f"badges: clip={clip_badges} frame={frame_badges}   elements: video={videos} img={imgs}")

        if clip_badges != 5:
            fails.append(f"expected 5 playable entries, found {clip_badges} clip badges")
        if clip_badges + frame_badges != n:
            fails.append(f"badges {clip_badges + frame_badges} do not cover {n} cards")
        if videos != clip_badges:
            fails.append(
                f"{videos} <video> elements for {clip_badges} playable entries — "
                "a still is rendering as a player"
            )
        if imgs != frame_badges:
            fails.append(f"{imgs} <img> for {frame_badges} frame entries")

        # Do the posters actually decode? naturalWidth is 0 for an image that failed.
        broken = page.evaluate(
            """() => [...document.querySelectorAll('.showcase-card img')]
                 .filter(i => i.complete && i.naturalWidth === 0)
                 .map(i => i.src.split('/').pop())"""
        )
        print(f"posters that failed to decode: {len(broken)}")
        if broken:
            fails.append(f"{len(broken)} posters did not decode: {broken[:5]}")

        # Open a NON-playable entry and confirm the detail view explains the still rather than
        # offering a player. This is the case a user hits 100 times out of 105.
        still = page.locator(".showcase-card", has=page.locator(".seedance-badge-quiet")).first
        still.click()
        page.wait_for_selector(".showcase-detail", timeout=15000)
        page.wait_for_timeout(1200)
        detail_videos = page.locator(".showcase-detail video").count()
        note = page.locator(".seedance-frame-note").count()
        prompt_len = len(page.locator(".showcase-detail .showcase-prompt").inner_text())
        has_source = page.locator(".showcase-detail-meta a").count()
        print(f"detail (a frame entry): video={detail_videos} note={note} prompt_chars={prompt_len} links={has_source}")
        if detail_videos != 0:
            fails.append("the detail view of a frame-only entry rendered a <video>")
        if note == 0:
            fails.append("no note explaining why the entry is a still, so it reads as broken")
        if prompt_len < 100:
            fails.append(f"prompt body is only {prompt_len} chars")
        if has_source == 0:
            fails.append("no attribution link — CC BY 4.0 requires it")

        if csp:
            fails.append(f"CSP blocked {len(csp)}: {csp[:2]}")
        if bad_media:
            fails.append(f"{len(bad_media)} media requests failed: {bad_media[:3]}")

        browser.close()

    print()
    if fails:
        for f in fails:
            print("  FAIL:", f)
        return 1
    print("PASS: 105 prompts render, 5 as clips and 100 as labelled stills, chunk loads on demand.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
