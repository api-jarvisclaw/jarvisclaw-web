"""Drive the wallet flow in a real browser with an injected EIP-1193 provider.

There is no API key box any more, so what has to be proven is different: that a visitor with
no wallet is told something useful, that connecting shows their address, that a paid action
prompts the wallet with the real amount, and that declining charges nothing.

The provider is a stub — a real wallet extension cannot be driven headlessly — but everything
on our side of it is real: the 402 challenge comes from the live gateway, and the typed data
handed to the stub is what a wallet would display. The stub asserts on that payload, which is
the part a person is actually consenting to.

Usage: python probe/wallet_probe.py [url]
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

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4188"
ADDRESS = "0xAbC0000000000000000000000000000000000001"

# Injected before any app script runs, so window.ethereum exists when React first reads it.
# `signed` records every eth_signTypedData_v4 payload for later assertions.
PROVIDER = """
window.__signed = [];
window.__rejectNext = false;
window.ethereum = {
  request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return ['%s'];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_signTypedData_v4') {
      if (window.__rejectNext) {
        const e = new Error('User rejected the request.');
        e.code = 4001;
        throw e;
      }
      window.__signed.push(params[1]);
      return '0x' + 'ab'.repeat(32) + '1b';
    }
    return null;
  },
};
""" % ADDRESS


async def main() -> int:
    failures: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1500, "height": 950})
        await ctx.add_init_script(PROVIDER)
        page = await ctx.new_page()
        await page.goto(localised(URL), wait_until="networkidle")
        await page.wait_for_timeout(2000)

        print("== 1. there is no API key input any more ==")
        # The old box was a plaintext bearer credential AND could not work through CORS.
        # Its absence is the fix, so it is asserted rather than assumed.
        key_inputs = await page.locator("input[type=password]").count()
        print(f"   password inputs on the page: {key_inputs}")
        if key_inputs != 0:
            failures.append("an API key input is still present")

        print("== 2. the wallet panel offers to connect ==")
        connect = page.locator("button:has-text('Connect wallet')")
        if await connect.count() == 0:
            failures.append("no Connect wallet button")
        else:
            print(f"   {(await connect.first.inner_text()).strip()!r}")

        print("== 3. connecting shows the address and network ==")
        await connect.first.click()
        await page.wait_for_timeout(800)
        panel = await page.locator(".sidebar .panel").last.inner_text()
        print("   " + panel.replace("\n", " | "))
        if ADDRESS[:6].lower() not in panel.lower():
            failures.append(f"the connected address is not shown: {panel!r}")
        if "Base" not in panel:
            failures.append("the network is not shown as Base")

        print("== 4. the free tier still needs no wallet ==")
        badge = (await page.locator(".tag").inner_text()).strip()
        print(f"   badge now: {badge!r}")
        if "signed in" not in badge.lower() and "free" not in badge.lower():
            failures.append(f"unexpected badge state {badge!r}")

        print("== 5. a paid action prompts the wallet with the real amount ==")
        await page.click(".mode-btn:has-text('Image')")
        await page.fill("textarea", "a red cube on a white background")
        await page.click(".send-btn")
        try:
            await page.wait_for_selector(".dialog", timeout=90_000)
        except Exception:
            body = await page.inner_text(".transcript")
            failures.append("no price was quoted for an image")
            print("   transcript said:", body[-240:].replace("\n", " | "))
        else:
            amount = (await page.inner_text(".amount")).strip()
            print(f"   quoted in-app: {amount}")
            await page.click(".approve")
            # The wallet prompt happens after approval; give the signature a moment.
            await page.wait_for_timeout(1500)
            signed = await page.evaluate("() => window.__signed")
            if not signed:
                failures.append("approving did not ask the wallet to sign")
            else:
                typed = json.loads(signed[-1])
                msg = typed["message"]
                print(f"   wallet was asked to sign: primaryType={typed['primaryType']}")
                print(f"     to={msg['to']}  value={msg['value']}  chainId={typed['domain']['chainId']}")
                if typed["primaryType"] != "TransferWithAuthorization":
                    failures.append(f"wrong primaryType {typed['primaryType']}")
                if typed["domain"]["chainId"] != 8453:
                    failures.append(f"signed against chain {typed['domain']['chainId']}, not Base")
                if msg["from"].lower() != ADDRESS.lower():
                    failures.append("the signature is not from the connected account")
                # The amount in the wallet must match what the app showed, or the dialog is
                # not the consent it claims to be.
                shown = amount.replace("$", "")
                atomic = str(int(round(float(shown) * 1_000_000)))
                if msg["value"] != atomic:
                    failures.append(
                        f"the wallet was asked for {msg['value']} atomic but the app showed {amount} ({atomic})"
                    )
                if not msg["nonce"].startswith("0x") or len(msg["nonce"]) != 66:
                    failures.append(f"bad nonce {msg['nonce']!r}")

        print("== 6. declining in the wallet charges nothing ==")
        await page.evaluate("() => { window.__rejectNext = true }")
        # The mode buttons TOGGLE. Clicking Image again here turned the mode off and sent the
        # message as a chat, so no wallet prompt happened and the probe reported a missing
        # cancellation notice for a flow that works. Select it only if it is not already on.
        if await page.locator(".mode-btn-active:has-text('Image')").count() == 0:
            await page.click(".mode-btn:has-text('Image')")
        await page.fill("textarea", "another cube")
        await page.click(".send-btn")
        try:
            await page.wait_for_selector(".dialog", timeout=90_000)
            await page.click(".approve")
            await page.wait_for_timeout(1500)
        except Exception:
            failures.append("the second image was never quoted")
        notices = [t.strip() for t in await page.locator(".notice").all_inner_texts()]
        cancelled = [n for n in notices if "cancel" in n.lower()]
        print(f"   notices: {cancelled or notices[-1:]}")
        if not cancelled:
            failures.append("a wallet rejection was not reported as a cancellation")
        spent = (await page.locator(".kv-spent span:last-child").inner_text()).strip()
        print(f"   session spend after cancelling: {spent}")
        if spent != "$0.000000":
            failures.append(f"a cancelled payment recorded spend: {spent}")

        print("== 7. no wallet installed is explained, not broken ==")
        ctx2 = await browser.new_context(viewport={"width": 1500, "height": 950})
        page2 = await ctx2.new_page()
        await page2.goto(localised(URL), wait_until="networkidle")
        await page2.wait_for_timeout(1500)
        text = await page2.locator(".sidebar").inner_text()
        has_get = await page2.locator("a:has-text('Get a wallet')").count()
        print(f"   offers a way to get one: {has_get > 0}")
        if has_get == 0:
            failures.append("a visitor with no wallet is not told what to do")
        if "free models work without one" not in text.lower():
            failures.append("the no-wallet state does not say free models still work")

        await browser.close()

    print()
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: no key box, wallet connects, the signed amount matches the quote, declining costs nothing.")
    return 0


sys.exit(asyncio.run(main()))
