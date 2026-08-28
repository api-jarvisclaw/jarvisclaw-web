"""A chosen option must still be VALID for the model that ends up running.

## The defect

`genOptions` is keyed by generation KIND, not by model:

    const [genOptions, setGenOptions] = useState<Record<GenerationKind, GenOptions>>(DEFAULT_OPTIONS)

That is deliberate and good for the case it was written for — switching Image -> Video -> Image
should not forget the size you chose. But nothing reconciles the stored value with the NEW model's
limits, and the limits are per-model:

    pick 30s under seedance-2.5, switch to sora-2   -> panel offers 4/8/12, state still holds 30
    pick 4K under seedance-2.0, switch to 2.0-fast  -> panel offers up to 720p, state still holds 4K
    pick a Sarah voice under elevenlabs, switch to openai/*  -> state still holds an ElevenLabs id

The panel redraws correctly — `videoLimitsFor(model)` is already per-model — so the offending value
is not visible anywhere. It is only in state, and state is what `buildBody` marshals.

## Why nothing existing catches it

- The unit tests call `buildBody` with options they construct themselves, so they never model
  "the user changed the model after choosing".
- `gen_options_probe.py` opens each panel once and reads the chips. Chips are drawn from the new
  model's limits, so they look right — the wrong value is in state, not in the DOM.
- The 402 quote validates NOTHING. Measured directly against the live gateway while writing this:

      {"quality": "hd"}    -> 402, $0.064     (this exact value is a documented 400 downstream)
      {"quality": "zzzz"}  -> 402, $0.064
      {"size": "3x3"}      -> 402, $0.064

  So the quote cannot be a criterion for any parameter. The gate sits in front of validation.

That last point is why this probe reads the REQUEST BODY rather than a status code. The wire is the
only place the defect is observable before money moves.

## Criterion

    Deliverable: a value the user picked must never be sent to a model that does not accept it.
    Criterion:   for each (model A -> model B) switch, the captured body's fields must all be
                 members of videoLimitsFor(B) / speechVoicesFor(B) / speechSpeedsFor(B).
    Falsifier:   a body carrying duration_seconds=30 to sora-2, resolution=4K to 2.0-fast, or an
                 ElevenLabs voice id to an openai/* model. Any of those is a FAIL, and the probe
                 was confirmed to produce exactly them before the fix.

The speech case is the expensive one and it is not hypothetical: an out-of-family voice does not
400. It returns "upstream 402 after payment — USDC already settled on-chain and cannot be
reversed" — the charge lands and the upstream then refuses. So for speech this is not a failed
call, it is a lost payment.
"""

import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

from _probe_locale import localised

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai")

# The per-model truth, mirrored from src/lib/modality.ts. Written out rather than imported because
# this is the independent check: if the table and the shipped bundle disagree, that is a finding,
# not a reason to share a constant.
VIDEO_LIMITS = {
    "azure/sora-2": {"durations": [4, 8, 12], "resolutions": [], "aspect": []},
    "bytedance/seedance-2.0": {
        "durations": [4, 5, 6, 8, 10, 12, 15],
        "resolutions": ["480p", "720p", "1080p", "4K"],
        "aspect": ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    },
    "bytedance/seedance-2.0-fast": {
        "durations": [4, 5, 6, 8, 10, 12, 15],
        "resolutions": ["480p", "720p"],
        "aspect": ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    },
    "bytedance/seedance-2.5": {
        "durations": [4, 5, 6, 8, 10, 12, 15, 20, 30],
        "resolutions": ["480p", "720p"],
        "aspect": ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    },
    "xai/grok-imagine-video": {
        "durations": [1, 2, 4, 6, 8, 10, 12, 15],
        "resolutions": ["480p", "720p"],
        "aspect": ["16:9", "9:16", "1:1", "4:3", "3:4"],
    },
}

ELEVENLABS_IDS = {
    "sarah", "george", "roger", "laura", "charlie", "callum", "river", "harry",
    "nPczCjzI2devNBz1zQrb", "onwK4e9ZLuTAKqWW03F9", "Xb7hH8MSUJpSbSDYk0k2",
    "cgSgspJ2msm6clMCkdW9", "pFZP5JQG7iQjIQuC4Bku", "cjVigY5qzO86Huf0OWal",
}
OPENAI_IDS = {
    "alloy", "echo", "fable", "onyx", "nova", "shimmer", "coral", "verse", "ballad",
    "ash", "sage", "marin", "cedar", "juniper", "maple", "ember",
}


