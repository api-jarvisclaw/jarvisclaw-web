"""Verify what a turn's tool rows look like in a real browser, against the built bundle.

The reported reading was "11+ consecutive search_apis calls in ~60s, all free" — a transcript
that looks like thrashing. The separate question raised was whether the call-API process
should be shown to the user at all.

The decision under test: catalogue lookups collapse to one summary line, and anything that
moved money — or refused to — keeps its own row. A unit test can assert the partition
function; it cannot show that the collapsed row actually renders, that the paid row survives
next to it, or that expanding the summary reveals what was hidden. This drives the real
bundle with a stubbed gateway so the tool sequence is exactly the reported one.

Stubbed rather than live because the point is the RENDERING of a known sequence. A live free
model chooses its own tools, so a live run cannot produce the reported 11-lookup turn on
demand, and a probe that cannot reproduce the input cannot verify the output.

Usage:
  python probe/serve_dist.py 4173 &
  python probe/tool_noise_probe.py [base_url]
"""

import asyncio
import json
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from playwright.async_api import async_playwright

from _probe_locale import localised

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173").rstrip("/")

# Eleven lookups then one paid call: the reported shape, plus the paid step the report never
# reached. Two of the lookups carry different queries so the turn is not trivially dedupable.
LOOKUP_QUERIES = [
    "wallet risk screening",
    "address risk",
    "eth price",
    "ethereum current price",
    "24h change",
    "usdc yield pools",
    "defi yield",
    "top pools usdc",
    "stablecoin yield",
    "pool apy",
    "yield aggregator",
]


def sse(chunks: list[dict]) -> str:
    body = "".join("data: " + json.dumps(c) + "\n\n" for c in chunks)
    return body + "data: [DONE]\n\n"


def tool_turn(calls: list[dict]) -> str:
    """One assistant turn that asks for the given tool calls."""
    deltas = []
    for i, c in enumerate(calls):
        deltas.append(
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": i,
                                    "id": f"call_{i}",
                                    "type": "function",
                                    "function": {
                                        "name": c["name"],
                                        "arguments": json.dumps(c["args"]),
                                    },
                                }
                            ]
                        }
                    }
                ]
            }
        )
    return sse(deltas)


ANSWER = sse(
    [
        {"choices": [{"delta": {"content": "ETH is $2,431.08, down 1.2% over 24h."}}]},
    ]
)


MIME = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
    ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
}


