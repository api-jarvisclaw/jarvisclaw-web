"""After paying, the page comes back — the wait does not hold the composer hostage.

The defect this pins was introduced by the async-generation fix itself. Awaiting the poll held
`busy` for the whole wait, so after a successful payment the composer stayed disabled for up to
five minutes. Measured before the fix: send was still disabled 18 seconds into a 300-second
wait. From the outside that is a page that took your money and died, and it was reported exactly
that way — "I paid and there's no reaction."

Everything is stubbed: a wallet that signs, a gateway that quotes then queues, and a job that
never finishes. Nothing real is charged, and the never-finishing job is the point — it is the
client's own patience being measured, not the upstream's speed.
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
            "amount": "158500",
            "maxAmountRequired": "158500",
            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "maxTimeoutSeconds": 300,
            "resource": "/v1/audio/generations",
            "extra": {"name": "USD Coin", "version": "2"},
        }
    ]
}
RECEIPT = {
    "id": "minimax:music_probe",
    "status": "queued",
    "poll_url": "/v1/audio/generations/minimax%3Amusic_probe",
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
        ctx = browser.new_context(viewport={"width": 1280, "height": 860})
        ctx.add_init_script(WALLET_STUB)

        def route(r):
            req = r.request
            if req.method == "POST" and req.url.endswith("/v1/audio/generations"):
                paid = any(k.lower() == "x-payment" for k in req.headers)
                return r.fulfill(
                    status=200 if paid else 402,
                    content_type="application/json",
                    body=json.dumps(RECEIPT if paid else CHALLENGE),
                )
            if req.method == "GET" and "/v1/audio/generations/" in req.url:
                polls["n"] += 1
                return r.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"id": "x", "status": "in_progress"}),
                )
            return r.continue_()

        ctx.route("https://api.jarvisclaw.ai/**", route)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".composer-shell textarea", timeout=30000)
        page.wait_for_timeout(2500)

        btn = page.get_by_role("button", name="Connect wallet")
        if btn.count():
            btn.first.click()
            page.wait_for_timeout(1500)

        page.get_by_role("button", name="Music", exact=True).click()
        page.wait_for_timeout(400)
        page.fill(".composer-shell textarea", "upbeat jazz piano")
        page.click(".send-btn")

        page.wait_for_timeout(1200)
        approve = page.get_by_role("button", name="Approve")
        if approve.count():
            approve.first.click()
            print("approved the charge")
        else:
            print("FAIL: no consent dialog appeared")
            return 1

        # How long until the page is usable again. Anything beyond a couple of seconds is the
        # bug: the payment is finished, and only the media is still coming.
        released_at = None
        t0 = time.time()
        while time.time() - t0 < 20:
            page.wait_for_timeout(500)
            page.fill(".composer-shell textarea", "a second question")
            if not page.locator(".send-btn").is_disabled():
                released_at = time.time() - t0
                break

        if released_at is None:
            fails.append("the composer was still disabled after 20s of a 300s wait")
            print("   send stayed disabled for the whole window")
        else:
            print(f"   composer usable again after {released_at:.1f}s")
            if released_at > 5:
                fails.append(f"the composer took {released_at:.1f}s to come back")

        # The wait must still be running — releasing the composer must not abandon the job.
        page.wait_for_timeout(6000)
        waiting = page.locator(".media-waiting").count()
        print(f"   still showing a wait: {waiting > 0}   polls made: {polls['n']}")
        if waiting == 0:
            fails.append("the media turn stopped saying it was waiting")
        if polls["n"] == 0:
            fails.append("the job was never polled — the wait was dropped, not detached")

        # And a second message must actually work while the first is still generating.
        #
        # Guarded with a short timeout rather than a bare click. When the regression is present
        # the send button is disabled, and Playwright retries a click on a disabled element
        # until the whole probe times out — which reads as infrastructure trouble rather than as
        # the defect being caught. A probe that hangs instead of failing is a probe whose result
        # gets waved away.
        page.get_by_role("button", name="Music", exact=True).click()  # back to chat
        page.wait_for_timeout(300)
        page.fill(".composer-shell textarea", "what can you do?")
        try:
            page.click(".send-btn", timeout=3000)
            page.wait_for_timeout(3000)
        except Exception:
            fails.append("send was disabled — a second message cannot be sent while generating")
        users = page.locator(".turn-user").count()
        print(f"   user turns on screen: {users}")
        if users < 2:
            fails.append("a second message could not be sent while the first was generating")

        print("   pageerrors:", errs[:2])
        browser.close()

    print()
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS: the payment releases the page, and the wait keeps running detached.")
    return 0


sys.exit(main())
