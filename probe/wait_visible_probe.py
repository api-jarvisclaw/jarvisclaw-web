"""A long generation shows continuous progress, and survives a reload.

Reported as: "generating audio or video loses state — I ask for a video, then I wait a long time
with no indication of anything."

Two distinct failures were measured behind that one sentence:

  1. The elapsed counter only moved when a POLL RETURNED, i.e. every five seconds. Over eighteen
     seconds it read 0s, 0s, 5s, 5s, 10s, 10s, 10s, 15s. A number that sits still for three
     consecutive checks is indistinguishable from a frozen page.

  2. Reloading mid-wait wiped everything. `turns after reload: []` — the transcript, and with it
     the only on-screen record of a paid job. Conversations were being saved correctly, but
     `activeId` started null so a reload always opened a blank chat. And nothing resumed the
     polling, so even reopening the chat by hand left the turn frozen at whatever second it had
     reached, with the media sitting on the server uncollected.

A four-minute wait is exactly when someone reloads, which is what made this the worst of the
three. Everything here is stubbed — a wallet that signs, a gateway that quotes then queues, and a
job that never finishes. Nothing real is charged.
"""

import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

URL = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai/")

CHALLENGE = {
    "accepts": [
        {
            "scheme": "exact",
            "network": "eip155:8453",
            "payTo": "0x000000000000000000000000000000000000dEaD",
            "amount": "399554",
            "maxAmountRequired": "399554",
            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "maxTimeoutSeconds": 300,
            "resource": "/v1/videos/generations",
            "extra": {"name": "USD Coin", "version": "2"},
        }
    ]
}
RECEIPT = {
    "id": "bytedance:video_probe",
    "status": "queued",
    "poll_url": "/v1/videos/generations/bytedance%3Avideo_probe",
}

WALLET_STUB = """
  window.ethereum = {
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts')
        return ['0x1111111111111111111111111111111111111111'];
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_signTypedData_v4') return '0x' + 'ab'.repeat(65);
      return null;
    },
    on() {}, removeListener() {},
  };
"""


def main() -> int:
    fails = []
    polls = {"n": 0}

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        ctx.add_init_script(WALLET_STUB)

        def route(r):
            req = r.request
            if req.method == "POST" and req.url.endswith("/v1/videos/generations"):
                paid = any(k.lower() == "x-payment" for k in req.headers)
                return r.fulfill(
                    status=200 if paid else 402,
                    content_type="application/json",
                    body=json.dumps(RECEIPT if paid else CHALLENGE),
                )
            if req.method == "GET" and "/v1/videos/generations/" in req.url:
                polls["n"] += 1
                return r.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"id": "x", "status": "in_progress"}),
                )
            return r.continue_()

        ctx.route("https://api.jarvisclaw.ai/**", route)
        page = ctx.new_page()
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".composer-shell textarea", timeout=30000)
        page.wait_for_timeout(2500)

        btn = page.get_by_role("button", name="Connect wallet")
        if btn.count():
            btn.first.click()
            page.wait_for_timeout(1500)

        page.get_by_role("button", name="Video", exact=True).click()
        page.wait_for_timeout(400)
        page.fill(".composer-shell textarea", "a cat surfing a wave")
        page.click(".send-btn")
        page.wait_for_timeout(1200)
        approve = page.get_by_role("button", name="Approve")
        if not approve.count():
            print("FAIL: no consent dialog")
            return 1
        approve.first.click()
        page.wait_for_selector(".media-waiting", timeout=15000)

        # ── 1. the counter moves every second, not every fifth ──
        print("== elapsed counter, sampled once a second ==")
        seen = []
        widths = []
        for _ in range(7):
            page.wait_for_timeout(1000)
            txt = page.inner_text(".media-waiting").strip().replace("\n", " ")
            seen.append(txt)
            w = page.evaluate(
                "() => { const e = document.querySelector('.media-progress-fill');"
                " return e ? Math.round(e.getBoundingClientRect().width) : -1 }"
            )
            widths.append(w)
            print(f"   {txt[:60]!r}  barpx={w}")

        distinct = len(set(seen))
        print(f"   distinct readings over 7s: {distinct}")
        if distinct < 5:
            # Before the fix this was 3 or 4 over the same window.
            fails.append(f"the counter changed only {distinct} times in 7 samples")
        if len(set(widths)) < 2:
            fails.append("the progress bar never moved")
        if not any("usually" in t for t in seen):
            # A wait with no sense of scale is what makes three minutes feel broken.
            fails.append("no expected duration shown")

        # ── 2. it survives a reload, and resumes ──
        print("\n== reloading mid-wait ==")
        polls_before = polls["n"]
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".composer-shell textarea", timeout=30000)
        page.wait_for_timeout(3000)

        turns = page.locator(".turn").count()
        waiting = page.locator(".media-waiting").count()
        text = page.inner_text(".media-waiting").strip().replace("\n", " ") if waiting else ""
        print(f"   turns restored: {turns}")
        print(f"   still waiting : {waiting > 0}   {text[:70]!r}")

        if turns == 0:
            # The original bug, in its own words.
            fails.append("the transcript was empty after a reload")
        if waiting == 0:
            fails.append("the pending generation was not restored")
        elif "Still generating" not in text:
            # Silent resumption invites a second paid attempt at something already running.
            fails.append("the resumed wait does not say it was picked back up")

        # Polling has to have actually restarted, not just the text.
        page.wait_for_timeout(7000)
        resumed_polls = polls["n"] - polls_before
        print(f"   polls after reload: {resumed_polls}")
        if resumed_polls == 0:
            fails.append("polling did not resume — the job would never be collected")

        # ── 3. the conversation list marks it ──
        dots = page.locator(".rail-row-pending").count()
        print(f"   pending dots in the list: {dots}")
        if dots == 0:
            fails.append("no marker in the conversation list for a running generation")

        browser.close()

    print()
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS: the wait is continuously visible, survives a reload, and resumes polling.")
    return 0


sys.exit(main())
