"""Switching mode switches the model, and the two places that name it agree.

The bug, reported from the live site: "I switched to Music, and the model below is still the
one I chose myself — this isn't smart." Reproduced in a browser before the fix:

    picker shows : bytedance/seedance-2.0-fast
    hint says    : Music is paid per track … Using minimax/music-2.5+.

The override was correct; the display was not. Two names on screen disagreeing, with the true
one in the smaller text. So this probe reads BOTH and requires them to match — a unit test on
the shared function cannot catch the two rendering different things.

It also checks that the list narrows. Offering 334 models under Music is offering choices the
app will discard, and it is what made the picker look like it was ignoring the mode.
"""

import os
import re
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai/")

# The mode, the model to pick first, and the default that must take over. Each default was
# verified servable against the live gateway; see MODEL NOTES in src/lib/modality.ts.
CASES = [
    ("Music", "bytedance/seedance-2.0-fast", "minimax/music-2.5+"),
    ("Video", "minimax/music-2.5+", "bytedance/seedance-2.0-mini"),
    ("Image", "minimax/music-2.5+", "openai/gpt-image-2"),
    ("Speech", "bytedance/seedance-2.0-fast", "elevenlabs/turbo-v2.5"),
]


def pick(page, name: str) -> str:
    """Chooses a model by name and returns what the trigger then shows."""
    page.click(".picker-trigger")
    page.wait_for_selector("input.picker-search", timeout=10000)
    page.fill("input.picker-search", name)
    # Waits for the row rather than a fixed delay: the list re-filters on every keystroke, and
    # clicking during that window hits whatever row happened to be under the cursor. My first
    # version of this probe clicked a modality TAB and reported the picker as unchanged.
    try:
        page.wait_for_selector(f".picker-row:has-text('{name}')", timeout=10000)
        page.locator(f".picker-row:has-text('{name}')").first.click()
    except Exception:
        # Escape rather than leave the menu open over the next assertion.
        page.keyboard.press("Escape")
        return "<not found>"
    page.wait_for_timeout(400)
    return trigger_text(page)


def trigger_text(page) -> str:
    return re.sub(r"\s+", " ", page.inner_text(".picker-trigger")).strip()


def hint_model(page) -> str | None:
    """The model named in the hint, if the hint names one."""
    hint = re.sub(r"\s+", " ", page.inner_text(".hint")).strip()
    m = re.search(r"Picked (\S+?) for you", hint)
    return m.group(1) if m else None


def main() -> int:
    fails = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 860})
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".composer-shell textarea", timeout=30000)
        # The catalogue loads over the network; picking before it arrives finds no rows.
        page.wait_for_function(
            "() => document.querySelectorAll('.picker-trigger').length > 0", timeout=30000
        )
        page.wait_for_timeout=getattr(page, "wait_for_timeout")
        page.wait_for_timeout(3000)

        for mode_label, first_pick, expected in CASES:
            print(f"== {mode_label} ==")
            # Back to chat, so each case starts from the same place rather than inheriting the
            # previous mode's narrowed list.
            for other in ("Music", "Video", "Image", "Speech"):
                btn = page.get_by_role("button", name=other, exact=True)
                if btn.count() and btn.first.get_attribute("aria-pressed") == "true":
                    btn.first.click()
                    page.wait_for_timeout(250)

            shown = pick(page, first_pick)
            print(f"   picked in chat      {shown}")
            if first_pick not in shown:
                fails.append(f"{mode_label}: could not select {first_pick} (got {shown!r})")
                continue

            page.get_by_role("button", name=mode_label, exact=True).first.click()
            page.wait_for_timeout(600)

            after = trigger_text(page)
            named = hint_model(page)
            print(f"   after switching     {after}")
            print(f"   hint names          {named}")

            if expected not in after:
                # The reported bug.
                fails.append(f"{mode_label}: picker still shows {after!r}, expected {expected}")
            if "auto" not in after.lower():
                # Without this marker the swapped-in default looks like the user's own choice.
                fails.append(f"{mode_label}: no 'auto' marker on an automatic choice")
            if named is not None and named != expected:
                # The original defect's real shape: two names, disagreeing.
                fails.append(f"{mode_label}: hint says {named}, picker says {after!r}")

            # The list must narrow to models that can serve this mode.
            page.click(".picker-trigger")
            page.wait_for_selector("input.picker-search", timeout=10000)
            page.wait_for_timeout(500)
            rows = page.locator(".picker-row").count()
            placeholder = page.get_attribute("input.picker-search", "placeholder") or ""
            tabs = page.locator(".picker-tab").count()
            print(f"   rows offered        {rows}   placeholder {placeholder!r}   tabs {tabs}")
            if rows == 0:
                fails.append(f"{mode_label}: no models offered at all")
            if rows > 60:
                fails.append(f"{mode_label}: {rows} models offered — the list did not narrow")
            if tabs != 0:
                fails.append(f"{mode_label}: modality tabs still shown inside a fixed mode")
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)

            # And the user's own pick must survive when it CAN serve the mode — otherwise the
            # fix would just be a different way of ignoring them.
            shown = pick(page, expected)
            if expected not in shown:
                fails.append(f"{mode_label}: cannot select {expected} within the mode")
            elif "auto" in shown.lower():
                fails.append(f"{mode_label}: an explicit pick was still marked auto")
            print(f"   explicit pick kept  {shown}")

        browser.close()

    print()
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS: the mode drives the model, the list narrows, and both labels agree.")
    return 0


sys.exit(main())
