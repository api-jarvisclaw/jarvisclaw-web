"""Measure real contrast in a real browser, in both themes.

The unit test in src/contrast.test.ts does this arithmetically, which is right for catching a
palette regression on every commit. But it converts oklch to sRGB with its own maths and
approximates `color-mix` — so it can be self-consistently wrong. This reads the pixels the
browser actually produces.

That distinction has already bitten once: an earlier contrast probe of mine reported 17 elements
at 1.0:1 because it regex-extracted digits out of `oklch(...)` and read lightness as a red
channel. The fix then, and the method here, is to push every colour through a canvas and read the
bytes back.

Usage: python probe/contrast_probe.py [url]
"""

import os
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

import asyncio

from playwright.async_api import async_playwright

from _probe_locale import localised

URL = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai")

# Pairs of (label, foreground token or literal, background token). Chosen for what a user has to
# be able to read, not for coverage: body copy, muted hints, the money colours, and the labels on
# the brand gradient.
PAIRS = [
    ("body text", "--foreground", "--background"),
    ("muted text", "--muted-foreground", "--background"),
    ("card text", "--card-foreground", "--card"),
    ("sidebar text", "--sidebar-foreground", "--sidebar"),
    ("success (money)", "--success-text", "--card"),
    ("destructive", "--destructive-text", "--card"),
    ("highlight", "--highlight-text", "--card"),
    ("warning", "--warning-text", "--card"),
    ("accent-2", "--accent-2-text", "--card"),
]

MEASURE = """
(args) => {
  const { pairs } = args
  const cs = getComputedStyle(document.documentElement)
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const ctx = cv.getContext('2d', { willReadFrequently: true })

  // Canvas is the only reliable reader: it normalises oklch, lab, color-mix and hex alike to
  // sRGB bytes. Parsing the strings by hand is what produced a bogus 1.0:1 report once before.
  const toRgb = (value) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }

  const lum = ([r, g, b]) => {
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (fg, bg) => {
    const a = lum(fg) + 0.05, b = lum(bg) + 0.05
    return Math.max(a, b) / Math.min(a, b)
  }

  const read = (name) => name.startsWith('--') ? cs.getPropertyValue(name).trim() : name

  const results = []
  for (const [label, fgName, bgName] of pairs) {
    const fgRaw = read(fgName), bgRaw = read(bgName)
    if (!fgRaw || !bgRaw) { results.push({ label, missing: true, fgRaw, bgRaw }); continue }
    const fg = toRgb(fgRaw), bg = toRgb(bgRaw)
    results.push({ label, ratio: ratio(fg, bg), fg, bg, fgRaw, bgRaw })
  }

  // The gradient's ink, against both of its stops. A gradient is the easy place to miss this:
  // the readable end reassures you about the end that is not.
  const grad = cs.getPropertyValue('--gradient-brand')
  const stops = grad.match(/oklch\\([^)]*\\)|lab\\([^)]*\\)|rgb\\([^)]*\\)|#[0-9a-f]{3,8}/gi) || []
  const ink = toRgb(cs.getPropertyValue('--on-brand').trim())
  const gradient = stops.map((s, i) => ({ stop: i, raw: s, ratio: ratio(ink, toRgb(s)) }))

  return { results, gradient, theme: document.documentElement.className }
}
"""


