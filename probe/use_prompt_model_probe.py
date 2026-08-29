""""Make your own" must load the prompt AND the model that produced it.

The defect, reported from a screenshot: a Seedance 2.0 gallery prompt loaded into the composer and
was quoted

    One video from bytedance/seedance-2.0-mini costs $0.399554

The mini is the video modality DEFAULT, not the model printed on the card. It is ~2.8x cheaper
($1.136 vs $0.40) with different parameter ceilings, so the user was shown a real price for a
model they had not chosen, and the result would not have matched the example they clicked.

`onUsePrompt` carried the prompt and the mode and dropped the model, which every card displays.

Why a browser probe on top of the source guards: the guards prove the value is threaded and that
App calls `setModel`. They cannot prove the PICKER ends up on that model — `setModel` is guarded by
`models.some(...)`, so a name the catalogue spells differently would be silently ignored and the
quote would go back to the default with nothing in the source to show it. That check needs a real
catalogue and a real render.

    python probe/serve_dist.py 4173 &
    python probe/use_prompt_model_probe.py

Deliberately stops at reading the composer's model — it never sends. A send would quote and,
with a credential, charge for someone else's example.
"""

import re
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4173").rstrip("/")

# The model the Seedance collection publishes, and the gateway id it must resolve to. Kept here
# rather than imported so the probe fails if the app's mapping changes without this being revisited.
EXPECTED = "bytedance/seedance-2.0"
# The substitution that was measured — the video modality default.
WRONG = "bytedance/seedance-2.0-mini"


def main() -> int:
    fails: list[str] = []
    checked = 0

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1500, "height": 1000})
        page = ctx.new_page()

        # /en so the run is not interpreted in the machine's own locale: a probe that reads
        # button text has to know which language it is reading.
        page.goto(f"{BASE}/en/gallery", wait_until="domcontentloaded", timeout=60000)
        # The app hydrates and then fetches the catalogue; setModel is gated on the catalogue
        # having arrived, so a probe that reads too early would see the default and blame the fix.
        page.wait_for_timeout(6000)

        # The Seedance tab. Named rather than positional — tab order is a layout decision.
        for label in ("Seedance", "SeeDance"):
            tab = page.get_by_role("button", name=re.compile(label, re.I))
            if tab.count() > 0:
                tab.first.click()
                break
        page.wait_for_timeout(2500)

        # Open the first card that has a prompt to reuse.
        cards = page.locator(".showcase-card, .seedance-card, .gallery-card")
        if cards.count() == 0:
            print("ABORT: no gallery cards rendered — the probe inspected nothing.")
            print("       Check the tab selector and that dist/ is the current build.")
            return 2
        cards.first.click()
        page.wait_for_timeout(1500)

        make = page.get_by_role("button", name=re.compile(r"Make your own", re.I))
        if make.count() == 0:
            print("ABORT: no 'Make your own' button in the detail panel — nothing to drive.")
            return 2
        make.first.click()
        page.wait_for_timeout(2500)
        checked += 1

        # What the composer will actually send. Read from the picker's rendered text, because that
        # is what the user sees and what the quote is built from.
        picker = page.locator(".model-picker, .composer .model-name, [data-model]")
        shown = ""
        if picker.count() > 0:
            shown = (picker.first.inner_text() or "").strip()
        # Fall back to the whole composer region: the picker's class may differ, and an empty
        # string here would otherwise read as "no wrong model found" — a pass on no evidence.
        if shown == "":
            composer = page.locator("form, .composer")
            shown = (composer.first.inner_text() or "").strip() if composer.count() > 0 else ""

        if shown == "":
            print("ABORT: could not read the composer's model. This is NOT a pass —")
            print("       the check had no way to observe the value it exists to verify.")
            return 2

        print(f"== composer after 'Make your own' ==\n   reads: {shown[:200]!r}")

        # The draft must have arrived too. Without it the model assertion could pass on a page
        # where nothing happened at all.
        draft = page.locator("textarea")
        text = (draft.first.input_value() or "").strip() if draft.count() > 0 else ""
        if len(text) < 40:
            fails.append(f"the prompt did not reach the composer (draft is {len(text)} chars)")
        else:
            print(f"   draft: {len(text)} chars")

        if WRONG in shown:
            fails.append(f"composer is on {WRONG} — the modality default, not the card's model")
        elif EXPECTED in shown:
            print(f"   OK: composer is on {EXPECTED}")
        else:
            # Neither string present. Reported as a failure, not ignored: the point of the fix is
            # that the model is pinned, and an unrecognised value means it was not.
            fails.append(
                f"composer shows neither {EXPECTED} nor {WRONG}; cannot confirm the model was "
                f"pinned. Read: {shown[:120]!r}"
            )

        page.screenshot(path="probe/use_prompt_model.png", full_page=False)
        browser.close()

    if checked == 0:
        print("ABORT: nothing was driven. A run that clicked nothing is not a pass.")
        return 2

    print()
    if fails:
        print(f"FAIL — {len(fails)} problem(s) across {checked} card(s):")
        for f in fails:
            print(f"  - {f}")
        return 1
    print(f"PASS — {checked} card(s): prompt and model both reached the composer.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
