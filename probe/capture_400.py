"""Capture the exact request/response that fails, rather than guessing at it.

The live probe reported a 400 while the same-looking curl succeeded, which means the
difference is in what the page actually sent. Reading it off the wire is the only way to
know; reconstructing it by hand is how you end up debugging a request nobody made.
"""

import asyncio
import json
import sys

from playwright.async_api import async_playwright

DEV_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        captured: list[dict] = []

        async def on_response(res):
            if "/chat/completions" not in res.url and "/free-models" not in res.url:
                return
            entry = {"url": res.url, "status": res.status}
            try:
                entry["body"] = (await res.text())[:600]
            except Exception as exc:  # noqa: BLE001
                entry["body"] = f"<unreadable: {exc}>"
            req = res.request
            entry["sent"] = (req.post_data or "")[:1200]
            captured.append(entry)

        page.on("response", on_response)

        await page.goto(DEV_URL, wait_until="domcontentloaded")
        await page.wait_for_selector("textarea", timeout=15_000)
        await page.fill("textarea", "hi")
        await page.click(".send-btn")
        await page.wait_for_function(
            "() => !document.querySelector('.send-btn')?.disabled", timeout=120_000
        )

        for c in captured:
            print("=" * 70)
            print(c["url"], "->", c["status"])
            if c["sent"]:
                try:
                    print("SENT:", json.dumps(json.loads(c["sent"]), indent=1)[:900])
                except Exception:  # noqa: BLE001
                    print("SENT (raw):", c["sent"][:600])
            print("GOT:", c["body"][:400])

        await browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
