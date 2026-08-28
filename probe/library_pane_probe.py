"""Verify the prompt library renders, filters, and hands a prompt to the composer.

The data is covered by library.test.ts. What that cannot show is whether the tab opens, whether
the lazy chunk actually arrives, whether the category strip filters, and whether "Make your own"
puts the text where the user can send it — the last one being the only reason the collection is
here at all.

Also checks the thing a unit test structurally cannot: that the video/image distinction reaches
the composer. A cinematic shot description sent to the image endpoint returns a poster of a scene
instead of the scene, which reads as the model being bad rather than the prompt being for
something else.

Usage:
  python probe/library_pane_probe.py [base_url]
"""

import asyncio
import sys
from pathlib import Path
from urllib.parse import urlparse

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from playwright.async_api import async_playwright

MIME = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
    ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
}

# The measured collection size and its largest category. Asserted so a silent extraction
# regression — the kind that produced zero dreamcore prompts with no error — shows up here too.
EXPECTED_TOTAL = 119
EXPECTED_LARGEST = ("Cinematic shots", 42)


async def route_local(route):
    dist = Path(__file__).resolve().parent.parent / "dist"
    rel = urlparse(route.request.url).path.lstrip("/")
    target = dist / rel
    if not target.is_file():
        target = dist / "index.html"
    await route.fulfill(
        status=200,
        headers={"content-type": MIME.get(target.suffix, "application/octet-stream")},
        body=target.read_bytes(),
    )


