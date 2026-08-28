"""Verify the marketplace opens on the curated tier, and that all of it stays reachable.

The reported problem was not a bug: the raw 2,720-row listing is real and works. It is what a
first visit MEETS — duplicates on page one, endpoints under categories that make no sense — and
a developer who browses that reads auto-generated bulk and stops trusting the catalogue.

Unit tests cover the selection rules and the client's parsing. They cannot show that the page
opens on the curated tier, that the toggle switches tiers and refetches, that the counts name
the other tier honestly, or that a search finding nothing offers the whole catalogue instead of
claiming the platform has nothing.

Stubbed rather than live: the point is the RENDERING of two known tiers. A live gateway would
also work, but it cannot be made to return a specific tier size on demand, and a probe that
cannot control its input cannot verify its output.

Usage: python probe/curated_tier_probe.py
"""

import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from playwright.async_api import async_playwright

from _probe_locale import localised

# The measured live figures, so the probe asserts against the real shape of the problem.
CURATED_TOTAL = 186
COMPLETE_TOTAL = 2720

MIME = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
    ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
}


async def route_local(route):
    """Serves dist/ for the canonical origin, so the page runs at the host the app expects."""
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


def row(i: int, category: str) -> dict:
    return {
        "resource_id": 1000 + i,
        "name": f"{category.title()} Endpoint {i:02d}",
        "description": "Returns a structured result for the requested input, documented upstream.",
        "category": category,
        "display_price": 0.0115,
        "method": "GET",
    }


