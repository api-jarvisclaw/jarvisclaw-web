"""Compares DECORATION between the console and the chat app, on rendered pixels.

Not a token comparison: the palettes already match (verified separately). What the user
objects to is everything layered on top of the palette — permanent glows, a gradient mesh
behind the page, gradient-filled bubbles. That reads as "AI-generated" because the console
does none of it: it decorates on hover and focus, and sits flat at rest.

Measured on the live pages, because a CSS grep cannot tell an at-rest shadow from one that
only appears under :hover — and that distinction IS the complaint.
"""
import json, sys
from playwright.sync_api import sync_playwright

CONSOLE = "https://api.jarvisclaw.ai/en/sign-in"
CHAT = __import__("os").environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai/")

PROBE = """() => {
  const seen = [];
  const els = Array.from(document.querySelectorAll('*')).slice(0, 4000);
  let glow = 0, blur = 0, gradText = 0, gradBg = 0;
  for (const el of els) {
    const s = getComputedStyle(el);
    // An at-rest spread glow: `0 0 Npx` with no offset is decoration, not elevation.
    if (/(^|,)\s*(rgb|oklch|color)[^)]*\)\s+0px\s+0px\s+\d/.test(s.boxShadow)) glow++;
    if (s.backdropFilter && s.backdropFilter !== 'none') blur++;
    if (s.webkitTextFillColor === 'rgba(0, 0, 0, 0)' && /gradient/.test(s.backgroundImage)) gradText++;
    if (/linear-gradient|radial-gradient/.test(s.backgroundImage)) gradBg++;
  }
  const body = getComputedStyle(document.body);
  const before = getComputedStyle(document.body, '::before');
  return {
    glow, blur, gradText, gradBg, counted: els.length,
    bodyBg: body.backgroundImage,
    bodyBefore: before.backgroundImage.slice(0, 60),
    bodyBeforeOpacity: before.opacity,
  };
}"""

def main():
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, url in (("console", CONSOLE), ("chat", CHAT)):
            page = b.new_page(viewport={"width": 1440, "height": 900})
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            # Waits for real content, and then CHECKS it arrived.
            #
            # An unhydrated page reports zero of everything, which reads exactly like a
            # perfectly restrained design — the most misleading possible result from a probe
            # whose entire job is counting decoration. This bit me: one run reported the
            # console at 0 gradients and 0 blurs, a page I had measured at 36 and 4 moments
            # earlier. So "nothing found" is now treated as a probe failure, not a finding.
            try:
                page.wait_for_selector("button", timeout=60000)
                page.wait_for_function(
                    "() => document.querySelectorAll('*').length > 120", timeout=60000
                )
            except Exception as exc:
                print(f"   !! {name}: page never rendered ({type(exc).__name__})")
                out[name] = None
                page.close()
                continue
            page.wait_for_timeout(3000)
            v = page.evaluate(PROBE)
            if v["gradBg"] == 0 and v["blur"] == 0 and v["glow"] == 0:
                print(f"   !! {name}: zero decoration of every kind — probably not hydrated")
                v["suspect"] = True
            out[name] = v
            page.close()
        b.close()
    if any(v is None for v in out.values()):
        print("FAIL: a page did not render; the counts below prove nothing")
        return 1
    for name, v in out.items():
        print(f"== {name} ==")
        for k in ("counted", "glow", "blur", "gradText", "gradBg"):
            print(f"   {k:20} {v[k]}")
        print(f"   bodyBg               {v['bodyBg']}")
        print(f"   body::before         {v['bodyBefore']!r} opacity={v['bodyBeforeOpacity']}")

    c, k = out["console"], out["chat"]
    if c.get("suspect") or k.get("suspect"):
        print("FAIL: a reading looks unhydrated")
        return 1

    # The bar: absolute counts, not per-element density.
    #
    # I tried density first and it was the wrong metric. The console blurs 4 elements out of
    # 298 and the chat app blurs 3 out of 154 — the same handful of surfaces (an input and two
    # panels here; two inputs, a button and a popover there), all of them in categories the
    # console blurs too. Dividing by node count made the smaller page look worse for having
    # less DOM, and would have pushed me to strip a legitimate frosted sidebar to satisfy a
    # ratio. What matters is the absolute amount of decoration a viewer sees at once, and
    # whether it lands on the same KINDS of surface.
    fails = []
    for metric in ("glow", "blur"):
        verdict = "ok" if k[metric] <= max(c[metric], 4) else "TOO MUCH"
        print(f"   {metric:6} total          console {c[metric]}   chat {k[metric]}   {verdict}")
        if verdict != "ok":
            fails.append(metric)
    if k["bodyBeforeOpacity"] not in ("0", "1") or "gradient" in k["bodyBefore"]:
        fails.append("body::before mesh")
    print("PASS: decoration is no heavier than the console" if not fails
          else f"FAIL: {', '.join(fails)}")
    return 1 if fails else 0

sys.exit(main())
