"""The brand mark, the resizable panes, and the top navigation.

Three requests, none of which a unit test can see:

  1. **One mark everywhere.** The tab icon and the rail's logo were both drawn rather than loaded —
     a gradient chip in the rail, a solid square on the landing page, and no favicon at all, which
     browsers answer with a letter tile. So one product showed three different marks and none of them
     was the logo. Checked by fetching what the markup points at and asserting it is a real image,
     because a broken `src` renders as nothing and looks exactly like the chip it replaced.

  2. **Both side panes drag.** They were `260px` and `320px` written into the grid. This drags each
     handle and asserts the pane followed, the transcript absorbed the difference, and the width
     survives a reload — a pane width that resets is a preference nobody can actually set.

  3. **A real top nav.** Every destination used to live in the left rail, so with the rail collapsed
     the console had no navigation at all. The nav items are checked to be real links with hrefs the
     router resolves, not buttons — a nav item that cannot be middle-clicked or copied is a button
     wearing a link's clothes.
"""

import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

from _probe_locale import localised

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.environ.get("CHAT_URL", "http://localhost:4173").rstrip("/")


def box(page, selector):
    """The bounding box of one element, or None. Read via JS so a missing node is not an exception."""
    return page.evaluate(
        """(sel) => {
            const el = document.querySelector(sel)
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { x: Math.round(r.x), w: Math.round(r.width) }
        }""",
        selector,
    )


# Half the handle's 6px width.
#
# A drag begins at the handle's CENTRE, while the pane's width is measured to the handle's near edge —
# so a drag of dx moves the pane by dx plus this offset, every time. Measured as exactly 3px on both
# panes, which is what identified it as the grab offset rather than drift.
#
# Stated here rather than hidden in a loose tolerance, because the two are different claims. A ±6px
# tolerance would also accept a genuine 4px drift, and drift is the failure that absolute measurement
# exists to prevent: a delta-accumulating handler slips further from the pointer on every clamp.
GRAB_OFFSET = 3


def drag(page, selector, dx):
    """Drags one handle by dx pixels, using real pointer events."""
    handle = page.locator(selector)
    b = handle.bounding_box()
    if b is None:
        return False
    cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    # Two moves, not one. A single jump from press to release is dispatched as one pointermove and
    # would pass even if the handler only ever read the final position — which is what an
    # implementation that ignores intermediate moves looks like from the outside.
    page.mouse.move(cx + dx / 2, cy, steps=4)
    page.mouse.move(cx + dx, cy, steps=4)
    page.mouse.up()
    page.wait_for_timeout(150)
    return True


