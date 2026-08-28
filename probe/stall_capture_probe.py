"""Capture what the gateway answered when the page then stalled indefinitely.

The attribution probe found the shape but not the cause: one chat completion, finished in
1.1s, and then 419 seconds of nothing. A 1.1s completion is not inference — it is an error,
or an empty stream. The page shows no error, so whatever came back left the agent loop with
nothing to do and nothing to say.

This records the status and body of every chat completion, plus the console, so the failure
is described by the response rather than inferred from the silence.
"""

import asyncio
import sys
import time

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from playwright.async_api import async_playwright

from _probe_locale import localised

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://ducat.jarvisclaw.ai").rstrip("/")
PROMPT = sys.argv[2] if len(sys.argv) > 2 else "What's the current price of Bitcoin?"
WAIT_S = 90


async def main() -> int:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page()

        async def on_response(res):
            if "/v1/chat/completions" not in res.url:
                return
            try:
                body = await res.text()
            except Exception as exc:  # noqa: BLE001
                body = f"<unreadable: {exc}>"
            print(f"\n--- chat completion: HTTP {res.status} ---")
            print(f"headers: content-type={res.headers.get('content-type')!r}")
            print(f"body ({len(body)} chars):\n{body[:1500]}")

        page.on("response", lambda r: asyncio.create_task(on_response(r)))
        page.on("console", lambda m: print(f"console[{m.type}] {m.text[:300]}"))
        page.on("pageerror", lambda e: print(f"PAGEERROR {e}"))
        page.on(
            "requestfailed",
            lambda r: print(f"REQFAILED {r.url[:100]} {r.failure}")
            if "/v1/" in r.url or "/api/" in r.url
            else None,
        )

        await page.goto(localised(BASE, "/chat"), wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_selector("textarea", timeout=30_000)
        await page.fill("textarea", PROMPT)
        await page.click(".send-btn")

        t0 = time.monotonic()
        while time.monotonic() - t0 < WAIT_S:
            await asyncio.sleep(5)
            state = await page.evaluate(
                """() => ({
                  busy: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Stop'),
                  bubbles: [...document.querySelectorAll('.turn-agent .bubble')].map(b => b.innerText.slice(0, 120)),
                  reasoning: [...document.querySelectorAll('.reasoning, .reasoning-tail')].map(b => b.innerText.slice(0, 100)),
                  tools: [...document.querySelectorAll('.tool-row')].map(b => b.innerText.replace(/\\n/g, ' ')),
                  errors: [...document.querySelectorAll('.turn-error, .turn-notice')].map(b => b.innerText.slice(0, 200)),
                })"""
            )
            print(f"\n[{int(time.monotonic() - t0)}s] {state}")
            if not state["busy"]:
                print("\n(idle — turn finished)")
                break

        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