def fetch_catalogue() -> dict:
    """The live catalogue. Fetched, not invented — the model names must be ones the picker offers.

    Cloudflare answers 403 to urllib's default User-Agent, which is a silent way to end up with an
    empty catalogue and therefore a probe that skips every case.
    """
    req = urllib.request.Request(
        "https://api.jarvisclaw.ai/api/discovery/models",
        headers={"User-Agent": "Mozilla/5.0 (compatible; jarvisclaw-probe/1.0)"},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        body = json.load(res)
    rows = body.get("data") or []
    if len(rows) < 50:
        raise SystemExit(f"the catalogue returned {len(rows)} models — refusing to probe on that")
    return body


CATALOGUE = fetch_catalogue()


def main() -> int:
    fails = []
    bodies: list[dict] = []
    print(f"catalogue: {len(CATALOGUE.get('data') or [])} models")

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
        # The REAL catalogue, fetched once and replayed. Stubbing it empty (as the sibling probe
        # does, because it only needs the panel) leaves the picker with nothing to select, and this
        # probe's whole subject is switching between models — so an empty stub would make every
        # case skip and the probe would report a clean run having checked nothing.
        page.route("**/api/discovery/models**", lambda r: r.fulfill(status=200, json=CATALOGUE))

        def quote(route):
            try:
                bodies.append(json.loads(route.request.post_data or "{}"))
            except Exception:  # noqa: BLE001
                bodies.append({"__unparsed__": route.request.post_data})
            # 402 and nothing else: the point is to read the body the app built, never to spend.
            route.fulfill(status=402, json={"accepts": [{"amount": "64000"}]})

        page.route("**/v1/videos/generations", quote)
        page.route("**/v1/audio/speech", quote)

        page.goto(localised(URL, "/chat"), wait_until="domcontentloaded")
        page.wait_for_selector(".composer-shell textarea", timeout=30000)

        def enter_mode(mode: str) -> None:
            # `.mode-btn`, not get_by_role(name=mode). The landing page carries a suggestion chip
            # reading "What would a 5-second video cost me?", which matches an accessible name of
            # "Video" and sorts BEFORE the mode button — so `.first` clicked the suggestion, sent a
            # chat message, and left the composer in chat mode with no options panel at all.
            btn = page.locator(".mode-btn", has_text=mode)
            btn.first.click()
            page.wait_for_timeout(500)
            if btn.first.get_attribute("aria-pressed") != "true":
                fails.append(f"the {mode} mode button did not engage")

        def open_panel() -> None:
            page.locator(".genopts > button").click()
            page.wait_for_selector(".genopts-menu", timeout=10000)
            page.wait_for_timeout(250)

        def close_panel() -> None:
            if page.locator(".genopts-menu").count() > 0:
                page.keyboard.press("Escape")
                page.wait_for_timeout(200)

        def pick(row_label: str, chip_text: str) -> bool:
            """Click a chip by its row's uppercase label. False when it is not offered."""
            row = page.locator(".genopts-row", has_text=row_label.upper())
            if row.count() == 0:
                return False
            chip = row.first.locator(".genopts-chip", has_text=chip_text)
            if chip.count() == 0:
                return False
            chip.first.click()
            page.wait_for_timeout(250)
            return True

        def select_model(name: str) -> bool:
            page.locator(".picker-trigger").click()
            page.wait_for_selector(".picker-menu", timeout=10000)
            page.fill(".picker-search", name)
            page.wait_for_timeout(500)
            row = page.locator(".picker-row", has_text=name)
            if row.count() == 0:
                page.keyboard.press("Escape")
                return False
            row.first.click()
            page.wait_for_timeout(500)
            return True

        def send(prompt: str) -> dict | None:
            before = len(bodies)
            close_panel()
            page.fill(".composer-shell textarea", prompt)
            # The send button is disabled while a previous turn is in flight, and clicking a
            # disabled button times out rather than failing fast.
            page.wait_for_function(
                "() => { const b = document.querySelector('.send-btn'); return b && !b.disabled }",
                timeout=30000,
            )
            page.locator(".send-btn").click()
            page.wait_for_timeout(3000)
            return bodies[-1] if len(bodies) > before else None

        def chips(row_label: str) -> list[str]:
            row = page.locator(".genopts-row", has_text=row_label.upper())
            if row.count() == 0:
                return []
            return [c.inner_text().strip() for c in row.first.locator(".genopts-chip").all()]

        # ================= VIDEO: duration =================
        enter_mode("Video")
        if not select_model("seedance-2.5"):
            fails.append("seedance-2.5 is not in the picker — cannot exercise the 30s case")
        else:
            open_panel()
            offered = chips("length")
            print(f"seedance-2.5 lengths: {offered}")
            if not pick("length", "30s"):
                fails.append(f"30s is not offered for seedance-2.5: {offered}")
            close_panel()

            # Now switch to a model whose ceiling is 12. The panel will redraw correctly; the
            # question is what the BODY carries.
            if select_model("sora-2"):
                open_panel()
                after = chips("length")
                print(f"sora-2 lengths (panel): {after}")
                close_panel()
                body = send("a calm sea")
                if body is None:
                    fails.append("no video quote captured after switching to sora-2")
                else:
                    got = body.get("duration_seconds")
                    print(f"  sora-2 body: duration_seconds={got}  model={body.get('model')}")
                    allowed = VIDEO_LIMITS["azure/sora-2"]["durations"]
                    if got not in allowed:
                        fails.append(
                            f"duration_seconds={got} sent to {body.get('model')}, which accepts only "
                            f"{allowed} — the value chosen under seedance-2.5 survived the model "
                            "switch and will be rejected after the charge is approved"
                        )
                    if "resolution" in body:
                        fails.append(
                            f"resolution={body['resolution']!r} sent to sora-2, which ignores "
                            "resolution entirely"
                        )
            else:
                fails.append("sora-2 is not in the picker — cannot exercise the ceiling case")

        # ================= VIDEO: resolution =================
        if select_model("seedance-2.0") and True:
            open_panel()
            res = chips("resolution")
            print(f"seedance-2.0 resolutions: {res}")
            picked_4k = pick("resolution", "4K")
            close_panel()
            if not picked_4k:
                print("  (4K not offered here; skipping the 4K carry-over case)")
            elif select_model("seedance-2.0-fast"):
                open_panel()
                print(f"2.0-fast resolutions (panel): {chips('resolution')}")
                close_panel()
                body = send("a city at night")
                if body is None:
                    fails.append("no video quote captured after switching to 2.0-fast")
                else:
                    got = body.get("resolution")
                    print(f"  2.0-fast body: resolution={got}  model={body.get('model')}")
                    allowed = VIDEO_LIMITS["bytedance/seedance-2.0-fast"]["resolutions"]
                    if got is not None and got not in allowed:
                        fails.append(
                            f"resolution={got!r} sent to {body.get('model')}, which reaches only "
                            f"{allowed} — 4K was chosen under 2.0 and carried over"
                        )

        # ================= SPEECH: voice family =================
        #
        # The expensive one. A cross-family voice settles the payment and is THEN refused.
        enter_mode("Speech")
        if not select_model("elevenlabs"):
            print("  (no elevenlabs model in the picker; skipping the cross-family case)")
        else:
            open_panel()
            vs = chips("voice")
            print(f"elevenlabs voices (panel): {vs[:4]} … ({len(vs)})")
            # Pick anything other than the default so the value is definitely in state.
            picked = None
            for candidate in ("George", "Roger", "Sarah"):
                if pick("voice", candidate):
                    picked = candidate
                    break
            close_panel()
            print(f"  picked voice: {picked}")
            if picked is None:
                fails.append(f"could not pick any ElevenLabs voice from {vs[:6]}")
            else:
                # Switch to an OpenAI-family speech model.
                switched = None
                for name in ("openai/gpt-4o-mini-tts", "openai/tts", "gpt-4o-mini-tts", "openai"):
                    if select_model(name):
                        switched = name
                        break
                if switched is None:
                    print("  (no openai speech model in the picker; cross-family case not run)")
                else:
                    open_panel()
                    print(f"after switch, voices (panel): {chips('voice')[:4]}")
                    close_panel()
                    body = send("hello there")
                    if body is None:
                        fails.append("no speech quote captured after the family switch")
                    else:
                        voice = body.get("voice")
                        model = str(body.get("model", ""))
                        print(f"  body: model={model} voice={voice!r} speed={body.get('speed')}")
                        if voice in ELEVENLABS_IDS and "elevenlabs" not in model.lower():
                            fails.append(
                                f"voice={voice!r} (ElevenLabs) sent to {model} — this does NOT 400: "
                                "the payment settles on-chain and the upstream then refuses, so the "
                                "money is lost as well as the call"
                            )
                        if voice in OPENAI_IDS and "elevenlabs" in model.lower():
                            fails.append(
                                f"voice={voice!r} (OpenAI) sent to {model} — same paid-then-refused "
                                "case in the other direction"
                            )

        # ================= SPEECH: speed range =================
        if select_model("openai"):
            enter_mode("Speech") if page.locator(".genopts").count() == 0 else None
            open_panel()
            sp = chips("speed")
            print(f"openai speeds: {sp}")
            fast = pick("speed", "1.5×")
            close_panel()
            if fast:
                for name in ("elevenlabs/turbo-v2.5", "elevenlabs"):
                    if select_model(name):
                        break
                open_panel()
                print(f"elevenlabs speeds (panel): {chips('speed')}")
                close_panel()
                body = send("hello again")
                if body is None:
                    print("  (no speech quote captured for the speed case)")
                else:
                    speed = body.get("speed")
                    model = str(body.get("model", ""))
                    print(f"  body: model={model} speed={speed}")
                    if "elevenlabs" in model.lower() and speed is not None and speed > 1.2:
                        fails.append(
                            f"speed={speed} sent to {model}, which documents 0.7–1.2 — chosen under "
                            "the OpenAI family and carried over"
                        )

        browser.close()

    print()
    print(f"bodies captured: {len(bodies)}")
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    if len(bodies) == 0:
        # A zero sample is never a pass. Nothing was sent, so nothing was checked.
        print("FAIL: not one request body was captured — this probe proved nothing")
        return 1
    print(f"PASS: every option in {len(bodies)} captured bodies was valid for the model being called")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