def main() -> int:
    fails = []

    # --- 1. the mark is a real image the server actually serves ---
    for path, label in [("/jc.png", "tab icon"), ("/jc-512.png", "touch icon")]:
        try:
            # A browser User-Agent, because the default one is refused in production. Cloudflare's bot
            # protection 403s `Python-urllib/3.x` while serving the identical bytes to curl and to
            # Chrome — so against the deployed site this reported a broken favicon that was never
            # broken, and would have done so for every asset check added here later.
            req = urllib.request.Request(
                f"{BASE}{path}",
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
                    )
                },
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                head = r.read(8)
                size = int(r.headers.get("content-length") or 0)
                ctype = r.headers.get("content-type", "")
            png = head.startswith(b"\x89PNG")
            print(f"asset  {path:12} {r.status} {ctype} {size}B png={png}")
            if not png:
                fails.append(f"{label} at {path} is not a PNG")
        except Exception as e:  # noqa: BLE001
            fails.append(f"{label} at {path} did not load: {e}")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 900}, color_scheme="light")

        # Entered the way a visitor does: the landing page first, then into the console.
        #
        # NOT a direct `goto('/chat')`, and that is the difference between testing the product and
        # testing the harness. A fresh tab opened straight at /chat has one history entry, so `go_back`
        # leaves for `about:blank` — which looks exactly like a broken Back button and is nothing of the
        # kind. The nav check below only means anything if there is somewhere to go back TO.
        #
        # `wait_until='load'` for the same class of reason: with `domcontentloaded` the page's own load
        # event is still pending, so a later listener catches it and blames whatever was clicked in
        # between for a reload that never happened. It cost me one false failure here already.
        page.goto(localised(BASE, "/"), wait_until="load")
        page.wait_for_selector(".page-hero", timeout=20000)
        page.wait_for_timeout(2500)
        page.click(".page-cta-sm")
        page.wait_for_selector(".shell", timeout=20000)
        page.wait_for_timeout(2000)

        # The bar's mark must be an <img> that DECODED, not merely an element that exists. A wrong
        # path leaves naturalWidth at 0 and renders nothing — indistinguishable from the chip it
        # replaced, and the reason this checks pixels rather than the attribute.
        mark = page.evaluate(
            """() => {
                const el = document.querySelector('.topbar-brand .brand-mark')
                if (!el) return null
                return {
                    tag: el.tagName,
                    src: el.getAttribute('src'),
                    natural: el.naturalWidth || 0,
                    shown: Math.round(el.getBoundingClientRect().width),
                }
            }"""
        )
        print(f"mark   {mark}")
        if not mark or mark["tag"] != "IMG":
            fails.append("the top bar's brand mark is not an image")
        elif mark["natural"] == 0:
            fails.append(f"the top bar's brand mark did not decode (src={mark['src']})")

        # --- 1b. the bar is GLOBAL: it spans the window and sits above every pane ---
        #
        # This is the whole complaint. Rendered inside `.main` the bar began after the rail's right
        # border and stopped at the sidebar's left one — measured at 1600px as x=360..1280 of a 1600px
        # window, cut into thirds by two vertical rules. Checked as geometry rather than as "the element
        # exists", because the broken version had the element too.
        span = page.evaluate(
            """() => {
                const bar = document.querySelector('.topbar').getBoundingClientRect()
                const q = (s) => { const e = document.querySelector(s)
                                   if (!e) return null
                                   const r = e.getBoundingClientRect()
                                   return { top: Math.round(r.top), left: Math.round(r.left) } }
                return {
                  left: Math.round(bar.left), right: Math.round(bar.right),
                  bottom: Math.round(bar.bottom), vw: window.innerWidth,
                  rail: q('.rail'), sidebar: q('.sidebar'), main: q('.main'),
                }
            }"""
        )
        print(
            f"span   bar x={span['left']}..{span['right']} of {span['vw']}"
            f"  bottom={span['bottom']}  rail.top={span['rail']['top']}"
            f" sidebar.top={span['sidebar']['top']}"
        )
        if span["left"] != 0 or span["right"] != span["vw"]:
            fails.append(
                f"the bar spans {span['left']}..{span['right']} of a {span['vw']}px window, not edge to edge"
            )
        # Every pane must start BELOW it. A bar that overlaps a pane is floating over the layout rather
        # than being part of it, and the pane's first row of content ends up underneath it.
        for name in ("rail", "sidebar", "main"):
            pane = span[name]
            if pane and pane["top"] < span["bottom"]:
                fails.append(f"the {name} starts at y={pane['top']}, above the bar's bottom edge")
        # The brand is at the window's left edge, not indented to where the middle column used to start.
        brand_left = page.evaluate(
            "() => Math.round(document.querySelector('.topbar-brand').getBoundingClientRect().left)"
        )
        print(f"brand  left={brand_left}")
        if brand_left > 40:
            fails.append(f"the brand sits {brand_left}px in, so the bar is still indented")

        # And it survives the rail being collapsed — the state in which the console previously had no
        # navigation at all, because every destination lived in the pane that had just been hidden.
        page.click(".rail-toggle")
        page.wait_for_timeout(500)
        closed = page.evaluate(
            """() => {
                const bar = document.querySelector('.topbar').getBoundingClientRect()
                return { left: Math.round(bar.left), right: Math.round(bar.right),
                         vw: window.innerWidth,
                         navItems: document.querySelectorAll('.topnav .topnav-item').length,
                         brand: !!document.querySelector('.topbar-brand'),
                         railPresent: !!document.querySelector('.rail') }
            }"""
        )
        print(
            f"closed railPresent={closed['railPresent']} bar x={closed['left']}..{closed['right']}"
            f" of {closed['vw']} nav={closed['navItems']} brand={closed['brand']}"
        )
        # The precondition for everything below it. The key was named `rail` and read "is it present",
        # so `if closed['rail']` meant "fail when the rail IS gone" — the exact opposite, and it passed
        # by reporting a working toggle as fine for the wrong reason. Without this check a toggle that
        # silently stopped working would leave the three assertions below testing the open state.
        if closed["railPresent"]:
            fails.append("the rail toggle did not close the rail, so the collapsed state is untested")
        if closed["navItems"] < 4 or not closed["brand"]:
            fails.append("collapsing the rail took the navigation or the brand with it")
        if closed["left"] != 0 or closed["right"] != closed["vw"]:
            fails.append("the bar stopped spanning the window once the rail closed")
        page.click(".rail-toggle")
        page.wait_for_timeout(500)

        # --- 2. the top nav exists, and its items are real links ---
        items = page.evaluate(
            """() => [...document.querySelectorAll('.topnav .topnav-item')].map((a) => ({
                label: a.textContent.trim(),
                tag: a.tagName,
                href: a.getAttribute('href'),
                external: a.target === '_blank',
            }))"""
        )
        print(f"topnav {len(items)} items")
        for it in items:
            print(f"       {it['label']:14} <{it['tag'].lower()}> href={it['href']} ext={it['external']}")
        if len(items) < 4:
            fails.append(f"the console top nav has only {len(items)} items")
        for it in items:
            if it["tag"] != "A" or not it["href"]:
                fails.append(f"nav item {it['label']!r} is not a real link")

        # The bar stays one row at every width.
        #
        # Measured when the nav first moved in here: at 1280px flex handed the shortfall to whatever
        # could give, "free · no sign-in" and "New chat" each broke onto a second line, and the topbar
        # went from 65px to 85px. That 20px comes out of the transcript — the bar is `flex: none` inside
        # the pinned frame — and it only happens at the widths where the items happen not to fit, which
        # is how it survives a check at one size.
        for vw in (1024, 1280, 1600, 2560):
            page.set_viewport_size({"width": vw, "height": 900})
            page.wait_for_timeout(400)
            bar = page.evaluate(
                "() => Math.round(document.querySelector('.topbar').getBoundingClientRect().height)"
            )
            scrolls = page.evaluate(
                """() => { const n = document.querySelector('.topnav')
                           return n ? n.scrollWidth > n.clientWidth + 1 : false }"""
            )
            print(f"bar    vw={vw:5} topbar={bar}px navScrolls={scrolls}")
            if bar > 70:
                fails.append(f"the topbar wrapped to {bar}px at vw={vw}")
        page.set_viewport_size({"width": 1600, "height": 900})
        page.wait_for_timeout(400)

        # An internal nav item must switch the pane WITHOUT a reload. A reload would refetch the bundle,
        # discard the model catalogue, and lose an in-flight generation — including a paid one still
        # being polled, which is the only on-screen record of a charge.
        #
        # Checked with a value planted on `window` rather than by listening for a load event. A load
        # listener catches the page's own pending load and reports a reload that never happened; a
        # planted token can only survive if the document did.
        page.evaluate("window.__probeToken = 'alive'")
        page.click(".topnav-item[href='/marketplace']")
        page.wait_for_timeout(1200)
        survived = page.evaluate("window.__probeToken") == "alive"
        print(f"nav    -> {page.url}  sameDocument={survived}")
        if not survived:
            fails.append("clicking a nav item reloaded the document")
        if page.url.rstrip("/") != f"{BASE}/marketplace":
            fails.append(f"the marketplace nav item left the URL at {page.url}")

        # A pane switch must not deepen the history. Marketplace then Gallery then chat would otherwise
        # bury the landing page three entries down, so Back — which everywhere else leaves the section —
        # would walk backwards through the panes instead. This is what replaceState buys.
        depth = page.evaluate("history.length")
        page.click(".topnav-item[href='/gallery']")
        page.wait_for_timeout(1000)
        after_depth = page.evaluate("history.length")
        print(f"depth  {depth} -> {after_depth} after a second pane switch")
        if after_depth != depth:
            fails.append(f"switching pane pushed a history entry ({depth} -> {after_depth})")

        # Back must leave the console for the landing page, not walk backwards through the panes. A
        # pane switch uses replaceState precisely so that Back keeps meaning "the page I came from".
        page.go_back()
        page.wait_for_timeout(900)
        print(f"back   -> {page.url}  landing={page.locator('.page-hero').count() > 0}")
        if page.locator(".page-hero").count() == 0:
            fails.append("Back from a console pane did not reach the landing page")

        # --- 2b. the landing bar, at every width ---
        #
        # Its own checks, because it fails differently from the console's. Two measured defects here:
        # at 768px the CTA wrapped and took the sticky bar to 85px, dropping its border partway down the
        # hero; and below 720px a pre-existing `display: none` on the whole nav — correct when every
        # item was an in-page anchor — hid Marketplace, Gallery and Docs as well, leaving a phone
        # visitor no route to any of them.
        page.goto(localised(BASE, "/"), wait_until="load")
        page.wait_for_selector(".page-hero", timeout=20000)
        page.wait_for_timeout(2500)
        for vw in (390, 560, 720, 768, 1280, 2560):
            page.set_viewport_size({"width": vw, "height": 900})
            page.wait_for_timeout(400)
            m = page.evaluate(
                """() => {
                    const bar = document.querySelector('.page-nav')
                    const nav = bar.querySelector('nav')
                    const cta = document.querySelector('.page-cta-sm').getBoundingClientRect()
                    return {
                      bar: Math.round(bar.getBoundingClientRect().height),
                      // Visible items only. A zero-width link is present in the DOM and reachable by
                      // nobody, which is the exact state the old breakpoint produced.
                      visible: [...nav.querySelectorAll('a')]
                        .filter((a) => a.getBoundingClientRect().width > 0)
                        .map((a) => a.textContent.trim()),
                      ctaRight: Math.round(cta.right),
                      vw: window.innerWidth,
                    }
                }"""
            )
            print(f"page   vw={vw:5} bar={m['bar']}px items={len(m['visible'])} cta={m['ctaRight']}/{m['vw']}")
            if m["bar"] > 70:
                fails.append(f"the landing nav wrapped to {m['bar']}px at vw={vw}")
            if m["ctaRight"] > m["vw"]:
                fails.append(f"the landing CTA overflowed the viewport at vw={vw}")
            # The destinations must survive every width. The anchors may be dropped — they point at
            # sections a narrow screen can still scroll to.
            for needed in ("Marketplace", "Gallery", "Docs"):
                if needed not in m["visible"]:
                    fails.append(f"{needed!r} is not reachable from the landing nav at vw={vw}")
        page.set_viewport_size({"width": 1600, "height": 900})
        page.wait_for_timeout(400)

        # --- 3. both panes drag, and the width sticks ---
        page.goto(localised(BASE, "/chat"), wait_until="load")
        page.wait_for_selector(".pane-resizer-rail", timeout=20000)
        page.wait_for_timeout(2000)

        before_rail = box(page, ".rail")
        before_main = box(page, ".main")
        drag(page, ".pane-resizer-rail", 90)
        after_rail = box(page, ".rail")
        after_main = box(page, ".main")
        want_rail = before_rail["w"] + 90 + GRAB_OFFSET
        print(
            f"rail   {before_rail['w']} -> {after_rail['w']} (want ~{want_rail})"
            f"   main {before_main['w']} -> {after_main['w']}"
        )
        if abs(after_rail["w"] - want_rail) > 1:
            fails.append(
                f"the rail did not follow the pointer: {before_rail['w']} -> {after_rail['w']}, expected ~{want_rail}"
            )
        # The transcript has to give up the space the pane took. If both grew, something is overflowing
        # the grid rather than sharing it — which is how a "resizable" pane pushes the composer offscreen.
        if after_main["w"] >= before_main["w"]:
            fails.append("widening the rail did not narrow the main column")

        before_side = box(page, ".sidebar")
        # Leftward, because the sidebar grows as the pointer moves toward the middle.
        #
        # Asserted as "the pane TRACKS the pointer", within a couple of pixels — not as "it grew by at
        # least some amount". A magnitude-only check is what let a mutation past: reversing the
        # measurement so the sidebar reads from the left edge made it jump to 448px, which is more than
        # 80px of growth and passed a threshold test cleanly. The pane has to end up where the pointer
        # left the handle, and only exact tracking says that.
        drag(page, ".pane-resizer-sidebar", -80)
        after_side = box(page, ".sidebar")
        want = before_side["w"] + 80 + GRAB_OFFSET
        print(f"side   {before_side['w']} -> {after_side['w']} (want ~{want})")
        if abs(after_side["w"] - want) > 1:
            fails.append(
                f"the sidebar did not follow the pointer: {before_side['w']} -> {after_side['w']}, expected ~{want}"
            )

        # The bounds have to hold. A pane dragged to the window edge must stop at its floor rather than
        # collapsing — a 0px rail has no handle left to drag it back with.
        drag(page, ".pane-resizer-rail", -2000)
        floored = box(page, ".rail")
        print(f"floor  rail -> {floored['w']} (min 200)")
        if floored["w"] < 190:
            fails.append(f"the rail collapsed past its floor to {floored['w']}px")

        # And the choice survives a reload, which is the difference between a resize and a preference.
        drag(page, ".pane-resizer-rail", 140)
        chosen = box(page, ".rail")["w"]
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".rail", timeout=20000)
        page.wait_for_timeout(1500)
        restored = box(page, ".rail")["w"]
        print(f"persist rail {chosen} -> reload -> {restored}")
        if abs(restored - chosen) > 2:
            fails.append(f"the rail width did not survive a reload ({chosen} -> {restored})")

        # Keyboard, because a drag handle reachable only by pointer is a preference a keyboard user
        # cannot set at all.
        page.focus(".pane-resizer-rail")
        page.keyboard.press("ArrowRight")
        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(200)
        keyed = box(page, ".rail")["w"]
        print(f"keys   rail {restored} -> {keyed} (two ArrowRight, 16px each)")
        if keyed - restored < 24:
            fails.append(f"arrow keys moved the rail only {keyed - restored}px")

        browser.close()

    print()
    if fails:
        print("FAIL")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("PASS: one mark everywhere, both panes drag and persist, and the top nav is real links.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
