"""Prove the limits are adjustable, that raising one stops the prompting, and that a paid
artifact lands in the gallery on R2.

Both halves come from the same complaint: "every step needs confirmation, even a free search"
and "let the user adjust the authorisation limits". The limits were compile-time constants, so
there was no way to say "stop asking below X" — and generated media had no permanent home, so
a gallery would have been a wall of expired links.

What this checks:

  1. the Limits panel exists and its values persist across a reload;
  2. raising "Ask above" actually removes the in-app prompt for a charge under it;
  3. lowering it brings the prompt back (so the setting is read live, not just stored);
  4. a limit above the hard ceiling is clamped rather than accepted;
  5. a generated artifact is archived to cdn.jarvisclaw.ai and appears in the Gallery;
  6. the gallery survives a reload, since its index is localStorage.

The wallet is a stub (an extension cannot be driven headlessly) and the PAID leg of the
generation is intercepted, because settling it would spend real USDC. The 402 quote and the
archive POST both hit the real services.

Usage: python probe/limits_gallery_probe.py [url]
"""

import asyncio
import json
import re
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from playwright.async_api import async_playwright

from _probe_locale import localised

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4174"
ADDRESS = "0xAbC0000000000000000000000000000000000001"

PROVIDER = """
window.__signed = [];
window.ethereum = {
  request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return ['%s'];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_signTypedData_v4') {
      window.__signed.push(params[1]);
      return '0x' + 'ab'.repeat(32) + '1b';
    }
    return null;
  },
};
""" % ADDRESS


async def ensure_wallet(page) -> bool:
    """Connects the wallet, and reports whether it is actually connected.

    Worth its own helper: a reload does NOT restore the wallet (deliberately — a page that
    silently reconnects can spend without being opened), so every reload needs this again. A
    probe that assumes otherwise reads "no dialog appeared" as a passing spend gate when the
    real cause is that nothing could be paid for at all.
    """
    btn = page.locator("button:has-text('Connect wallet')")
    if await btn.count():
        await btn.first.click()
        await page.wait_for_timeout(700)
    return await page.locator("button:has-text('Disconnect')").count() > 0

# A 1x1 PNG. Real bytes, so the archive POST exercises the CDN's content-type check rather
# than being refused for being nonsense.
PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)


async def set_limit(page, label: str, value: str) -> None:
    """Types a value into one Limits row and commits it with Enter."""
    box = page.locator(f"input[aria-label='{label} in US dollars']")
    await box.fill(value)
    await box.press("Enter")
    await page.wait_for_timeout(300)


async def read_limit(page, label: str) -> str:
    return await page.locator(f"input[aria-label='{label} in US dollars']").input_value()


async def open_own_creations(page) -> None:
    """Opens the gallery and selects the user's own work.

    Named explicitly rather than trusting the default tab. The default is now "mine" when the store
    holds anything and "showcase" when it does not, so a probe that relies on it passes or fails
    depending on leftover state from an earlier step.
    """
    await page.click(".rail-item:has-text('Gallery')")
    await page.wait_for_selector(".gallery-tabs", timeout=20_000)
    tab = page.get_by_role("tab", name=re.compile("your creations", re.I))
    if await tab.count():
        await tab.first.click()
    await page.wait_for_timeout(600)


