"""Reproduce the reported `search_apis` non-convergence on multi-intent prompts.

The report: a three-part request ("screen this wallet, get ETH price, show top 3 USDC
pools") produced 11+ consecutive `search_apis` calls in ~60s, never selected an endpoint,
never answered, and sat on "Thinking" until stopped manually.

That should already be impossible. `runAgent` keys a `seen` map on tool+normalised-args and
answers a repeat from cache, and the deployed bundle contains that code (verified: the
string "identical call you already made" is in the live JS). So the interesting question is
not "does the cap exist" but "what does the model vary so the cap never fires" — a reworded
query is a DIFFERENT key, and the dedup only catches near-identical arguments.

So this probe records every tool call WITH its arguments, which the earlier probes did not.
The distinction matters: 11 identical calls is a broken guard, 11 differently-worded calls
is a guard that cannot see them.

Usage: python probe/multi_intent_probe.py [base_url]
"""

import asyncio
import json
import re
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

# Deliberately longer than the report's 60s manual stop. The report says "never returned",
# but a 60s abort cannot distinguish "never" from "slower than 60s" — and measured free-pool
# latency has a tail past 30s per turn, so a 6-turn run can legitimately exceed a minute.
ANSWER_TIMEOUT_MS = 300_000

CASES = [
    {
        # The report's own prompt, verbatim apart from the truncated address, which is
        # filled in with a real one so a search that DOES converge has something to send.
        "name": "three-part",
        "prompt": (
            "Screen this wallet 0x28C6c06298d514Db089934071355E5743bf21d60 for risk, "
            "get ETH's current price and 24h change, and show the top 3 USDC DeFi yield pools."
        ),
        # The catalogue has all three (address screen, token price, defi pools). An
        # anonymous session cannot call them, so the correct outcome is: search, then
        # report what exists and what it costs. Three searches is defensible — one per
        # intent. Eleven is the defect.
        #
        # Counted on NETWORK requests, not on tool rows — see `max_tools` handling below. A
        # `call_api` that the loop refuses without dialling out renders as a row and costs
        # nothing, and my first version failed a healthy run on three of those.
        "max_tools": 4,
    },
    {
        # The report's Issue 2 prompt. Single intent, so one search is the ceiling.
        "name": "single-intent",
        "prompt": "What's the current price of Bitcoin and its 24h change?",
        "max_tools": 2,
    },
]


async def run_case(browser, case: dict) -> dict:
    page = await browser.new_page()
    calls: list[dict] = []
    # Recorded from the network rather than the DOM. The tool rows show a name and a price;
    # they do NOT show the query, and the query is the whole question here.
    page.on(
        "request",
        lambda r: calls.append({"t": time.monotonic(), "url": r.url})
        if "/api/marketplace/apis" in r.url
        else None,
    )

    # 60s, not the default 30s. Measured: the page reaches DOMContentLoaded in ~1.9s
    # normally, but a cold edge cache has exceeded 30s — and a navigation timeout would
    # otherwise be misread as the hang this probe is looking for.
    await page.goto(localised(BASE, "/chat"), wait_until="domcontentloaded", timeout=60_000)
    await page.wait_for_selector("textarea", timeout=30_000)
    await page.fill("textarea", case["prompt"])

    t0 = time.monotonic()
    await page.click(".send-btn")

    first_ms = None
    answered = False
    # Whether the page stayed responsive while generating — the Issue 2 claim.
    # Measured by evaluating a trivial expression on the main thread at intervals: if
    # generation blocks it, this call cannot return within its own timeout.
    stalls: list[int] = []

    async def poll_responsive():
        while True:
            begin = time.monotonic()
            try:
                # `page.evaluate` takes no timeout argument — passing one raises TypeError,
                # which my first version recorded as a main-thread stall. That would have
                # reported Issue 2 as reproduced on every run, from a bug in the probe.
                # `asyncio.wait_for` is the correct way to bound it.
                await asyncio.wait_for(page.evaluate("1 + 1"), timeout=5.0)
            except asyncio.TimeoutError:
                stalls.append(int((time.monotonic() - begin) * 1000))
                return
            except Exception:  # noqa: BLE001
                # Page closed or navigated — not a stall.
                return
            waited = int((time.monotonic() - begin) * 1000)
            if waited > 1_000:
                stalls.append(waited)
            await asyncio.sleep(0.5)

    watchdog = asyncio.create_task(poll_responsive())
    try:
        await page.wait_for_function(
            "() => [...document.querySelectorAll('.turn-agent .bubble')]"
            ".some(b => b.innerText.trim().length > 0)",
            timeout=ANSWER_TIMEOUT_MS,
        )
        first_ms = int((time.monotonic() - t0) * 1000)
        await page.wait_for_function(
            "() => ![...document.querySelectorAll('button')]"
            ".some(b => b.textContent.trim() === 'Stop')",
            timeout=ANSWER_TIMEOUT_MS,
        )
        answered = True
    except Exception as exc:  # noqa: BLE001
        print(f"  [{case['name']}] did not finish: {type(exc).__name__}")
    finally:
        watchdog.cancel()

    total_ms = int((time.monotonic() - t0) * 1000)
    steps = [await r.inner_text() for r in await page.query_selector_all(".tool-row")]
    tools = [s.replace("\n", " ").strip() for s in steps if "answered by" not in s]
    bubbles = [await b.inner_text() for b in await page.query_selector_all(".turn-agent .bubble")]
    answer = "\n".join(bubbles).strip()

    queries = []
    for c in calls:
        m = re.search(r"[?&]q=([^&]*)", c["url"])
        if m:
            from urllib.parse import unquote_plus

            queries.append(unquote_plus(m.group(1)))

    await page.close()
    return {
        "name": case["name"],
        "max_tools": case["max_tools"],
        "tools": tools,
        "queries": queries,
        "answer": answer,
        "first_ms": first_ms,
        "total_ms": total_ms,
        "answered": answered,
        "stalls": stalls,
    }