async def main() -> int:
    failures: list[str] = []
    chunks: list[str] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await (await browser.new_context(viewport={"width": 1600, "height": 1200})).new_page()

        # Record which JS chunks load, so the code split can be verified rather than assumed.
        page.on("request", lambda r: chunks.append(urlparse(r.url).path)
                if r.url.endswith(".js") else None)

        await page.route("**/api/marketplace/**", lambda r: r.fulfill(
            status=200, json={"success": True, "data": {"items": [], "total": 0, "categories": []}}))
        await page.route("**/api/discovery/models**", lambda r: r.fulfill(
            status=200, json={"free": []}))
        await page.route("https://ducat.jarvisclaw.ai/**", route_local)
        # /en/gallery, not /gallery. A bare path resolves to whatever the RUNNING MACHINE's browser
        # asks for, so this probe read Chinese tabs on my laptop and failed on tab names that were
        # correct — a probe whose result depends on the tester's locale tests the tester.
        await page.goto("https://ducat.jarvisclaw.ai/en/gallery", wait_until="domcontentloaded")

        # 1. The library chunk must NOT be in the initial load. That split is what keeps a
        #    152 KB prompt library out of the path to the chat box.
        await page.wait_for_selector(".gallery-tabs", timeout=30_000)
        before = list(chunks)
        if any("LibraryPane" in c for c in before):
            failures.append("the library chunk loaded before its tab was opened")

        tab = page.get_by_role("tab", name="Prompt library")
        if await tab.count() == 0:
            print("FAIL: no 'Prompt library' tab")
            print("  tabs:", await page.eval_on_selector_all(
                ".gallery-tab", "es=>es.map(e=>e.innerText.replace(/\\n/g,' '))"))
            await browser.close()
            return 1
        label = (await tab.first.inner_text()).replace("\n", " ")
        print(f"tab: {label}")
        if str(EXPECTED_TOTAL) not in label:
            failures.append(f"the tab does not show the collection size: {label!r}")

        await tab.first.click()
        await page.wait_for_selector(".library-card", timeout=60_000)

        # 2. Opening the tab must fetch the chunk.
        if not any("LibraryPane" in c for c in chunks):
            failures.append("the library chunk never loaded, so it is not actually split")

        head = await page.inner_text(".gallery-head")
        print("head:", head.replace("\n", " | ")[:190])
        if str(EXPECTED_TOTAL) not in head:
            failures.append("the pane heading does not state how many prompts there are")
        # MIT requires the notice to travel with the work.
        if "MIT" not in head:
            failures.append("the licence is not shown")
        if "raojiacui" not in (await page.inner_html(".gallery-head")):
            failures.append("the upstream author is not credited with a link")

        cards = await page.locator(".library-card").count()
        cats = await page.locator(".library-cats .market-cat").count()
        print(f"cards: {cards}  category buttons: {cats}")
        # 9 categories + "All".
        if cats != 10:
            failures.append(f"expected 10 category buttons (9 + All), got {cats}")

        # 3. Every card must state its kind before being opened.
        kinds = await page.eval_on_selector_all(
            ".library-card .library-kind", "es=>es.map(e=>e.innerText.trim())")
        if len(kinds) != cards:
            failures.append(f"{cards - len(kinds)} cards do not state image-vs-video")
        if not {"video", "image"} & set(kinds):
            failures.append(f"kind badges are not rendering their value: {set(kinds)}")

        # 4. The category strip must filter, and the counts must be the whole-library counts
        #    rather than collapsing to the selection.
        name, expected = EXPECTED_LARGEST
        cat_btn = page.locator(".library-cats .market-cat", has_text=name).first
        if await cat_btn.count() == 0:
            failures.append(f"no category button for {name!r}")
        else:
            btn_text = (await cat_btn.inner_text()).replace("\n", " ")
            print(f"category button: {btn_text}")
            if str(expected) not in btn_text:
                failures.append(f"{name} does not show its count: {btn_text!r}")
            await cat_btn.click()
            await page.wait_for_function(
                f"() => document.querySelectorAll('.library-card').length === {expected}",
                timeout=20_000)
            still = await page.locator(".library-cats .market-cat").count()
            if still != 10:
                failures.append("the category strip collapsed after a selection")
            # Clicking the active category must clear it.
            await cat_btn.click()
            await page.wait_for_function(
                f"() => document.querySelectorAll('.library-card').length === {EXPECTED_TOTAL}",
                timeout=20_000)
            print("category filter: applied and cleared")

        # 5. Open a card: the prompt must be shown in full, with the author's parameters.
        # The kind of the card being opened, read before opening it, so the mode assertion below
        # is about this entry rather than about whichever kind happens to be first.
        expected_kind = (
            await page.locator(".library-card .library-kind").first.inner_text()
        ).strip().lower()
        print(f"opening a {expected_kind} prompt")
        await page.locator(".library-card").first.click()
        await page.wait_for_selector(".showcase-prompt", timeout=20_000)
        prompt_text = await page.inner_text(".showcase-prompt")
        print(f"opened prompt: {len(prompt_text)} chars")
        if len(prompt_text) < 60:
            failures.append(f"the opened prompt is too short to be one: {len(prompt_text)}")
        # The line structure is the craft; a single-line render means it was reflowed.
        if "\n" not in prompt_text and len(prompt_text) > 300:
            failures.append("a long prompt rendered as one line — its structure was collapsed")
        if await page.locator(".library-params").count() == 0:
            print("  note: this entry has no published parameters")

        # 6. "Make your own" must reach the composer (renamed from "Run this prompt" when this pane
        #    moved onto SeedancePane's styled action row — the old label had no CSS behind it). This is the whole point of the collection.
        run = page.get_by_role("button", name="Make your own")
        if await run.count() == 0:
            failures.append("no way to run the prompt")
        else:
            await run.first.click()
            await page.wait_for_selector("textarea", timeout=20_000)
            # Wait for the VALUE, not just the element.
            #
            # The textarea exists as soon as the chat pane mounts, so reading immediately after
            # wait_for_selector catches it before React has committed setDraft — measured 0 chars on
            # a page where the prompt had in fact arrived (3,906 chars on the Seedance pane in the
            # same conditions). A false failure here points at the button, which is the wrong place
            # to look.
            try:
                await page.wait_for_function(
                    "() => { const t = document.querySelector('textarea'); return t && t.value.trim().length > 0 }",
                    timeout=15_000,
                )
            except Exception:
                pass
            composer = await page.locator("textarea").first.input_value()
            print(f"composer received: {len(composer)} chars")
            if composer.strip() == "":
                failures.append("Make your own left the composer empty")
            elif composer.strip()[:40] not in prompt_text:
                failures.append("the composer text does not match the prompt that was opened")

            # The MODE has to arrive too, and asserting it needs the composer's own state rather
            # than the prompt's. Hard-coding 'image' in the run handler left every earlier check
            # green: the text still arrived, the dialog still closed, and a cinematic shot
            # description would have gone to the image endpoint and returned a poster of a scene.
            pressed = await page.eval_on_selector_all(
                "button[aria-pressed]",
                "es => es.filter(e => e.getAttribute('aria-pressed') === 'true')"
                "      .map(e => (e.getAttribute('aria-label') || e.title || e.innerText).trim())",
            )
            print(f"composer mode: {pressed}")
            if not any(expected_kind in p.lower() for p in pressed):
                failures.append(
                    f"the composer is not in {expected_kind} mode after running a "
                    f"{expected_kind} prompt; pressed={pressed}"
                )

        await page.screenshot(path="probe/library_pane.png", full_page=True)
        await browser.close()

    if failures:
        print("\nFAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nPASS: library splits, lists, filters, credits its source and reaches the composer")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