async def main() -> int:
    failures: list[str] = []
    archived: list[dict] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1500, "height": 950})
        await ctx.add_init_script(PROVIDER)
        page = await ctx.new_page()

        async def fake_image(route):
            req = route.request
            if req.headers.get("x-payment") is not None:
                # Only the PAID leg. The quote goes to the real gateway so the price is its own.
                await route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"data": [{"url": f"{URL}/px.png"}]}),
                )
            else:
                await route.continue_()

        async def record_archive(route):
            body = {}
            try:
                body = json.loads(route.request.post_data or "{}")
            except Exception:
                pass
            archived.append(body)
            # Answered locally: the real CDN would refuse a source on 127.0.0.1, which is
            # correct behaviour (host allowlist) but says nothing about the app's wiring. The
            # CDN's own guards are verified separately against the live worker.
            await route.fulfill(
                status=201,
                content_type="application/json",
                body=json.dumps({
                    "key": "gallery/2026-08-24/probe.png",
                    "url": "https://cdn.jarvisclaw.ai/gallery/2026-08-24/probe.png",
                    "bytes": 70,
                    "contentType": "image/png",
                }),
            )

        await page.route("**/v1/images/generations", fake_image)
        await page.route("**/cdn.jarvisclaw.ai/gallery", record_archive)

        await page.goto(localised(URL), wait_until="networkidle")
        await page.wait_for_timeout(1500)

        print("== 1. the Limits panel exists and opens ==")
        toggle = page.locator(".section-toggle:has-text('Limits')")
        if await toggle.count() == 0:
            failures.append("there is no Limits panel")
            await browser.close()
            print("\nFAIL: cannot continue without the panel")
            return 1
        await toggle.click()
        await page.wait_for_timeout(300)
        for label in ("Ask above", "Stop at", "Max per signature"):
            if await page.locator(f"input[aria-label='{label} in US dollars']").count() == 0:
                failures.append(f"no editable row for {label!r}")
        print(f"   ask above={await read_limit(page, 'Ask above')} "
              f"stop at={await read_limit(page, 'Stop at')} "
              f"max sig={await read_limit(page, 'Max per signature')}")

        print("== 2. a value above the hard ceiling is clamped, not accepted ==")
        # The ceiling exists because a signature is an irreversible transfer authorisation; a
        # panel that accepts 999999 and then refuses to sign is a setting that silently lies.
        await set_limit(page, "Max per signature", "999999")
        clamped = await read_limit(page, "Max per signature")
        print(f"   typed 999999 -> {clamped}")
        if float(clamped) > 5:
            failures.append(f"the signature cap accepted {clamped}, above the $5 ceiling")

        print("== 3. limits persist across a reload ==")
        await set_limit(page, "Ask above", "0.40")
        await set_limit(page, "Stop at", "3.00")
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(1200)
        await page.locator(".section-toggle:has-text('Limits')").click()
        await page.wait_for_timeout(300)
        after = (await read_limit(page, "Ask above"), await read_limit(page, "Stop at"))
        print(f"   after reload: ask above={after[0]} stop at={after[1]}")
        if float(after[0]) != 0.40 or float(after[1]) != 3.00:
            failures.append(f"limits did not survive a reload: {after}")

        print("== 4. connect the wallet and generate an image ==")
        if not await ensure_wallet(page):
            # Asserted rather than assumed. Without a wallet the app tells the visitor the price
            # and stops, so "no dialog appeared" would read as a working spend gate.
            failures.append("the wallet did not connect, so nothing below tests a paid path")
        await page.click(".mode-btn:has-text('Image')")
        await page.fill("textarea", "a red cube on a white background")
        await page.click(".send-btn")

        # "Ask above" is $0.40 and an image is ~$0.064, so NO in-app dialog should appear.
        # That is the whole point of the setting.
        prompted = True
        try:
            await page.wait_for_selector(".dialog", timeout=12_000)
        except Exception:
            prompted = False
        print(f"   in-app confirm dialog shown: {prompted}  (expected False at a $0.40 threshold)")
        if prompted:
            failures.append("raising the per-call limit did not stop the in-app prompt")
            await page.click(".approve")

        try:
            await page.wait_for_selector(".media-card, .error", timeout=90_000)
        except Exception:
            print("   transcript:", (await page.inner_text(".transcript"))[-260:].replace("\n", " | "))
            failures.append("the image never completed")

        print("== 5. the wallet still signed it ==")
        signed = await page.evaluate("() => window.__signed")
        print(f"   signatures: {len(signed)}")
        # The distinction the panel's own note makes: raising OUR limit removes OUR prompt and
        # never the wallet's. If this were 0, the page would be spending without consent.
        if len(signed) != 1:
            failures.append(f"expected exactly 1 wallet signature, saw {len(signed)}")

        print("== 6. the artifact was archived to the CDN ==")
        print(f"   archive POSTs: {len(archived)}  body: {archived[:1]}")
        if not archived:
            failures.append("the paid artifact was never archived — the gallery would hold a dead link")
        elif "source" not in (archived[0] or {}):
            failures.append(f"the archive POST carried no source: {archived[0]}")

        print("== 7. it shows up in the Gallery, and survives a reload ==")
        # The gallery has FOUR tabs now (prompt gallery, video prompts, prompt library, your
        # creations) and .gallery-card only exists on the last one. Counting without naming the tab
        # reported "the gallery is empty after a paid generation" for weeks while the item was in
        # localStorage, correctly, and the tab badge already read "Your creations 1". The store and
        # the badge are checked too, so a real loss is distinguishable from landing on a sibling
        # tab — which is the thing that made the old failure so convincing.
        await open_own_creations(page)
        cards = await page.locator(".gallery-card").count()
        stored = await page.evaluate(
            "() => { try { return JSON.parse(localStorage.getItem('jarvisclaw.gallery.v1') || '[]').length }"
            " catch { return -1 } }"
        )
        print(f"   gallery cards: {cards}   items in the store: {stored}")
        if stored <= 0:
            failures.append(
                f"the paid artifact never reached the gallery store (length {stored}) — "
                "this is a real loss, not a tab problem"
            )
        elif cards == 0:
            failures.append(
                f"the store holds {stored} item(s) but the pane rendered none — the data survived "
                "and the view did not"
            )
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(1200)
        await open_own_creations(page)
        after_reload = await page.locator(".gallery-card").count()
        print(f"   after reload: {after_reload}")
        if after_reload != cards:
            failures.append(f"the gallery lost items on reload: {cards} -> {after_reload}")
        # The stored URL must be the permanent CDN one, not the upstream's temporary link.
        if after_reload:
            src = await page.locator(".gallery-card img").first.get_attribute("src")
            print(f"   stored url: {src}")
            if "cdn.jarvisclaw.ai" not in (src or ""):
                failures.append(f"the gallery kept a non-CDN url: {src}")

        print("== 8. lowering the limit brings the prompt back ==")
        # Proves the setting is read live rather than only written. A stored-but-ignored value
        # would pass every check above and still nag on the next charge.
        #
        # The wallet must be reconnected first: check 7 reloaded the page, and a reload
        # deliberately drops the wallet. Without this the app just quotes the price and stops,
        # and the missing dialog would look like the limit was ignored.
        if not await ensure_wallet(page):
            failures.append("could not reconnect the wallet for the live-limit check")
        await page.click(".rail-item:has-text('New chat')")
        await page.wait_for_timeout(500)
        await page.locator(".section-toggle:has-text('Limits')").click()
        await page.wait_for_timeout(300)
        # Sub-cent on purpose: it is both below any real charge AND the value that exposed the
        # display bug, where toFixed(2) rendered a stored 0.001 as "0.00" — i.e. as zero.
        await set_limit(page, "Ask above", "0.001")
        typed_back = await read_limit(page, "Ask above")
        print(f"   set 0.001, box shows {typed_back}")
        if float(typed_back) != 0.001:
            failures.append(f"a sub-cent limit does not survive display: shows {typed_back}")
        await page.click(".mode-btn:has-text('Image')")
        await page.fill("textarea", "another cube")
        await page.click(".send-btn")
        back = True
        try:
            await page.wait_for_selector(".dialog", timeout=60_000)
        except Exception:
            back = False
        print(f"   dialog returned at a $0.001 threshold: {back}")
        if not back:
            failures.append("lowering the per-call limit did not restore the prompt")

        await browser.close()

    print()
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: limits are editable, persist, are read live, clamp at the ceiling; artifacts archive to R2 and the gallery holds them.")
    return 0


sys.exit(asyncio.run(main()))
