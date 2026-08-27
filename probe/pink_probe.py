"""Are any rendered surfaces pink, and does the main site have anything like them?

The report is "don't use AI pink, match jarvisclaw's palette". The tokens in styles.css are all
blue, so reading them would say there is no pink — and I have been wrong that exact way before:
comparing my own copy of the tokens against itself always agrees.

So this samples PIXELS through a canvas. Every colour is read back from a rendered element and
converted to hue, which is the only measurement that can distinguish "the token is blue" from
"the surface looks pink".

Hue reference: red 0, magenta ~300-340, pink ~330-350, blue ~220-260. A surface whose hue sits
between 280 and 360 with any real saturation is what someone calls pink.
"""

import os
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DUCAT = os.environ.get("CHAT_URL", "http://localhost:4173")
MAIN = os.environ.get("MAIN_URL", "https://api.jarvisclaw.ai/en/sign-in")

SAMPLE_JS = r"""
() => {
  // Rendered colours go through canvas because getComputedStyle returns whatever colour space
  // the author wrote (oklch here), and comparing oklch strings to rgb strings makes every pair
  // look different. Canvas normalises both to sRGB bytes.
  const cv = document.createElement('canvas')
  const ctx = cv.getContext('2d')
  const toRgb = (css) => {
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    const v = ctx.fillStyle
    if (v.startsWith('#')) {
      return [parseInt(v.slice(1,3),16), parseInt(v.slice(3,5),16), parseInt(v.slice(5,7),16)]
    }
    const m = v.match(/[\d.]+/g)
    return m ? [+m[0], +m[1], +m[2]] : null
  }
  const hsl = ([r,g,b]) => {
    r/=255; g/=255; b/=255
    const mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx-mn
    let h = 0
    if (d) {
      if (mx===r) h = ((g-b)/d) % 6
      else if (mx===g) h = (b-r)/d + 2
      else h = (r-g)/d + 4
      h *= 60
      if (h < 0) h += 360
    }
    const l = (mx+mn)/2
    const s = d === 0 ? 0 : d/(1-Math.abs(2*l-1))
    return [Math.round(h), Math.round(s*100), Math.round(l*100)]
  }

  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    for (const prop of ['backgroundColor','borderTopColor','color']) {
      const raw = cs[prop]
      if (!raw || raw === 'rgba(0, 0, 0, 0)' || raw === 'transparent') continue
      const rgb = toRgb(raw)
      if (!rgb) continue
      const [h,s,l] = hsl(rgb)
      // Only surfaces with enough saturation to read as a colour at all.
      if (s < 6) continue
      const key = prop + '|' + h + '|' + s + '|' + l
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ prop: prop, hue: h, sat: s, light: l,
                 cls: (el.className || '').toString().slice(0, 40),
                 tag: el.tagName.toLowerCase() })
    }
  }
  return out
}
"""


def pinkish(c):
    """Magenta through pink, with the lightness band that makes hue meaningful at all.

    The first version of this gate was `280 <= hue <= 360 and sat >= 8`, and it was useless: it
    reported 8 pink surfaces on the main site and 0 on ducat — the exact opposite of what is on
    screen. Every one of those 8 was a near-black red (`hue 359 sat 99 light 19` is rgb(96,0,2))
    or literal black, where hue is numerically defined and visually absent. `rgb(0,0,0)` came back
    as "hue 360 sat 100" because my own HSL conversion divides by zero at l=0.

    So: hue and saturation are only evidence between roughly 12% and 96% lightness. Outside that
    band a colour reads as black or white regardless of its hue, and admitting it turns this probe
    into a random-number generator with opinions.

    Pink also excludes true red (<330 lower bound would admit crimson): the complaint is a pink
    TINT on light surfaces, so the band that matters is magenta-to-rose at high lightness.
    """
    return 285 <= c["hue"] <= 355 and c["sat"] >= 10 and 12 <= c["light"] <= 96


def sample(page, url, label, prep=None):
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(7000 if "jarvisclaw.ai" in url else 2500)
    if prep:
        prep(page)
    colours = page.evaluate(SAMPLE_JS)
    pink = [c for c in colours if pinkish(c)]
    print(f"\n== {label} ==")
    print(f"   distinct saturated colours: {len(colours)}   pinkish: {len(pink)}")
    for c in pink[:14]:
        print(
            f"     hue {c['hue']:>3} sat {c['sat']:>3} light {c['light']:>3}  "
            f"{c['prop']:16s} <{c['tag']}> {c['cls']}"
        )
    return colours, pink


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        # BOTH sites in the same theme, forced. The first run compared ducat's light theme against
        # the main site's dark one and the colour sets were incomparable — every dark surface reads
        # as a different hue from its light counterpart, so the diff was noise.
        #
        # `color_scheme` is what settles it: both apps default to light via the same
        # `vite-ui-theme` cookie, but a headless browser advertises `prefers-color-scheme: dark`
        # and the main site honours it. Pinning the media query makes the comparison meaningful.
        page = browser.new_page(viewport={"width": 1440, "height": 950}, color_scheme="light")

        # The marketplace, which is the screen in the report.
        def open_market(pg):
            try:
                pg.get_by_role("button", name="Marketplace").first.click()
                pg.wait_for_timeout(3500)
            except Exception as e:
                print("   (could not open marketplace:", e, ")")

        ducat, ducat_pink = sample(page, DUCAT, "ducat — marketplace", open_market)
        main_c, main_pink = sample(page, MAIN, "jarvisclaw.ai — the main site")

        browser.close()

    print()
    print(f"ducat pinkish surfaces: {len(ducat_pink)}")
    print(f"main  pinkish surfaces: {len(main_pink)}")
    if ducat_pink and not main_pink:
        print("\n  FINDING: ducat renders pink surfaces the main site has none of.")
        return 1
    if not ducat_pink:
        print("\n  no pink measured on ducat — the tint comes from somewhere this does not sample")
    return 0


if __name__ == "__main__":
    sys.exit(main())
