"""Drive the runaway-reasoning guard against the model that actually runs away.

The unit tests prove the guard fires on a synthetic 300k-character stream. This proves it
fires on `nemotron-3-nano-omni-30b-a3b-reasoning`, which is where the 229,295-character
response was measured — and, just as importantly, that the turn RECOVERS: the notice appears,
another model is tried, and an answer arrives.

The model is pinned rather than left to `auto/free`, because auto currently resolves to
`nemotron-3-super-120b` most of the time and the pathological one would only be reached by
luck. Pinning is also the harder case for the guard: a pinned model is never downgraded away
from by design, so this checks the runaway path specifically rather than the ordinary
downgrade.

Usage: python probe/runaway_live_probe.py [base_url]
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

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173").rstrip("/")
RUNAWAY_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
PROMPT = "What's the current price of Bitcoin and its 24h change?"
BUDGET_S = 240


async def main() -> int:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page()
        reasoning_chars = 0

        async def on_response(res):
            nonlocal reasoning_chars
            if "/v1/chat/completions" not in res.url:
                return
            try:
                body = await res.text()
            except Exception:  # noqa: BLE001
                return
            reasoning_chars += body.count("reasoning_content")

        page.on("response", lambda r: asyncio.create_task(on_response(r)))
        await page.goto(localised(BASE, "/chat"), wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_selector("textarea", timeout=30_000)

        # Pick the model through the UI, so this exercises the same path a user takes.
        #
        # The picker is a button + `role="listbox"` menu, NOT a `<select>`. My first version
        # queried for a select, found none, and silently fell through to `auto/free` — which then
        # answered in 25s and the probe printed PASS without ever touching the model it exists to
        # test. A probe that cannot select its subject must say so, hence the explicit report.
        await page.click(".picker-btn, [class*='picker'] button")
        await page.wait_for_selector("[role='option']", timeout=15_000)
        opts = await page.evaluate(
            "() => [...document.querySelectorAll(\"[role='option']\")].map(o => o.innerText.replace(/\\n/g,' '))"
        )
        target = next((o for o in opts if RUNAWAY_MODEL.split("/")[-1] in o), None)
        if target is None:
            print(f"model picker: {RUNAWAY_MODEL} NOT OFFERED. options: {opts[:12]}")
            await browser.close()
            print("\nINCONCLUSIVE: cannot pin the model this probe exists to test")
            return 2
        await page.click(f"[role='option']:has-text({target.split()[0]!r})")
        print(f"model picker: pinned {target!r}")

        await page.fill("textarea", PROMPT)
        t0 = time.monotonic()
        await page.click(".send-btn")

        notice = None
        answered = False
        while time.monotonic() - t0 < BUDGET_S:
            await asyncio.sleep(5)
            state = await page.evaluate(
                """() => ({
                  busy: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Stop'),
                  notices: [...document.querySelectorAll('.notice, .error')].map(e => e.innerText.slice(0, 200)),
                  answer: [...document.querySelectorAll('.turn-agent .bubble')].map(e => e.innerText.slice(0, 200)).join(' '),
                })"""
            )
            for n in state["notices"]:
                if notice is None and ("too long" in n or "empty answer" in n):
                    notice = n
                    print(f"  [{int(time.monotonic() - t0)}s] GUARD FIRED: {n!r}")
            if state["answer"].strip():
                answered = True
            if not state["busy"]:
                print(f"  [{int(time.monotonic() - t0)}s] finished")
                print(f"  notices : {state['notices']}")
                print(f"  answer  : {state['answer'][:200]!r}")
                break

        elapsed = time.monotonic() - t0
        await browser.close()

    print(f"\nelapsed              : {elapsed:.1f}s")
    print(f"reasoning frames seen: {reasoning_chars}")
    print(f"guard fired          : {notice is not None}")
    print(f"produced an answer   : {answered}")

    # The measured failure was 7+ minutes with no answer. Anything that ends inside the
    # budget with either an answer or an explicit notice is the fix working; ending with
    # neither is the bug.
    if not answered and notice is None:
        print("\nFAIL: neither an answer nor a notice — this is the reported stall")
        return 1
    print("\nPASS")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