async def main() -> int:
    fails: list[str] = []
    results = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        for case in CASES:
            r = await run_case(browser, case)
            results.append(r)
        await browser.close()

    for r in results:
        print(f"\n=== {r['name']} ===")
        print(f"  answered      : {r['answered']}")
        print(f"  first char    : {r['first_ms']} ms")
        print(f"  total         : {r['total_ms']} ms")
        print(f"  tool steps    : {len(r['tools'])} (ceiling {r['max_tools']})")
        for t in r["tools"]:
            print(f"      - {t}")
        print(f"  catalogue queries ({len(r['queries'])}):")
        for q in r["queries"]:
            print(f"      - {q!r}")
        # Distinct vs repeated is the diagnosis, so state it rather than leaving it to be
        # eyeballed: identical repeats mean the dedup guard failed, distinct rewordings mean
        # the guard cannot see them and the fix belongs somewhere else.
        distinct = len({q.strip().lower() for q in r["queries"]})
        print(f"  distinct queries: {distinct} of {len(r['queries'])}")
        if r["stalls"]:
            print(f"  MAIN-THREAD STALLS: {r['stalls']} ms")
        print(f"  answer ({len(r['answer'])} chars): {r['answer'][:400]!r}")

        if not r["answered"]:
            fails.append(f"{r['name']}: never reached an answer")
        # Judged on the requests that actually went out, not on rendered rows.
        #
        # A refused `call_api` — "not called — needs payment" — is answered from session state
        # with no network round trip at all, so it costs the user nothing and is not the
        # non-convergence being measured. Counting rows failed a run whose three searches were
        # exactly right, purely because the model also tried to pay three times.
        billable = len(r["queries"])
        if billable > r["max_tools"]:
            fails.append(
                f"{r['name']}: {billable} catalogue round trips where at most "
                f"{r['max_tools']} is warranted"
            )
        # The original report's shape: many searches, all rewordings of one question. Distinct
        # queries below the cap are convergence; repeats mean the dedup key is not catching them.
        if len(r["queries"]) - len({q.strip().lower() for q in r["queries"]}) > 0:
            fails.append(
                f"{r['name']}: repeated an identical catalogue query — the dedup guard missed it"
            )
        if r["stalls"]:
            fails.append(f"{r['name']}: main thread blocked for {max(r['stalls'])}ms")
        if r["answered"] and len(r["answer"]) < 20:
            fails.append(f"{r['name']}: finished with an empty answer")

    print("\n" + "=" * 60)
    if fails:
        print(f"FAIL ({len(fails)})")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
