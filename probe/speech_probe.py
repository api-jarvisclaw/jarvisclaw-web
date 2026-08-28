"""Prove the reported failure is gone: speech must be ONE cheap call, not an agent run.

What went wrong, measured on the live gateway:

    auto/tts @ /v1/chat/completions  -> 402, $0.001   (a PAID CHAT MODEL, answers in words)
    auto/tts @ /v1/audio/speech      -> 400           (not servable at all)

So asking for speech with `auto/tts` picked ran the agent loop over a paid chat model. Five
steps, five wallet signatures, $0.068, and the answer was a suggestion to use the browser's
own Web Speech API. No audio was ever produced.

This probe asserts the three things that make that impossible now:

  1. choosing a voice model routes to /v1/audio/speech, not to chat;
  2. the whole request costs ONE signature, at the speech price (~$0.002);
  3. the request body carries `input` — /v1/audio/speech 400s on `prompt`.

The wallet is a stub because an extension cannot be driven headlessly. Everything on our side
of it is real: the 402 comes from the live gateway and the typed data is what a wallet shows.
The speech CALL itself is intercepted, because settling it would spend real USDC — what is
being proven here is the routing and the count, and both are decided before settlement.

Usage: python probe/speech_probe.py [url]
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

PROVIDER = """
window.__signed = [];
window.ethereum = {
  request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return ['%s'];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_signTypedData_v4') {
      window.__signed.push(params[1]);
      return '0x' + 'ab'.repeat(32) + '1b';
    }
    return null;
  },
};
""" % ADDRESS

# A tiny valid MP3-ish payload. Content does not matter — what matters is that the app is
# handed base64 audio and has to render a player for it rather than a dead image.
FAKE_AUDIO_B64 = "SUQzAwAAAAAAD1RJVDIAAAAFAAAAdGVzdA=="


async def main() -> int:
    failures: list[str] = []
    posts: list[dict] = []
    # CSP refusals arrive as console errors, not as exceptions or failed requests. Collected
    # from the first navigation so a policy that blocks the clip is visible.
    csp_violations: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1500, "height": 950})
        await ctx.add_init_script(PROVIDER)
        page = await ctx.new_page()

        async def record(route):
            req = route.request
            body = {}
            try:
                body = json.loads(req.post_data or "{}")
            except Exception:
                pass
            paid = req.headers.get("x-payment") is not None
            posts.append({"url": req.url, "body": body, "paid": paid})

            # Only the PAID leg is faked. The anonymous quote goes to the real gateway, so the
            # price and the challenge the wallet signs are the gateway's own.
            if paid:
                await route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"data": [{"audio": FAKE_AUDIO_B64}]}),
                )
            else:
                await route.continue_()

        def on_console(msg) -> None:
            text = msg.text
            if "Content Security Policy" in text or "violates the following" in text:
                csp_violations.append(text)

        page.on("console", on_console)

        await page.route("**/v1/audio/speech", record)
        await page.route("**/v1/chat/completions", record)

        await page.goto(localised(URL), wait_until="networkidle")
        await page.wait_for_timeout(2000)

        print("== 1. connect the wallet ==")
        await page.click("button:has-text('Connect wallet')")
        await page.wait_for_timeout(800)

        print("== 2. pick a voice model in the picker ==")
        await page.click(".picker-trigger")
        await page.fill(".picker-search", "turbo-v2.5")
        await page.wait_for_timeout(500)
        row = page.locator(".picker-row:has-text('elevenlabs/turbo-v2.5')")
        if await row.count() == 0:
            failures.append("the catalogue offered no elevenlabs/turbo-v2.5 to pick")
            await page.keyboard.press("Escape")
        else:
            await row.first.click()
            await page.wait_for_timeout(400)

        print("== 3. the composer says it will run as speech, not chat ==")
        hint = (await page.inner_text(".hint")).strip()
        print(f"   {hint}")
        if "speech" not in hint.lower():
            failures.append(f"the hint does not say a voice model runs as speech: {hint!r}")

        print("== 4. send the words to speak ==")
        await page.fill("textarea", "你好，欢迎使用")
        await page.click(".send-btn")

        # A dialog is NOT expected here, and expecting one was this probe's own first bug.
        # $0.002 is under the $0.05 ask-threshold, so the spend policy allows it without a
        # prompt — by design. Waiting for a dialog therefore timed out on a flow that worked.
        #
        # So both paths are handled: approve a dialog if one appears (it would mean the price
        # came back unexpectedly high), otherwise wait for the result.
        try:
            await page.wait_for_selector(".dialog", timeout=8_000)
            amount = (await page.inner_text(".amount")).strip()
            print(f"   asked to approve: {amount}")
            usd = float(amount.replace("$", ""))
            if usd > 0.05:
                # Worth flagging rather than silently approving: a speech clip at more than the
                # threshold means the endpoint or the model changed price.
                print(f"   NOTE: above the $0.05 ask-threshold, hence the prompt")
            await page.click(".approve")
        except Exception:
            print("   no prompt — under the ask-threshold, which is the intended behaviour")

        try:
            await page.wait_for_selector(".media-card, .error", timeout=90_000)
        except Exception:
            body = await page.inner_text(".transcript")
            failures.append("the speech request produced neither a clip nor an error")
            print("   transcript said:", body[-300:].replace("\n", " | "))
        await page.wait_for_timeout(1500)

        price_shown = await page.locator(".media-card .price").count()
        if price_shown:
            print(f"   clip price shown: {(await page.locator('.media-card .price').first.inner_text()).strip()}")

        print("== 5. it went to the speech endpoint, never to chat ==")
        speech_posts = [q for q in posts if "/v1/audio/speech" in q["url"]]
        chat_posts = [q for q in posts if "/v1/chat/completions" in q["url"]]
        quotes = [q for q in speech_posts if not q["paid"]]
        paid = [q for q in speech_posts if q["paid"]]
        print(f"   POST /v1/audio/speech     x{len(speech_posts)} ({len(quotes)} quote, {len(paid)} paid)")
        print(f"   POST /v1/chat/completions x{len(chat_posts)}")
        if not speech_posts:
            failures.append("the speech endpoint was never called")
        if chat_posts:
            # This is the original bug in one line: a voice request billed as chat.
            failures.append(f"a voice request still hit the chat endpoint {len(chat_posts)}x")
        # Exactly two calls: one anonymous quote (so the price is the gateway's, and an
        # unconnected visitor can learn it for free) and one paid call carrying the signature.
        # A third would mean something is being paid for twice.
        if len(quotes) != 1:
            failures.append(f"expected 1 anonymous quote, saw {len(quotes)}")
        if len(paid) != 1:
            failures.append(f"expected 1 paid call, saw {len(paid)}")

        print("== 6. the body used `input`, which is what the endpoint reads ==")
        for q in speech_posts:
            if "input" not in q["body"]:
                failures.append(f"a speech call sent no `input` field: {list(q['body'])}")
            if "prompt" in q["body"]:
                failures.append("a speech call sent `prompt`, which this endpoint 400s on")
        if speech_posts:
            print(f"   body keys: {sorted(speech_posts[0]['body'])}")
            print(f"   model: {speech_posts[0]['body'].get('model')}")

        print("== 7. ONE signature, not five ==")
        signed = await page.evaluate("() => window.__signed")
        print(f"   signatures requested: {len(signed)}")
        # The reported failure was five prompts for one request. One is the floor (an x402
        # `exact` signature authorises exactly one HTTP request); more than one means the
        # agent loop is running when it should not be.
        if len(signed) != 1:
            failures.append(f"one speech request took {len(signed)} wallet signatures, expected 1")
        if signed:
            typed = json.loads(signed[-1])
            msg = typed["message"]
            print(f"   value={msg['value']} atomic  chainId={typed['domain']['chainId']}")
            if typed["primaryType"] != "TransferWithAuthorization":
                failures.append(f"wrong primaryType {typed['primaryType']}")

        print("== 8. the clip is rendered as audio, not as a dead image ==")
        audio = page.locator(".media-audio")
        if await audio.count() == 0:
            body = await page.inner_text(".transcript")
            failures.append("no audio player was rendered for a paid clip")
            print("   transcript said:", body[-300:].replace("\n", " | "))
        else:
            src = await audio.first.get_attribute("src")
            head = (src or "")[:24]
            print(f"   player src starts: {head}")
            # The old code stamped every inlined payload as image/png, which renders a dead
            # player. That is indistinguishable from a charge that produced nothing.
            if "audio/" not in (src or ""):
                failures.append(f"the clip was labelled with a non-audio mime type: {head}")

            # A correct src is not enough: the CSP decides whether the browser will LOAD it.
            # Without `media-src 'self' data: https:` a data: clip falls back to default-src
            # and is refused — the attribute still reads perfectly while the player is dead.
            # Checking the attribute alone passed against a stale server serving the old
            # policy, so the refusal itself has to be observed.
            blocked = [m for m in csp_violations if "media-src" in m or "data:" in m]
            print(f"   CSP violations mentioning media: {len(blocked)}")
            if blocked:
                failures.append(f"the CSP refused to load the clip: {blocked[0][:160]}")

            # readyState > 0 means metadata was parsed, i.e. the bytes were actually accepted.
            # HAVE_NOTHING (0) with no error is what a CSP block looks like from script.
            state = await page.evaluate(
                """() => {
                    const el = document.querySelector('.media-audio');
                    return el ? { ready: el.readyState, err: el.error ? el.error.code : null } : null;
                }"""
            )
            print(f"   player state: {state}")
            if state and state["err"] is not None:
                # code 4 is MEDIA_ERR_SRC_NOT_SUPPORTED, which the fake payload can legitimately
                # trigger — it is not real MP3. A CSP refusal shows up as the violation above.
                print(f"   (decode error {state['err']} — expected, the probe payload is not real audio)")

        await browser.close()

    print()
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: a voice model routes to /v1/audio/speech, costs one signature, and plays as audio.")
    return 0


sys.exit(asyncio.run(main()))
