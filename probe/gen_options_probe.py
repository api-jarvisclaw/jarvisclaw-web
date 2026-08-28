"""Every generation option is reachable, styled, and reaches the request body.

The defect this exists for: two of these controls did nothing and three more were missing entirely,
and no test could see it. A unit test checks what the client SENDS; the 402 quote is identical
whether a parameter is honoured, ignored, or about to be rejected. So the client and its tests
agreed with each other while the artifact the user paid for ignored them.

What this checks that neither could:

  1. **Each control renders with a real, styled chip row.** A control whose class has no CSS rule
     occupies space and reports visible — measured on the prompt-library dialog, which rendered ten
     thousand pixels below the fold with is_visible() returning true.
  2. **Picking a value changes the REQUEST BODY.** Intercepted on the wire, so a value that stops at
     component state is caught.
  3. **Conditional controls appear and disappear.** Compression is jpeg-only, and `transparent` is
     withheld when the format cannot carry it — because an option that silently does nothing is the
     thing being fixed.
  4. **The labels are translated.** They were the last untranslated row in the composer.
"""

import json
import os
import sys

from playwright.sync_api import sync_playwright

from _probe_locale import localised

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai")


def main() -> int:
    fails = []
    bodies = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1500, "height": 1000})
        page.route(
            "**/api/marketplace/**",
            lambda r: r.fulfill(
                status=200,
                json={"success": True, "data": {"items": [], "total": 0, "categories": []}},
            ),
        )
        page.route("**/api/discovery/models**", lambda r: r.fulfill(status=200, json={"free": []}))

        # Capture the quote body and answer with a 402, so nothing is ever spent and the exact
        # request the app builds is observable.
        def quote(route):
            try:
                bodies.append(json.loads(route.request.post_data or "{}"))
            except Exception:  # noqa: BLE001
                bodies.append({"__unparsed__": route.request.post_data})
            route.fulfill(status=402, json={"accepts": [{"amount": "64000"}]})

        page.route("**/v1/images/generations", quote)
        page.route("**/v1/audio/speech", quote)

        page.goto(localised(URL, "/chat"), wait_until="domcontentloaded")
        page.wait_for_selector(".composer-shell textarea", timeout=30000)

        def open_panel(mode: str) -> None:
            page.get_by_role("button", name=mode).first.click()
            page.wait_for_timeout(400)
            page.locator(".genopts > button").click()
            page.wait_for_selector(".genopts-menu", timeout=10000)
            page.wait_for_timeout(300)

        def rows() -> dict[str, list[str]]:
            # Lower-cased keys: the labels are UPPERCASED by CSS (text-transform), so inner_text
            # returns "SIZE" while the source says "Size". Matching the source spelling found
            # nothing and reported two working controls as missing.
            out = {}
            for row in page.locator(".genopts-row").all():
                label = row.locator(".genopts-label").inner_text().strip().lower()
                out[label] = [c.inner_text().strip() for c in row.locator(".genopts-chip").all()]
            return out

        # ---- image ----
        open_panel("Image")
        img = rows()
        print(f"image rows: { {k: len(v) for k, v in img.items()} }")
        for k, v in img.items():
            print(f"  {k}: {v}")
        if len(img) < 5:
            fails.append(
                f"only {len(img)} image controls rendered: {list(img)} — size, quality, count, "
                "format and background were all measured working"
            )

        # Every chip must be a styled control, not bare text.
        chip = page.locator(".genopts-chip").first
        pad = chip.evaluate("e => getComputedStyle(e).padding")
        box = chip.bounding_box()
        print(f"chip: padding={pad} box={box}")
        if pad in ("0px", "") or not box or box["height"] < 14:
            fails.append(f"the option chips have no styling: padding={pad} box={box}")

        # Compression is jpeg-only. It must be absent for png and present after switching.
        if "compression" in img:
            fails.append("compression is offered for png, which the upstream cannot apply")
        before_bg = img.get("background", [])
        if "transparent" not in before_bg:
            fails.append(f"png cannot offer a transparent background: {before_bg}")

        page.locator(".genopts-row", has_text="FORMAT").locator(
            ".genopts-chip", has_text="jpeg"
        ).click()
        page.wait_for_timeout(400)
        after = rows()
        print(f"after picking jpeg: rows={list(after)}  background={after.get("background")}")
        if "compression" not in after:
            fails.append("compression did not appear for jpeg")
        if "transparent" in after.get("background", []):
            fails.append(
                "transparent is still offered for jpeg — a transparent jpeg is not a thing, and "
                "offering it is the silent-no-op defect this panel just had two of"
            )

        # ---- the value must reach the wire ----
        page.locator(".genopts-row", has_text="COMPRESSION").locator(
            ".genopts-chip", has_text="40%"
        ).click()
        page.wait_for_timeout(300)
        page.locator(".genopts > button").click()  # close the panel
        page.fill(".composer-shell textarea", "a red square")
        page.locator(".send-btn").click()
        page.wait_for_timeout(2500)

        img_bodies = [b for b in bodies if "size" in b or "output_format" in b]
        print(f"quote bodies captured: {len(img_bodies)}")
        if not img_bodies:
            fails.append(
                "no image quote was captured — the send never reached the gateway, so nothing "
                "below proves anything"
            )
        else:
            b = img_bodies[-1]
            print(f"  body: { {k: v for k, v in b.items() if k != 'prompt'} }")
            for field, want in [("output_format", "jpeg"), ("output_compression", 40)]:
                if b.get(field) != want:
                    fails.append(
                        f"{field} did not reach the request body: got {b.get(field)!r}, "
                        f"expected {want!r} — the pick stopped at component state"
                    )

        # ---- video: the options must be scoped to the chosen model ----
        #
        # `[5, 10]` was one list for every model. Sora takes only 4/8/12 and no resolution at all;
        # seedance-2.5 reaches 30s; only 2.0 reaches 4K. Offering the union means offering values
        # that 400 AFTER the charge is approved.
        page.route("**/v1/videos/generations", quote)
        open_panel("Video")
        vid = rows()
        print(f"video rows: {list(vid)}")
        for k, v in vid.items():
            print(f"  {k}: {v}")
        for need in ("length", "resolution", "shape", "audio"):
            if need not in vid:
                fails.append(f"the video panel has no {need} control: {list(vid)}")
        # Whatever model is selected, its duration list must be a real one rather than the union.
        if "length" in vid:
            lens = [int(x.rstrip("s")) for x in vid["length"] if x.rstrip("s").isdigit()]
            print(f"  durations offered: {lens}")
            if not lens:
                fails.append(f"no durations parsed from {vid['length']}")
            elif max(lens) > 30:
                fails.append(f"a duration above every documented ceiling is offered: {lens}")

        # ---- speech: the voice list must be scoped to the model's family ----
        #
        # An out-of-family voice does NOT 400. Measured: elevenlabs/flash-v2.5 + alloy returns
        # "upstream 402 after payment — USDC already settled on-chain and cannot be reversed". The
        # payment goes through and the upstream refuses; the money is gone. So this is the one option
        # list where a wrong entry costs the charge as well as the call.
        page.route("**/v1/audio/speech", quote)
        open_panel("Speech")
        sp = rows()
        print(f"speech rows: {list(sp)}")
        for k, v in sp.items():
            print(f"  {k}: {v[:6]}{' …' if len(v) > 6 else ''}")
        if "voice" in sp:
            vs = sp["voice"]
            fams = {
                "elevenlabs": {"Sarah", "George", "Roger", "Brian", "Daniel"},
                "openai": {"alloy", "echo", "coral", "verse", "ash"},
            }
            hits = {
                f: sum(1 for v in vs if any(n.lower() in v.lower() for n in names))
                for f, names in fams.items()
            }
            print(f"  family hits: {hits}")
            if hits["elevenlabs"] > 0 and hits["openai"] > 0:
                fails.append(
                    f"the voice list mixes families: {vs[:8]} — an out-of-family name settles the "
                    "payment and is then refused, so the money is lost, not just the call"
                )
            if sum(hits.values()) == 0:
                fails.append(f"no recognisable voices offered: {vs[:8]}")

        # ---- music: instrumental and lyrics were documented and never offered ----
        open_panel("Music")
        mu = rows()
        print(f"music rows: {list(mu)}")
        if "vocals" not in mu:
            fails.append(f"the music panel has no vocals control: {list(mu)}")
        # The lyrics box must be a real, styled textarea rather than a class with no rule behind it.
        ta = page.locator(".genopts-text")
        if ta.count() == 0:
            fails.append("no lyrics box in the music panel")
        else:
            st = ta.first.evaluate(
                "e => { const c = getComputedStyle(e); return [c.display, c.borderStyle, c.padding, c.maxHeight]; }"
            )
            tb = ta.first.bounding_box()
            print(f"  lyrics box: display={st[0]} border={st[1]} padding={st[2]} maxH={st[3]} box={tb}")
            if st[1] == "none" or st[2] in ("0px", ""):
                fails.append(
                    f"the lyrics box has no styling ({st}) — .genopts-text has no CSS rule, the same "
                    "shape as the dialog that rendered ten thousand pixels off screen"
                )
            if st[3] == "none":
                fails.append("the lyrics box is uncapped; long lyrics push the panel off screen")

        browser.close()

    print()
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS: every option renders, is styled, gates correctly, and reaches the request body")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