async def route_local(route):
    """Serves dist/ for the canonical origin, so the page runs at the host the app expects.

    Needed because the session check is gated on window.location.origin: on 127.0.0.1
    whoami() returns null WITHOUT a request, no key can be selected, and the paid path is
    unreachable. Any unknown path falls back to index.html — the SPA rule the Worker applies.
    """
    from pathlib import Path
    from urllib.parse import urlparse

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
    turn = {"n": 0}

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        # 1600 wide deliberately: .sidebar is display:none under 820px and the account panel
        # lives in it, so a narrow viewport makes the key unselectable and the paid path
        # unreachable — which looks like a broken paid row rather than a hidden control.
        page = await (await browser.new_context(viewport={"width": 1600, "height": 1000})).new_page()

        async def on_chat(route):
            """First completion asks for every tool; the second writes the answer."""
            turn["n"] += 1
            if turn["n"] == 1:
                # The lookups, as their own turn.
                body = tool_turn(
                    [{"name": "search_apis", "args": {"query": q}} for q in LOOKUP_QUERIES]
                )
            elif turn["n"] == 2:
                # The paid call, in a SEPARATE turn — which is how a model actually works, and
                # it matters here: batched into one turn with the eleven lookups, the paid call
                # rendered `call_api free`. That looked like the price being lost and is instead
                # an artefact of a sequence no model produces.
                #
                # `id` (a number) and `payload`, per the tool schema. `service_id` lands in the
                # "call_api needs a numeric id" branch, which also renders as free.
                body = tool_turn([{"name": "call_api", "args": {"id": 441, "payload": {}}}])
            else:
                body = ANSWER
            await route.fulfill(
                status=200,
                headers={"content-type": "text/event-stream", "cache-control": "no-cache"},
                body=body,
            )

        async def on_search(route):
            await route.fulfill(
                status=200,
                json={
                    "items": [
                        {
                            "service_id": "federation/441",
                            "name": "Hn Search",
                            "description": "Search Hacker News.",
                            "display_price": 0.00115,
                            "price_unit": "call",
                            "category": "search",
                            "method": "GET",
                        }
                    ]
                },
            )

        # The paid call. 402-free: the probe is about the transcript row, not the payment
        # handshake, and a real 402 would need a funded wallet in a headless browser.
        async def on_invoke(route):
            await route.fulfill(
                status=200,
                json={"success": True, "data": {"price": 2431.08, "change_24h": -1.2},
                      "cost_usd": 0.00115},
            )

        # A connected session. The anonymous branch of call_api never reaches the paid path —
        # it returns "NOT CALLED — no payment method" — so a probe about a PAID row has to
        # sign in. These are the three endpoints AccountPanel uses.
        await page.route("**/api/user/session**", lambda r: r.fulfill(
            status=200, json={"success": True, "data": {"id": 34}}))
        await page.route("**/api/user/self**", lambda r: r.fulfill(
            status=200, json={"success": True, "data": {"id": 34, "username": "probe"}}))
        await page.route("**/api/token/?**", lambda r: r.fulfill(
            # A paginated envelope — data.items, not a bare array. listKeys reads data.items and
            # a bare array yields zero keys, which renders as "this account has no API keys".
            status=200, json={"success": True, "data": {
                "items": [{"id": 1, "name": "probe-key", "status": 1}]}}))
        await page.route("**/api/token/1/key**", lambda r: r.fulfill(
            # data.key, not a bare data string: revealKey reads data.key and otherwise raises
            # "the platform returned no key", leaving the session anonymous — which renders as
            # "not called — needs payment" and looks like the paid row being wrong.
            status=200, json={"success": True, "data": {"key": "probe-not-a-real-key"}}))

        await page.route("**/v1/chat/completions", on_chat)
        # The search glob FIRST, the specific one after it. Playwright matches routes in
        # reverse registration order — last registered wins — so "**/api/marketplace/apis**",
        # which also matches "/api/marketplace/apis/441", has to be registered before the
        # narrower pattern or it swallows the detail request. It did, and the search response
        # carries no display_price, so the price came back 0 and the row rendered `free`.
        await page.route("**/api/marketplace/apis**", on_search)
        # The price comes from the single-resource detail endpoint, not from the search result:
        # call_api looks it up so the number shown to the user is the number the gateway will
        # charge.
        await page.route("**/api/marketplace/apis/441**", lambda r: r.fulfill(
            status=200, json={"success": True, "data": {
                "service_id": "federation/441", "name": "Hn Search",
                "display_price": 0.00115, "price_unit": "call", "method": "GET"}}))
        # The actual call is POST /v1/marketplace/api/{id}, not /api/marketplace/invoke.
        # A stub on the wrong path leaves the real request unrouted; it 401s, the tool throws,
        # and the row renders `free` — which reads as the price being lost rather than the
        # call never having happened.
        await page.route("**/v1/marketplace/api/441**", on_invoke)
        await page.route("**/api/discovery/models**", lambda r: r.fulfill(
            status=200, json={"free": [{"model": "stub/free", "pricing_type": "free"}]}))

        # Served under the canonical origin, not 127.0.0.1: the session check is gated on
        # window.location.origin (CREDENTIALED_ORIGINS), so on any other host whoami() returns
        # null without a request and no key can be selected. Fulfilled from the LOCAL bundle so
        # what runs is the build under test.
        await page.route("https://ducat.jarvisclaw.ai/**", route_local)
        await page.goto(localised("https://ducat.jarvisclaw.ai", "/chat"), wait_until="domcontentloaded")

        # Select the key through the real UI rather than reaching into React state: the paid
        # path reads `apiKey`, and setting it any other way would test a state shape instead
        # of the flow a user goes through.
        key_btn = page.get_by_text("probe-key", exact=False).first
        try:
            await key_btn.wait_for(state="visible", timeout=20_000)
            await key_btn.click()
        except Exception:
            print("NOTE: could not select the key in the UI; the paid row will not be reachable")

        # The charge dialog is modal and blocks the tool call until answered.
        async def approve_charges():
            while True:
                try:
                    btn = page.locator("button.approve").first
                    await btn.wait_for(state="visible", timeout=115_000)
                    await btn.click()
                except Exception:
                    return

        approver = asyncio.create_task(approve_charges())

        composer = page.locator("textarea, input[type=text]").first
        await composer.wait_for(state="visible", timeout=30_000)
        await composer.fill("ETH price and 24h change")
        await composer.press("Enter")

        # Wait for the answer, which is the signal that the turn finished rendering.
        try:
            await page.wait_for_function(
                "() => [...document.querySelectorAll('.turn-agent .bubble')]"
                ".some(b => b.innerText.includes('2,431'))",
                timeout=120_000,
            )
        except Exception:
            print("FAIL: no answer rendered")
            print("  tool rows:", [await r.inner_text() for r in await page.query_selector_all(".tool-row")])
            await page.screenshot(path="probe/tool_noise_fail.png", full_page=True)
            await browser.close()
            return 1

        rows = [(await r.inner_text()).replace("\n", " ") for r in await page.query_selector_all(".tool-row")]
        summaries = [
            (await s.inner_text()).replace("\n", " ")
            for s in await page.query_selector_all(".tool-plumbing > summary")
        ]

        print(f"visible .tool-row       : {len(rows)}")
        for r in rows:
            print(f"   {r}")
        print(f"collapsed summaries     : {summaries}")

        failures: list[str] = []

        # 1. The eleven lookups must not each own a row.
        lookup_rows = [r for r in rows if "search_apis" in r]
        if lookup_rows:
            failures.append(
                f"{len(lookup_rows)} search_apis rows still visible; expected them collapsed"
            )

        # 2. The summary must state how many were collapsed, so nothing is silently dropped.
        if not summaries:
            failures.append("no collapsed summary rendered")
        elif "11" not in summaries[0]:
            failures.append(f"summary does not report the count: {summaries[0]!r}")

        # 3. The paid call keeps its own row WITH its price. This is the product's claim and
        #    a charge the user is entitled to see.
        #
        #    Asserted on the WHOLE visible transcript, not on the presence of a call_api row.
        #    The paid call arrives in its own turn, so adding call_api to the plumbing set
        #    collapsed it into that turn's own summary — leaving zero call_api rows and a
        #    first-turn summary that still read "11x". Both earlier checks passed and the
        #    probe reported PASS with the charge hidden.
        paid = [r for r in rows if "call_api" in r]
        if not paid:
            failures.append("the paid call_api row is missing — a charge was hidden")
        elif "0.001150" not in " ".join(paid):
            failures.append(f"paid row does not show the amount: {paid!r}")

        visible = await page.inner_text(".transcript")
        if "0.001150" not in visible:
            failures.append(
                "the amount $0.001150 appears nowhere in the visible transcript — "
                "a charge the user is entitled to see was collapsed out of sight"
            )
        # Every collapsed summary must be about the catalogue. A summary standing in for a paid
        # call is the failure this catches.
        for sm in summaries:
            if "catalogue" not in sm.lower():
                failures.append(f"a non-catalogue step was collapsed into a summary: {sm!r}")

        # 4. Expanding the summary must reveal the hidden rows: collapsed, not withheld.
        if summaries:
            await page.locator(".tool-plumbing > summary").first.click()
            await page.wait_for_timeout(150)
            after = [
                (await r.inner_text()).replace("\n", " ")
                for r in await page.query_selector_all(".tool-row")
            ]
            revealed = [r for r in after if "search_apis" in r]
            print(f"after expanding         : {len(revealed)} search_apis rows")
            if len(revealed) != 11:
                failures.append(
                    f"expanding revealed {len(revealed)} lookups, expected 11"
                )

        await page.screenshot(path="probe/tool_noise.png", full_page=True)
        await browser.close()

    if failures:
        print("\nFAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nPASS: lookups collapsed to one line, the charge stayed visible, nothing withheld")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
