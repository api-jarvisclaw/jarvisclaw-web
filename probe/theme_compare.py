"""Compare the chat console's rendered colours against the main site's, in a real browser.

Why this exists and why it is not a string diff: I twice told the user the colours already
matched, on the strength of comparing token TEXT in the two stylesheets. They match as text and
the user still sees a difference — so the text was the wrong thing to measure.

Two ways that can happen:

  1. The main site compiles oklch() to lab() while chat ships oklch(). Same pixels, different
     strings. A canvas round-trip normalises both to sRGB bytes, which is the only comparison
     that means anything across colour spaces.
  2. The two pages resolve a DIFFERENT SET of tokens — chat is dark-only, while the main site
     picks a theme at runtime. If the main site renders its light theme by default, then every
     token I compared against `.dark` is not what a visitor actually sees.

So this reads the computed value of each variable from each live page, converts through canvas,
and reports deltas in sRGB. It also reports which theme class each page is actually using,
because that is the question the string diff could not answer.

Usage: python probe/theme_compare.py
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

MAIN = "https://api.jarvisclaw.ai/en/login"
import os
CHAT = os.environ.get("CHAT_URL", "https://chat.jarvisclaw.ai")

TOKENS = [
    "--background",
    "--foreground",
    "--card",
    "--card-foreground",
    "--popover",
    "--primary",
    "--primary-foreground",
    "--secondary",
    "--muted",
    "--muted-foreground",
    "--accent",
    "--accent-foreground",
    "--border",
    "--input",
    "--ring",
    "--destructive",
    "--success",
    "--warning",
    "--highlight",
    "--sidebar",
    "--sidebar-foreground",
    "--sidebar-accent",
    "--sidebar-border",
]

# Reads each variable and pushes it through a canvas so the answer is sRGB bytes regardless of
# whether the page authored lab(), oklch() or a hex string.
READ = """
(tokens) => {
  const cs = getComputedStyle(document.documentElement)
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  const out = {}
  for (const name of tokens) {
    const raw = cs.getPropertyValue(name).trim()
    if (raw === '') { out[name] = { raw: '', rgba: null }; continue }
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = raw
    // If the browser could not parse it, fillStyle keeps the previous value.
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    out[name] = { raw, rgba: [d[0], d[1], d[2], d[3]] }
  }
  return {
    tokens: out,
    htmlClass: document.documentElement.className,
    colorScheme: cs.getPropertyValue('color-scheme').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }
}
"""


async def read_page(ctx, url: str, theme: str | None = None) -> dict:
    page = await ctx.new_page()
    await page.goto(url, wait_until="networkidle")
    if theme is not None:
        # Both sites read the same cookie name, so one line sets the theme on either.
        await page.evaluate(
            "(t) => { document.cookie = 'vite-ui-theme=' + t + '; path=/; max-age=31536000' }",
            theme,
        )
        await page.reload(wait_until="networkidle")
    await page.wait_for_timeout(2500)
    data = await page.evaluate(READ, TOKENS)
    await page.close()
    return data


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1500, "height": 950})

        theme = os.environ.get("THEME")  # unset = whatever each site defaults to
        print(f"reading {MAIN} (theme={theme or 'default'})")
        main = await read_page(ctx, MAIN, theme)
        print(f"reading {CHAT} (theme={theme or 'default'})")
        chat = await read_page(ctx, CHAT, theme)
        await browser.close()

    print()
    print("== which theme is each page actually rendering ==")
    print(f"   main html class: {main['htmlClass']!r}  color-scheme: {main['colorScheme']!r}")
    print(f"   chat html class: {chat['htmlClass']!r}  color-scheme: {chat['colorScheme']!r}")
    print(f"   main body bg: {main['bodyBg']}")
    print(f"   chat body bg: {chat['bodyBg']}")
    print()

    same, diff, missing = [], [], []
    for name in TOKENS:
        m = main["tokens"].get(name, {})
        c = chat["tokens"].get(name, {})
        if not m.get("rgba") or not c.get("rgba"):
            missing.append((name, m.get("raw", ""), c.get("raw", "")))
            continue
        delta = max(abs(a - b) for a, b in zip(m["rgba"], c["rgba"]))
        if delta <= 1:
            same.append(name)
        else:
            diff.append((name, m, c, delta))

    print(f"== {len(same)} identical, {len(diff)} different, {len(missing)} missing ==")
    if diff:
        print()
        print("   DIFFERENT (sRGB delta, so this is a real visual difference):")
        for name, m, c, delta in sorted(diff, key=lambda x: -x[3]):
            print(f"     {name:24} delta={delta:3}")
            print(f"       main {tuple(m['rgba'])}  {m['raw'][:44]}")
            print(f"       chat {tuple(c['rgba'])}  {c['raw'][:44]}")
    if missing:
        print()
        print("   MISSING on one side (chat may simply not define it):")
        for name, mraw, craw in missing:
            print(f"     {name:24} main={mraw[:28]!r} chat={craw[:28]!r}")

    print()
    json.dump({"main": main, "chat": chat}, open("probe/theme_compare.json", "w"), indent=1)
    print("full data written to probe/theme_compare.json")
    return 0 if not diff else 1


sys.exit(asyncio.run(main()))