async def main() -> int:
    requests: list[dict] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        # Wide, so the grid and the header controls are all on screen.
        page = await (await browser.new_context(viewport={"width": 1600, "height": 1200})).new_page()

        async def on_apis(route):
            q = parse_qs(urlparse(route.request.url).query)
            curated = q.get("curated", ["0"])[0] in ("1", "true", "yes", "on")
            search = q.get("q", [""])[0]
            # page_size distinguishes the two callers. App.tsx also calls listApis with
            # pageSize=1 purely to render a headline number, and it does NOT ask for curation —
            # correctly, since that number describes the whole catalogue. Keying the assertion
            # on arrival order let a mutation that flipped the marketplace's default to the
            # complete listing pass, because the counter's request happened to land first.
            requests.append({
                "curated": curated,
                "q": search,
                "page_size": q.get("page_size", ["?"])[0],
            })

            # A search that only the complete listing can satisfy: this is how an endpoint gets
            # missed if the curated empty state does not offer a way out.
            if search and curated:
                items, total = [], 0
            elif search:
                items, total = [row(1, "search")], 1
            elif curated:
                items = [row(i, "search") for i in range(12)]
                total = CURATED_TOTAL
            else:
                items = [row(i, "general") for i in range(24)]
                total = COMPLETE_TOTAL

            await route.fulfill(status=200, json={"success": True, "data": {
                "items": items,
                "total": total,
                "categories": [{"category": "search", "count": 12}],
                "curated": curated,
                "curated_total": CURATED_TOTAL,
                "complete_total": COMPLETE_TOTAL,
            }})

        await page.route("**/api/marketplace/apis**", on_apis)
        await page.route("**/api/marketplace/pricing**", lambda r: r.fulfill(
            status=200, json={"success": True, "data": []}))
        await page.route("**/api/discovery/models**", lambda r: r.fulfill(
            status=200, json={"free": []}))
        await page.route("https://ducat.jarvisclaw.ai/**", route_local)
        await page.goto(localised("https://ducat.jarvisclaw.ai", "/marketplace"), wait_until="domcontentloaded")

        failures: list[str] = []

        # 1. The FIRST request must ask for the curated tier. This is the whole fix: not that
        #    curation is available, but that it is what a first visit gets.
        try:
            await page.wait_for_function("() => document.querySelectorAll('.market-card').length > 0",
                                         timeout=30_000)
        except Exception:
            print("FAIL: no cards rendered")
            print("  requests:", requests)
            await page.screenshot(path="probe/curated_fail.png", full_page=True)
            await browser.close()
            return 1

        head = await page.inner_text(".market-head")
        listing = [r for r in requests if r["page_size"] != "1"]
        if not listing:
            failures.append(f"the marketplace made no listing request: {requests}")
        elif not listing[0]["curated"]:
            failures.append(
                f"the marketplace's first listing request did not ask for curation: {listing[0]}"
            )

        # And the page must SAY it is curated. The request is the intent; this is the result, and
        # a mutation could satisfy one without the other.
        if "picks" not in head:
            failures.append(f"the marketplace did not open on the curated tier: {head!r}")

        head = await page.inner_text(".market-head")
        print("header:", head.replace("\n", " | ")[:200])

        # 2. The subtitle must describe the tier on screen. Leading with 2,720 while showing a
        #    curated few hundred makes the raw size the headline, which is what the report said
        #    not to do.
        if str(COMPLETE_TOTAL) in head.replace(",", "") and "Show all" not in head:
            failures.append("the curated header leads with the complete-catalogue size")

        # The tier's REAL size, not the sum of the per-category facet. The facet is capped per
        # category in the curated tier, so summing it read "12 picks" for a 186-row listing —
        # caught here, not by any unit test.
        if f"{CURATED_TOTAL} picks" not in head:
            failures.append(f"the header does not state the curated tier's real size: {head!r}")

        # Singular/plural. The stub returns one category, which is where "1 categories" showed.
        if "1 categories" in head:
            failures.append("the header says '1 categories'")

        # Everything below drives the toggle and the search, and both assume the page opened
        # curated. If it did not, that is already recorded above — continuing would raise on a
        # wait that can never succeed, and a traceback is not a test result.
        if failures:
            print()
            print("FAIL")
            for f in failures:
                print(f"  - {f}")
            await page.screenshot(path="probe/curated_fail.png", full_page=True)
            await browser.close()
            return 1

        # 3. The toggle must name the other tier with its real size.
        tier = page.locator(".market-tier")
        if await tier.count() == 0:
            failures.append("no way out of the curated tier is offered")
        else:
            label = await tier.first.inner_text()
            print("toggle:", label)
            if "2,720" not in label:
                failures.append(f"the toggle does not name the complete size: {label!r}")

            # 4. Clicking it must refetch WITHOUT the flag and relabel.
            before = len(requests)
            await tier.first.click()
            await page.wait_for_function(
                f"() => document.querySelectorAll('.market-card').length === 24", timeout=30_000)
            if len(requests) <= before:
                failures.append("the toggle did not refetch")
            elif requests[-1]["curated"]:
                failures.append("the toggle refetched but still asked for curation")
            back = await page.locator(".market-tier").first.inner_text()
            print("toggle after:", back)
            if "186" not in back:
                failures.append(f"no way back to the curated tier: {back!r}")

            # Return to curated for the search check below.
            await page.locator(".market-tier").first.click()
            await page.wait_for_function(
                "() => document.querySelectorAll('.market-card').length === 12", timeout=30_000)

        # 5. A search the curated tier cannot satisfy must offer the whole catalogue, not claim
        #    the platform has nothing. "Nothing matches" would be a false statement.
        box = page.locator(".market-search")
        await box.fill("obscure endpoint")
        await page.wait_for_function(
            "() => document.querySelector('.market-note') !== null "
            "&& document.querySelectorAll('.market-card').length === 0",
            timeout=30_000,
        )
        note = await page.inner_text(".market-note")
        print("empty state:", note.replace("\n", " ")[:160])
        if "curated" not in note.lower():
            failures.append(f"the empty state does not say the search was narrowed: {note!r}")
        escape = page.locator(".market-note .link-btn")
        if await escape.count() == 0:
            failures.append("the empty state offers no way to search the whole catalogue")
        else:
            before = len(requests)
            await escape.first.click()
            await page.wait_for_function(
                "() => document.querySelectorAll('.market-card').length === 1", timeout=30_000)
            if requests[-1]["curated"] or len(requests) <= before:
                failures.append("the escape hatch did not research the complete listing")
            else:
                print("escape hatch found the endpoint the curated tier had hidden")

        await page.screenshot(path="probe/curated_tier.png", full_page=True)
        await browser.close()

    print(f"\nrequests made: {json.dumps(requests)}")
    if failures:
        print("\nFAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nPASS: opens curated, both tiers reachable and honestly counted")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
