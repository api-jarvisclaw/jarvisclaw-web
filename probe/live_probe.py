"""Drive the console in a real browser against the real gateway.

Deliberately NOT stubbed. A stub would prove the components render, which the unit
tests already cover; what is unproven is whether the browser can reach the gateway
anonymously, whether CORS actually permits it, and whether a free model's streamed
tool call survives the parser. Only the live path answers those.

Usage: python probe/live_probe.py [dev_url]
"""

import asyncio
import sys

# Windows consoles default to a legacy codepage, and the UI's tick/ellipsis glyphs raise
# UnicodeEncodeError on print — which surfaced as "tool step never appeared" for a step
# that had in fact appeared. Reconfigure rather than strip the glyphs: the point is to see
# what the page actually rendered.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from playwright.async_api import async_playwright

DEV_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"

# Generous: an anonymous free model routes to whatever is idle, and the worst of them
# takes well over a minute for a tool-calling turn. A short timeout here would report a
# working console as broken.
ANSWER_TIMEOUT_MS = 180_000


async def wait_until_idle(page) -> None:
    """Waits for the run to finish.

    NOT by watching the send button: it is disabled whenever the textarea is empty, which
    it always is right after sending, so that check never clears and reports a working
    answer as a timeout. The Stop button is only rendered while a run is in flight, so its
    absence is the actual idle signal.
    """
    await page.wait_for_function(
        "() => ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Stop')",
        timeout=ANSWER_TIMEOUT_MS,
    )


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        console_errors: list[str] = []
        page.on(
            "console",
            lambda m: console_errors.append(m.text) if m.type == "error" else None,
        )
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

        failures: list[str] = []
        # networkidle never settles on a streaming page, so waiting for it would hang.
        await page.goto(DEV_URL, wait_until="domcontentloaded")

        print("== 1. loads without an account ==")
        # Waits for the empty state's structure, not its wording. Pinning the headline text
        # made this probe fail on a copy change while the console worked perfectly — a
        # false alarm that costs more than the assertion was ever worth.
        await page.wait_for_selector(".empty h1", timeout=15_000)
        tag = await page.inner_text(".tag")
        print(f"   badge: {tag!r}")
        if "free" not in tag.lower():
            failures.append("the free-tier badge is not shown to an anonymous visitor")

        print("== 2. anonymous chat reaches the gateway ==")
        await page.fill("textarea", "Reply with exactly: PROBE_OK")
        await page.click(".send-btn")

        try:
            await page.wait_for_selector(".turn-agent .bubble", timeout=ANSWER_TIMEOUT_MS)
            # The bubble appears on the first token; give the stream a moment to finish
            # so the assertion sees the whole answer rather than a prefix.
            await wait_until_idle(page)
            answer = await page.inner_text(".turn-agent .bubble")
            print(f"   answer: {answer[:120]!r}")
            if answer.strip() == "":
                failures.append("the agent produced an empty answer")
        except Exception as exc:  # noqa: BLE001
            errs = await page.query_selector_all(".error")
            for e in errs:
                failures.append(f"error shown in UI: {await e.inner_text()}")
            if not errs:
                failures.append(f"no answer arrived: {exc}")

        print("== 3. which model answered is reported ==")
        # Both selectors on purpose. `.answered-by` is where the attribution lives; the
        # `.tool-row` fallback is what it shared before it had its own class. Matching on
        # the text keeps this honest either way — a probe pinned to one class reports a
        # restyle as a missing feature, which is how this check first failed.
        rows = await page.query_selector_all(".turn-agent .answered-by, .turn-agent .tool-row")
        texts = [await r.inner_text() for r in rows]
        answered_by = [t for t in texts if "answered by" in t]
        print(f"   {answered_by}")
        if not answered_by:
            failures.append(
                "the concrete model is not named — auto/free resolves per request, so "
                "without this the user is never told which model replied"
            )
        elif "auto/free" in answered_by[0]:
            failures.append("'auto/free' was reported as the model; that names no model")

        print("== 4. a tool call runs and is shown as free ==")
        await page.fill("textarea", "Use your tools to find an API for ethereum gas prices.")
        await page.click(".send-btn")
        try:
            await page.wait_for_selector(".tool-row .tool-name", timeout=ANSWER_TIMEOUT_MS)
            await wait_until_idle(page)
            rows = await page.query_selector_all(".tool-row")
            steps = [await r.inner_text() for r in rows]
            tool_steps = [s for s in steps if "search_apis" in s or "list_models" in s]
            print(f"   steps: {tool_steps}")
            if not tool_steps:
                failures.append(
                    "no tool step was displayed — either the model did not call a tool "
                    "or the streamed tool call was lost in parsing"
                )
            elif not any("free" in s for s in tool_steps):
                failures.append("a free tool was not labelled free")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"tool step never appeared: {exc}")

        print("== 5. no console errors ==")
        # Transport-layer noise is not an app defect: a dropped QUIC connection to
        # Cloudflare says nothing about this code, and treating it as a failure makes the
        # probe report the network's bad minute as a broken console.
        #
        # cloudflareinsights is different again — it is *expected* on the deployed site.
        # Cloudflare injects its analytics beacon into the response and our
        # `script-src 'self'` refuses it, so the error proves the CSP is working. Left
        # unfiltered it fails every run against production, and a probe that always fails
        # is a probe nobody reads — which is how a real error would get through.
        ignorable = (
            "favicon",
            "err_quic",
            "err_network_changed",
            "err_connection_reset",
            "cloudflareinsights",
            # A 401 from the session check is the CORRECT response for a visitor who is not
            # signed in, and the browser logs every non-2xx as a console error regardless. It is
            # only reachable at all because the gateway now returns CORS headers on it
            # (api-server#530); before that fix it appeared as a CORS failure instead, which was
            # a real defect. Filtered as expected rather than treated as one.
            "status of 401",
        )
        real = [e for e in console_errors if not any(i in e.lower() for i in ignorable)]
        for e in real[:5]:
            print(f"   {e[:160]}")
        if real:
            failures.append(f"{len(real)} console error(s)")

        await page.screenshot(path="probe/live_probe.png", full_page=True)
        await browser.close()

    print()
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: anonymous chat, model attribution and a free tool call all work live.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
