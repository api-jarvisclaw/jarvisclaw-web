"""The landing page is a real page, the console is a real route, and the chat column is aligned.

Four things a unit test cannot see, each of which was a measured defect at some point in this work:

  1. **`/` is full-bleed.** The first attempt put this content in the console's empty state, where it
     rendered at 860px inside a 1fr column between a 260px rail and a 320px sidebar — a landing page
     with chat furniture either side of it. So this checks the console's shell is ABSENT at `/`.

  2. **`/chat` is shareable and Back works.** State alone would give neither. A link someone sends
     has to open the console directly, and pressing Back must return to the landing page rather than
     leaving the site.

  3. **The hero's prompt runs exactly once.** It hands off to the console, and a duplicate send is a
     second paid call nobody asked for. `send` is a useCallback that changes when the model or
     credential does, so a dependency list rather than a ref would re-fire it.

  4. **The chat column lines up with its input.** Measured before the fix, at vw=2560:

        .transcript      width 1980  left 260
        .composer-shell  width  860  left 820
        .empty           width  620  left 935

     Three widths, three left edges. Messages ran the full 1980px while the input sat in an 860px
     box a third of the way in — and a 1980px line of chat is ~250 characters, unreadable whatever
     the alignment.
"""

import os
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.environ.get("CHAT_URL", "http://localhost:4173").rstrip("/")


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, color_scheme="light")

        # --- 1. the landing page is its own page ---
        page.goto(f"{BASE}/", wait_until="domcontentloaded")
        page.wait_for_selector(".page-hero", timeout=20000)
        page.wait_for_timeout(3500)

        has_page = page.locator(".page").count() > 0
        has_shell = page.locator(".shell").count() > 0
        bands = page.locator(".page-band").count()
        faq = page.locator(".page-faq details").count()
        print(f"/      page={has_page} consoleShell={has_shell} bands={bands} faq={faq}")
        if not has_page:
            fails.append("/ did not render the landing page")
        if has_shell:
            fails.append("/ still renders the console shell — the page is not full-bleed")
        if bands < 4:
            fails.append(f"only {bands} content sections")
        if faq < 5:
            fails.append(f"only {faq} FAQ entries")

        # The counts are the pitch, so they have to be real rather than a dash.
        #
        # Matched against the SLOTS, not the whole sentence. Searching the string for an em dash
        # reported a failure on correct copy, because the prose itself contains one ("no card —
        # anything that costs money…"). The loading placeholder and an ordinary punctuation mark are
        # the same character; only the position distinguishes them.
        lede = page.locator(".page-lede").inner_text()
        print(f"       lede: {lede[:96]}")
        counts = re.findall(r"([\d,]+|—)\s+(?:models|callable APIs)", lede)
        print(f"       counts: {counts}")
        if "—" in counts:
            fails.append(f"a count did not load: {counts}")
        if len(counts) != 2:
            fails.append(f"expected two counts in the lede, found {counts}")

        # Full-bleed means the hero is centred in the VIEWPORT, not in a column offset by a rail.
        hero = page.locator(".page-hero").bounding_box()
        centre_gap = abs((hero["x"] + hero["width"] / 2) - 1440 / 2)
        print(f"       hero centre offset from viewport centre: {round(centre_gap)}px")
        if centre_gap > 4:
            fails.append(f"the hero is not centred in the viewport ({round(centre_gap)}px off)")

        # --- 2. /chat is a real route, and Back works ---
        page.goto(f"{BASE}/chat", wait_until="domcontentloaded")
        page.wait_for_selector(".shell", timeout=20000)
        page.wait_for_timeout(1500)
        print(f"/chat  consoleShell={page.locator('.shell').count() > 0} page={page.locator('.page').count() > 0}")
        if page.locator(".page").count() > 0:
            fails.append("/chat renders the landing page too")

        page.goto(f"{BASE}/", wait_until="domcontentloaded")
        page.wait_for_selector(".page-cta-sm", timeout=20000)
        page.wait_for_timeout(2000)
        page.locator(".page-cta-sm").click()
        page.wait_for_selector(".shell", timeout=20000)
        url_after = page.url
        page.go_back()
        page.wait_for_selector(".page", timeout=20000)
        url_back = page.url
        print(f"nav    forward -> {url_after}")
        print(f"       back    -> {url_back}")
        if not url_after.endswith("/chat"):
            fails.append(f"the CTA did not change the URL: {url_after}")
        if not url_back.rstrip("/").endswith(BASE.rstrip("/")):
            fails.append(f"Back did not return to the landing page: {url_back}")

        # --- 3. the hero prompt runs once ---
        page.goto(f"{BASE}/", wait_until="domcontentloaded")
        page.wait_for_selector(".page-prompt input", timeout=20000)
        page.wait_for_timeout(2000)
        page.fill(".page-prompt input", "Which models are free right now?")
        page.click(".page-prompt button")
        page.wait_for_selector(".shell", timeout=20000)
        page.wait_for_timeout(5000)
        users = page.locator(".turn-user").count()
        first = page.locator(".turn").first.inner_text().replace("\n", " ")[:70] if users else ""
        print(f"handoff user turns={users}  first={first!r}")
        if users == 0:
            fails.append("the hero prompt never reached the console")
        elif users > 1:
            fails.append(f"the hero prompt was sent {users} times — a duplicate paid call")

        page.close()

        # --- 4. alignment, at the widths where it broke ---
        for vw in (1280, 1440, 1920, 2560):
            pg = browser.new_page(viewport={"width": vw, "height": 900}, color_scheme="light")
            pg.goto(f"{BASE}/chat", wait_until="domcontentloaded")
            pg.wait_for_timeout(1200)
            # A real turn, through the app's own storage, so the real component renders it.
            pg.evaluate(
                """() => localStorage.setItem('jarvisclaw.conversations.v1', JSON.stringify([{
                    id: 'probe-align', title: 't', updatedAt: Date.now(),
                    turns: [{ kind: 'user', text: 'A long enough user message to fill the measure and show where the bubble actually ends on a wide monitor.' }],
                    history: [] }]))"""
            )
            pg.reload(wait_until="domcontentloaded")
            pg.wait_for_selector(".turn", timeout=20000)
            pg.wait_for_timeout(2000)
            geo = pg.evaluate(
                """() => {
                    const g = (s) => { const e = document.querySelector(s); if (!e) return null
                        const r = e.getBoundingClientRect()
                        return { w: Math.round(r.width), l: Math.round(r.left) } }
                    return { turn: g('.turn'), composer: g('.composer-shell') }
                }"""
            )
            t, c = geo["turn"], geo["composer"]
            if not t or not c:
                fails.append(f"vw={vw}: could not measure ({geo})")
                pg.close()
                continue
            dl = abs(t["l"] - c["l"])
            dw = abs(t["w"] - c["w"])
            print(f"align  vw={vw}: turn {t['w']}@{t['l']}  composer {c['w']}@{c['l']}  Δleft={dl} Δwidth={dw}")
            if dl > 2:
                fails.append(f"vw={vw}: the turns and the input are {dl}px out of alignment")
            if dw > 2:
                fails.append(f"vw={vw}: the turns and the input differ in width by {dw}px")
            # And the measure has to actually cap. Uncapped, a 2560px window gives a ~250-char line.
            if t["w"] > 900:
                fails.append(f"vw={vw}: a turn is {t['w']}px wide — the reading measure is not capping")
            pg.evaluate("() => localStorage.clear()")
            pg.close()

        browser.close()

    print()
    if fails:
        for f in fails:
            print("  FAIL:", f)
        return 1
    print("PASS: / is a full-bleed page, /chat is shareable, Back works, and the chat column aligns.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
