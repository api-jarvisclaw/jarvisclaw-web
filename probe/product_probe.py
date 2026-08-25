"""Drive the whole console in a real browser: history, picker, marketplace, modes.

Separate from live_probe.py, which answers "does a chat reach the gateway". This one
answers "is this a product": can a visitor find their earlier conversations, choose a
model out of 300+, browse what the marketplace sells, and see a price before spending.

Unstubbed on purpose — the model list and the marketplace catalogue both come from the
live gateway, and a stub would prove the components render while telling us nothing about
whether those documents parse.

Usage: python probe/product_probe.py [url]
"""

import asyncio
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4188"

# Cloudflare injects an analytics beacon that our own CSP refuses. That refusal is the
# policy working; counting it would fail every run against production.
# "status of 401" is the session check answering for a visitor who is not signed in — the
# correct response, which the browser still logs as an error. It only surfaces as a plain 401
# because the gateway now sends CORS headers on it (api-server#530); before that it appeared as
# a CORS failure, which WAS a defect.
IGNORABLE = (
    "favicon",
    "err_quic",
    "err_network_changed",
    "err_connection_reset",
    "cloudflareinsights",
    "status of 401",
)


async def main() -> int:
    failures: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1500, "height": 950})
        page = await ctx.new_page()

        console_errors: list[str] = []
        page.on("console", lambda m: m.type == "error" and console_errors.append(m.text[:170]))

        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(2500)

        print("== 1. the rail lists navigation and history ==")
        rail_items = [t.strip() for t in await page.locator(".rail-item").all_inner_texts()]
        print(f"   {rail_items}")
        for expected in ("New chat", "Search chats", "Marketplace", "Install CLI"):
            if not any(expected in t for t in rail_items):
                failures.append(f"the rail is missing '{expected}'")

        print("== 2. the model picker is populated from the live catalogue ==")
        await page.click(".picker-trigger")
        await page.wait_for_selector(".picker-row", timeout=30_000)
        rows = await page.locator(".picker-row").count()
        placeholder = await page.get_attribute(".picker-search", "placeholder")
        print(f"   rows visible: {rows} | search says: {placeholder!r}")
        if rows < 10:
            failures.append(f"only {rows} models in the picker — the catalogue did not load")
        # "search N models" proves the count came from the gateway rather than a default.
        if placeholder and "loading" in placeholder:
            failures.append("the picker still says loading after the catalogue should have arrived")

        print("== 3. free models are grouped first ==")
        first_prices = [t.strip() for t in await page.locator(".picker-row-price").all_inner_texts()][:5]
        print(f"   first prices: {first_prices}")
        if "free" not in first_prices:
            failures.append("no free model in the first rows — the free tier is not surfaced")

        print("== 4. modality filtering works ==")
        await page.click(".picker-tab:has-text('video')")
        await page.wait_for_timeout(500)
        video_names = [t.strip() for t in await page.locator(".picker-row-name").all_inner_texts()]
        print(f"   video models: {video_names[:4]} ({len(video_names)} total)")
        if len(video_names) == 0:
            failures.append("the video filter shows nothing — modality inference is wrong")
        stray = [n for n in video_names if not any(k in n.lower() for k in ("video", "seedance", "sora", "veo", "kling", "wan"))]
        if stray:
            failures.append(f"non-video models under the video filter: {stray[:3]}")
        await page.keyboard.press("Escape")

        print("== 5. the mode buttons are present and toggle ==")
        modes = [t.strip() for t in await page.locator(".mode-btn").all_inner_texts()]
        print(f"   {modes}")
        for expected in ("Image", "Video", "Music"):
            if not any(expected in m for m in modes):
                failures.append(f"no {expected} mode button")
        await page.click(".mode-btn:has-text('Video')")
        await page.wait_for_timeout(300)
        hint = (await page.locator(".hint").inner_text()).strip()
        print(f"   hint after selecting Video: {hint[:90]!r}")
        if "video" not in hint.lower():
            failures.append("selecting Video did not change the composer hint")
        # Toggling back must be possible, or there is no way to return to chat.
        await page.click(".mode-btn-active")
        await page.wait_for_timeout(300)
        if await page.locator(".mode-btn-active").count() != 0:
            failures.append("a selected mode cannot be switched off")

        print("== 6. the marketplace loads real services ==")
        await page.click(".rail-item:has-text('Marketplace')")
        await page.wait_for_selector(".market-card", timeout=60_000)
        cards = await page.locator(".market-card h2").all_inner_texts()
        head = (await page.locator(".market-head p").inner_text()).strip()
        print(f"   {len(cards)} services, e.g. {[c.strip() for c in cards[:5]]}")
        print(f"   {head[:100]}")
        if len(cards) < 3:
            failures.append(f"only {len(cards)} marketplace services — the catalogue did not parse")
        if "endpoint" not in head:
            failures.append("the marketplace header does not report an endpoint count")

        print("== 7. a conversation is saved and reopenable ==")
        await page.click(".rail-item:has-text('New chat')")
        await page.wait_for_selector("textarea", timeout=15_000)
        await page.fill("textarea", "Reply with exactly PROBE_OK and nothing else.")
        await page.click(".send-btn")
        # Waits for the run to end: the Stop button exists only while one is in flight.
        for _ in range(120):
            await page.wait_for_timeout(1000)
            if await page.locator(".ghost-btn:has-text('Stop')").count() == 0:
                break
        rows_before = await page.locator(".rail-row").count()
        print(f"   conversations in the rail: {rows_before}")
        if rows_before == 0:
            failures.append("the conversation was not saved to the rail")
        else:
            title = (await page.locator(".rail-row-title").first.inner_text()).strip()
            print(f"   title: {title!r}")
            if "PROBE_OK" not in title:
                failures.append(f"the conversation is titled {title!r}, not after the user's message")

        print("== 8. it survives a reload ==")
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(2000)
        rows_after = await page.locator(".rail-row").count()
        print(f"   after reload: {rows_after}")
        if rows_after < rows_before:
            failures.append("conversations were lost on reload — persistence is broken")
        if rows_after:
            await page.click(".rail-row-open")
            await page.wait_for_timeout(1200)
            restored = await page.locator(".turn-user .bubble").count()
            print(f"   reopened, user turns restored: {restored}")
            if restored == 0:
                failures.append("reopening a conversation restored no transcript")

        print("== 9. no console errors of our own ==")
        real = [e for e in console_errors if not any(i in e.lower() for i in IGNORABLE)]
        for e in real[:5]:
            print(f"   {e}")
        if real:
            failures.append(f"{len(real)} console error(s)")

        print("== 10. no horizontal overflow at either size ==")
        for w, h in ((1500, 950), (390, 844)):
            await page.set_viewport_size({"width": w, "height": h})
            await page.wait_for_timeout(600)
            over = await page.evaluate(
                "() => document.documentElement.scrollWidth > document.documentElement.clientWidth"
            )
            print(f"   {w}x{h}: overflow={over}")
            if over:
                failures.append(f"horizontal overflow at {w}px")

        await browser.close()

    print()
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: history, picker, modes, marketplace and persistence all work live.")
    return 0


sys.exit(asyncio.run(main()))
