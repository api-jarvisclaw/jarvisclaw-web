"""Samples real screenshot pixels, because CSS property values missed the tint entirely.

`pink_probe.py` walks every element and reads backgroundColor/color/borderColor. It found zero
pink on both sites, which contradicts a screenshot where the marketplace cards are visibly pink.
Both statements are true: the tint is not in any single property value. It is produced by
`linear-gradient(... color-mix(in oklch, var(--card) 94%, var(--glow-brand) 6%))`, and
`getComputedStyle(el).backgroundColor` for a gradient returns `rgba(0,0,0,0)` — the gradient lives
in `backgroundImage`, unresolved, as the literal `color-mix()` text.

So this measures the only thing that cannot lie: the pixels the browser painted. It screenshots a
region, averages it, and compares the result against the page's own neutral surface. A card whose
average sits measurably toward magenta from the page background IS tinted, whatever the CSS says.
"""

import io
import os
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DUCAT = os.environ.get("CHAT_URL", "http://localhost:4173")

try:
    from PIL import Image
except ImportError:
    print("needs pillow: python -m pip install pillow")
    sys.exit(2)


def avg(png_bytes):
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = im.size
    px = im.load()
    # Sampled on a grid rather than averaged whole: a card contains text, and averaging dark glyphs
    # into a light surface drags every measurement toward grey and hides the very difference being
    # measured. Only near-white pixels are kept — the surface, not what is written on it.
    keep = []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if r > 200 and g > 200 and b > 200:
                keep.append((r, g, b))
    if not keep:
        return None
    n = len(keep)
    return (
        sum(c[0] for c in keep) / n,
        sum(c[1] for c in keep) / n,
        sum(c[2] for c in keep) / n,
        n,
    )


def report(label, a):
    if a is None:
        print(f"   {label:28s} no light pixels sampled")
        return None
    r, g, b, n = a
    # Redness-vs-green and blue is what "pink" means on a white surface: red stays high while
    # green drops. A neutral surface has r ≈ g ≈ b.
    print(
        f"   {label:28s} rgb({r:6.2f},{g:6.2f},{b:6.2f})  "
        f"r-g {r - g:+5.2f}  r-b {r - b:+5.2f}  n={n}"
    )
    return (r, g, b)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 950}, color_scheme="light")
        page.goto(DUCAT, wait_until="domcontentloaded")
        page.wait_for_timeout(2000)
        page.get_by_role("button", name="Marketplace").first.click()
        page.wait_for_selector(".market-card", timeout=25000)
        page.wait_for_timeout(3000)

        print("== rendered pixels, ducat marketplace ==")
        page_bg = report("page background", avg(page.locator(".market").screenshot()))
        card = report("a marketplace card", avg(page.locator(".market-card").first.screenshot()))

        panels = {}
        for sel, name in ((".panel", "sidebar panel"), (".market-cat", "category pill")):
            loc = page.locator(sel).first
            if loc.count() > 0:
                panels[name] = report(name, avg(loc.screenshot()))

        # What the CSS says about that same card, to show why the property walk found nothing.
        css = page.evaluate(
            """() => {
                const el = document.querySelector('.market-card')
                const cs = getComputedStyle(el)
                return { backgroundColor: cs.backgroundColor,
                         backgroundImage: cs.backgroundImage.slice(0, 150) }
            }"""
        )
        print("\n== what getComputedStyle reports for that card ==")
        print(f"   backgroundColor: {css['backgroundColor']}")
        print(f"   backgroundImage: {css['backgroundImage']}")

        page.screenshot(path="probe/tint_market.png")
        browser.close()

    print()
    if card and page_bg:
        # The finding, stated as a number. On a neutral surface r-g is ~0; a pink tint pushes it up.
        print(f"card r-g {card[0] - card[1]:+.2f} vs page r-g {page_bg[0] - page_bg[1]:+.2f}")
        if card[0] - card[1] > 1.0:
            print("\n  FINDING: the card surface is measurably red-shifted — a pink tint.")
            return 1
        print("\n  the card surface is neutral within a rounding error")
    return 0


if __name__ == "__main__":
    sys.exit(main())
