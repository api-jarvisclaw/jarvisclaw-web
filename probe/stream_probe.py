"""Text appears while the model is still answering, against the real gateway.

The reported symptom: send a message, get a spinner and an empty transcript for several seconds,
then the whole answer at once. The transport was streaming the entire time — `stream: true`, SSE
frames, incremental parsing — but the agent loop collected deltas into an array inside the callback
and replayed them with `yield* pending` AFTER the request resolved. Streaming transport, batched
delivery.

Unit tests cannot see this without a stub that withholds part of the response (see
`src/lib/streaming.test.ts`, which does exactly that). This measures the thing the user actually
experiences: the wall-clock gap between sending and the first visible character, and how many times
the transcript grows on the way to the final answer.

Runs against the FREE tier with no credential, which is both the path a first-time visitor takes and
the slowest one — the reported case.
"""

import os
import sys
import time

from playwright.sync_api import sync_playwright

from _probe_locale import localised

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai").rstrip("/")

# A prompt whose answer necessarily arrives in many frames.
#
# "how are you" — the reported case — can be answered in a dozen tokens, which a fast model may
# deliver in one or two frames; and a single-frame answer is indistinguishable from a batched one
# however the client behaves. Counting forces one token per line with no way to shorten it, so the
# number of growth steps below measures the client rather than the model's verbosity.
PROMPT = "Count from 1 to 40, one number per line."


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900}, color_scheme="light")
        page.goto(localised(BASE, "/chat"), wait_until="load", timeout=60000)
        page.wait_for_selector(".composer-shell textarea", timeout=30000)
        page.wait_for_timeout(2500)

        page.fill(".composer-shell textarea", PROMPT)

        # Sampled from the page rather than from the network, because what is being measured is what
        # the user sees. A response can be streaming perfectly while the UI holds it back — which is
        # precisely the defect this exists for.
        page.evaluate(
            """() => {
                window.__samples = []
                const read = () => {
                  const el = document.querySelector('.turn-agent .bubble, .turn-agent')
                  const len = el ? el.textContent.trim().length : 0
                  const last = window.__samples[window.__samples.length - 1]
                  if (!last || last.len !== len) {
                    window.__samples.push({ t: Math.round(performance.now()), len })
                  }
                  window.__raf = requestAnimationFrame(read)
                }
                window.__t0 = performance.now()
                read()
            }"""
        )

        started = time.monotonic()
        page.keyboard.press("Enter")

        # Waits for the answer to BOTH finish and exist.
        #
        # Testing only for the Stop button's absence is not enough, and it cost me a false failure:
        # the button appears a moment after Enter, so the condition is briefly true before the run
        # starts, the wait returns immediately, and the probe reports "no agent text ever appeared"
        # against a perfectly working stream. Requiring a rendered bubble as well is what makes this
        # wait mean "the answer is done" rather than "a run is not currently in flight".
        try:
            page.wait_for_function(
                """() => {
                    const running = [...document.querySelectorAll('.ghost-btn')]
                      .some((b) => b.textContent.trim() === 'Stop')
                    const bubble = document.querySelector('.turn-agent .bubble')
                    return !running && bubble && bubble.textContent.trim().length > 0
                }""",
                timeout=120000,
            )
        except Exception:  # noqa: BLE001
            # 120s, not 90. Measured against the live gateway: `auto/free` withholds its first SSE
            # frame for 11–35s depending on which upstream it resolves to, so a 90s budget was thin
            # enough to fail on a slow-but-working answer.
            fails.append("the answer never finished within 120s")
        page.wait_for_timeout(600)

        samples = page.evaluate("() => ({ t0: window.__t0, s: window.__samples })")
        page.evaluate("() => cancelAnimationFrame(window.__raf)")

        growth = [s for s in samples["s"] if s["len"] > 0]
        total = time.monotonic() - started

        if not growth:
            fails.append("no agent text ever appeared")
            print(f"answer never rendered (waited {total:.1f}s)")
        else:
            t0 = samples["t0"]
            first_ms = growth[0]["t"] - t0
            last_ms = growth[-1]["t"] - t0
            final_len = growth[-1]["len"]
            steps = len(growth)

            print(f"first character at   {first_ms:.0f}ms")
            print(f"answer complete at   {last_ms:.0f}ms  ({final_len} chars)")
            print(f"transcript grew      {steps} times")
            print(f"growth curve         {[(g['t'] - t0, g['len']) for g in growth[:8]]}")

            # The load-bearing assertion: the FIRST thing to appear must be a fragment, not a finished
            # answer.
            #
            # Counting growth steps alone is not enough, and a mutation proved it: with delivery
            # batched the probe still reported 5 steps and PASSED, because a multi-turn agent run
            # flushes one block per turn — five blocks look like five increments. The giveaway was in
            # the numbers I was printing and not asserting on: the first sample was already 826
            # characters. Batched delivery cannot produce a small first paint; streamed delivery
            # cannot produce a large one.
            first_len = growth[0]["len"]
            print(f"first paint          {first_len} chars")
            if first_len > 60:
                fails.append(
                    f"the first thing to appear was {first_len} characters — a finished block, not a"
                    " fragment, which is what batched delivery looks like"
                )
            if steps < 3:
                fails.append(
                    f"the transcript grew only {steps} time(s): the answer arrived in one block"
                )
            # Once text starts, it must keep arriving over a real span rather than completing in one
            # frame's time.
            #
            # NOT "the first character arrives early in the answer", which is what I wrote first. That
            # measured the gateway, not this client: `auto/free` withholds its first SSE frame for
            # 11–35s — verified by reading the endpoint directly, 52 frames delivered in 1.7s after a
            # 35.6s wait — so the time to first byte is upstream latency that no client change can
            # affect. Asserting on it fails a working stream and would push someone to "fix" the one
            # thing here that is already right.
            #
            # What this client controls is whether the frames it receives are forwarded as they land.
            # `steps` above is the primary measure of that; this adds that the growth is spread out,
            # catching a client that buffers for a while and then flushes in a burst.
            span_ms = growth[-1]["t"] - growth[0]["t"]
            print(f"streamed over        {span_ms:.0f}ms after the first character")
            if final_len > 120 and span_ms < 200:
                fails.append(
                    f"{final_len} characters appeared within {span_ms:.0f}ms of each other"
                    " — delivered as a burst rather than streamed"
                )

        browser.close()

    print()
    if fails:
        print("FAIL")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("PASS: the answer streams in — text appears while the model is still writing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