# Sweeps every leaf text node on the page and flags any whose ink is close to its own background.
#
# The token pairs above only cover colours I thought to list. This catches the ones I did not —
# and it has to handle a gradient FILL, which is where my first attempt went wrong: a gradient is
# a background-IMAGE, so `backgroundColor` reads as transparent, the walk-up finds the card
# behind it, and the ink gets compared against the wrong surface. It reported "Get a wallet" at
# 1.14:1 when the button is in fact correct. So an element painted with a gradient is measured
# against that gradient's own stops.
SWEEP = """
() => {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  const rgb = (v) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = v; ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }
  const lum = ([r, g, b]) => {
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (fg, bg) => {
    const a = lum(fg) + 0.05, b = lum(bg) + 0.05
    return Math.max(a, b) / Math.min(a, b)
  }
  const stopsOf = (bgImage) => (bgImage.match(/oklch\\([^)]*\\)|lab\\([^)]*\\)|rgba?\\([^)]*\\)|#[0-9a-f]{3,8}/gi) || [])

  // The first ancestor with a real fill — a colour, or a gradient's stops.
  const surfacesOf = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const st = getComputedStyle(n)
      const stops = stopsOf(st.backgroundImage || '')
      if (stops.length > 0) return stops.map(rgb)
      const c = rgb(st.backgroundColor)
      if (c[3] > 200) return [c]
      n = n.parentElement
    }
    return [rgb(getComputedStyle(document.body).backgroundColor)]
  }

  const out = []
  for (const el of document.querySelectorAll('*')) {
    const t = (el.textContent || '').trim()
    if (!t || el.children.length > 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.opacity === '0') continue

    // Gradient TEXT: with `background-clip: text` and a transparent text-fill-color, the visible
    // ink is the gradient, not `color` — `color` is only the fallback for browsers without the
    // clip. Reading `color` here reported the wordmark at 1.00:1 while the rendered glyphs
    // measure 6.2:1 (verified by screenshotting the element and reading its pixels). So the ink
    // is taken from the element's OWN gradient stops, and the surface from its ancestor.
    const clip = st.webkitBackgroundClip || st.backgroundClip
    const fillTransparent = /rgba\\(0,\\s*0,\\s*0,\\s*0\\)|transparent/i.test(st.webkitTextFillColor || '')
    let inks
    if (clip === 'text' && fillTransparent) {
      const own = stopsOf(st.backgroundImage || '')
      if (own.length === 0) continue
      inks = own.map(rgb)
    } else {
      inks = [rgb(st.color)]
    }

    // The worst ink against the worst surface. Both are lists because either side can be a
    // gradient, and a gradient must not pass on its flattering end alone.
    const surfaces = clip === 'text' && fillTransparent
      ? surfacesOf(el.parentElement || el)
      : surfacesOf(el)
    let worst = Infinity
    for (const ink of inks) {
      for (const bg of surfaces) worst = Math.min(worst, ratio(ink, bg))
    }
    if (worst < 3) {
      out.push({ text: t.slice(0, 40), ratio: Number(worst.toFixed(2)), cls: String(el.className || '').slice(0, 32) })
    }
  }
  return out.slice(0, 15)
}
"""


async def check(page, theme: str) -> list[str]:
    await page.evaluate(
        "(t) => { document.cookie = 'vite-ui-theme=' + t + '; path=/; max-age=31536000' }", theme
    )
    await page.reload(wait_until="networkidle")
    await page.wait_for_timeout(1800)
    data = await page.evaluate(MEASURE, {"pairs": PAIRS})

    print(f"== {theme} (html class {data['theme']!r}) ==")
    failures = []
    for r in data["results"]:
        if r.get("missing"):
            print(f"   {r['label']:18} MISSING  fg={r['fgRaw']!r} bg={r['bgRaw']!r}")
            failures.append(f"{theme}: {r['label']} token missing")
            continue
        ok = r["ratio"] >= 4.5
        print(f"   {r['label']:18} {r['ratio']:5.2f}:1  {'ok' if ok else 'FAIL'}")
        if not ok:
            failures.append(f"{theme}: {r['label']} is {r['ratio']:.2f}:1, under 4.5")

    for g in data["gradient"]:
        ok = g["ratio"] >= 4.5
        print(f"   gradient stop {g['stop']}   {g['ratio']:5.2f}:1  {'ok' if ok else 'FAIL'}  {g['raw'][:34]}")
        if not ok:
            failures.append(f"{theme}: gradient stop {g['stop']} is {g['ratio']:.2f}:1")

    # Everything the pair list above does not name.
    swept = await page.evaluate(SWEEP)
    print(f"   swept every text node: {len(swept)} below 3:1")
    for x in swept:
        print(f"     {x['ratio']:5.2f}:1  {x['text']!r}  .{x['cls']}")
        failures.append(f"{theme}: {x['text']!r} is {x['ratio']}:1")
    print()
    return failures


async def main() -> int:
    failures: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1500, "height": 950})
        page = await ctx.new_page()
        await page.goto(localised(URL), wait_until="networkidle")
        await page.wait_for_timeout(1500)
        for theme in ("light", "dark"):
            failures += await check(page, theme)
        await browser.close()

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: every measured pair clears 4.5:1 in both themes, pixels not arithmetic.")
    return 0


sys.exit(asyncio.run(main()))
