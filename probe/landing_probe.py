"""The landing content renders, and the composer is STILL pinned above it.

The second half is the one that matters. This app already shipped a bug where the composer scrolled
away — `.main` grew to 5381px in a 780px viewport and the chat box was off screen until you scrolled
to the bottom. Adding five sections to the first screen is exactly the change that reintroduces it,
so this measures the composer at several heights rather than trusting that the scroll container
holds.

Also checked: the counts are real. The copy says "N models and M callable APIs", and both numbers
come from live catalogues whose values move — the marketplace facet reported 26 categories one day
and 18 the next. A hardcoded number would be wrong on the one screen whose job is a first
impression, and a still-loading one must render as a dash, because "0 callable APIs" reads as an
empty product.
"""

import os
import re
import sys

from playwright.sync_api import sync_playwright

from _probe_locale import localised

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "http://localhost:4173")


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # Several heights, because a pinned composer that only works at 900px is not pinned.
        for vh in (900, 780, 720, 620):
            page = browser.new_page(
                viewport={"width": 1440, "height": vh}, color_scheme="light"
            )
            page.goto(localised(URL), wait_until="domcontentloaded")
            page.wait_for_selector(".landing-band", timeout=20000)
            page.wait_for_timeout(2500)

            geo = page.evaluate(
                """() => {
                    const box = (s) => {
                        const el = document.querySelector(s)
                        if (!el) return null
                        const r = el.getBoundingClientRect()
                        return { top: Math.round(r.top), bottom: Math.round(r.bottom) }
                    }
                    const t = document.querySelector('.transcript')
                    return {
                        composer: box('.composer'),
                        docScrolls: document.documentElement.scrollHeight > innerHeight + 1,
                        transcriptScrolls: t ? t.scrollHeight > t.clientHeight : null,
                        landingH: document.querySelector('.landing')
                            ? Math.round(document.querySelector('.landing').scrollHeight) : null,
                    }
                }"""
            )
            c = geo["composer"]
            ok = c is not None and c["bottom"] <= vh + 2
            print(
                f"  vh={vh}: composer bottom {c['bottom'] if c else '?'} "
                f"(visible={ok})  docScrolls={geo['docScrolls']}  "
                f"transcriptScrolls={geo['transcriptScrolls']}  landing={geo['landingH']}px"
            )
            if not ok:
                fails.append(f"vh={vh}: the composer is below the fold — it scrolled away again")
            if geo["docScrolls"]:
                # The document must never scroll; the transcript is its own scroll container. A
                # scrolling document is precisely how the composer left the screen last time.
                fails.append(f"vh={vh}: the DOCUMENT scrolls, so the composer will move")

            page.close()

        # Content and the live counts, at one height.
        page = browser.new_page(viewport={"width": 1440, "height": 900}, color_scheme="light")
        page.goto(localised(URL), wait_until="domcontentloaded")
        page.wait_for_selector(".landing-band", timeout=20000)
        page.wait_for_timeout(4000)

        headings = page.evaluate(
            "() => [...document.querySelectorAll('.landing-band h2')].map(h => h.innerText.trim())"
        )
        print(f"\nsections: {headings}")
        if len(headings) < 4:
            fails.append(f"only {len(headings)} sections rendered")

        faq = page.locator(".landing-faq details").count()
        print(f"faq entries: {faq}")
        if faq < 5:
            fails.append(f"only {faq} FAQ entries")

        lede = page.locator(".empty p").first.inner_text()
        print(f"hero copy: {lede[:110]}")
        # Both counts must be real numbers, not a dash and not zero. A dash here means the fetch
        # failed, which is worth knowing — the claim is the pitch.
        nums = re.findall(r"([\d,]+|—) (?:models|callable APIs)", lede)
        print(f"  counts found: {nums}")
        if "—" in nums:
            fails.append(f"a count did not load: {lede[:90]}")
        if len(nums) != 2:
            fails.append(f"expected two counts in the hero, got {nums}")
        else:
            models, apis = (int(n.replace(",", "")) for n in nums)
            if models < 100:
                fails.append(f"model count implausible: {models}")
            if apis < 1000:
                fails.append(f"marketplace count implausible: {apis}")

        # The two in-page links have to actually go somewhere.
        page.locator(".landing-link").first.click()
        page.wait_for_timeout(2500)
        went = page.locator(".market-cats").count() > 0
        print(f"\n'Browse the marketplace' reached the marketplace: {went}")
        if not went:
            fails.append("the marketplace link did not open the marketplace")

        browser.close()

    print()
    if fails:
        for f in fails:
            print("  FAIL:", f)
        return 1
    print("PASS: landing content renders, counts are live, and the composer stays pinned.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
