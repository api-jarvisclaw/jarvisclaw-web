"""The gallery's rows line up, and an open dialog is actually on screen and actually modal.

Three defects, all of which passed every existing check:

  1. **The library dialog mounted ten thousand pixels below the fold.** Its classes
     (`showcase-modal`, `-inner`, `-head`, `-actions`) were invented and NONE had a CSS rule, so it
     rendered `position: static` with no background at y=9928 in a 950px viewport. It opened and
     nothing happened on screen. Playwright's is_visible() returned True — the element had a real
     573px box — and the probe that read `.showcase-prompt` (a class that does have a rule) got its
     518 characters and passed.

  2. **One row sat 205px left of every other.** `.seedance-search-row` set `margin: 14px 0 4px`,
     whose `0` overwrote the `auto` inline margin centring every other child of `.transcript`.
     Measured left=290 against 495 for its siblings, on both panes.

  3. **Every dialog was click-through.** `.scrim` is `fixed; z-index: 10`, but it rendered inside
     `.shell` (`relative; z-index: 1`) — a stacking context, so the 10 only ranked it against its
     siblings while the shell competed as one z:1 layer and `.topbar` at z:2 won. With a dialog
     open, elementFromPoint hit HEADER.topbar and DIV.rail-list. That includes ConsentDialog, the
     gate in front of a paid call.

So this probe asserts geometry and hit-testing, not presence. `is_visible()` is exactly the check
that missed all three.
"""

import os
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai")

# Points that must be covered by the backdrop while a dialog is open. Chosen because each one was
# measured hitting a LIVE control before the portal fix: the top bar twice, the conversation rail
# once.
BEHIND_POINTS = [(12, 12), (960, 60), (200, 600)]


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1920, "height": 1000})
        page.route(
            "**/api/marketplace/**",
            lambda r: r.fulfill(
                status=200,
                json={"success": True, "data": {"items": [], "total": 0, "categories": []}},
            ),
        )
        page.route("**/api/discovery/models**", lambda r: r.fulfill(status=200, json={"free": []}))

        # /en/gallery, not /gallery. A bare path resolves to whatever the RUNNING MACHINE's browser
        # asks for, so this probe read Chinese tabs on my laptop and failed on tab names that were
        # correct — a probe whose result depends on the tester's locale tests the tester.
        page.goto(f"{URL}/en/gallery", wait_until="domcontentloaded")
        page.wait_for_selector(".gallery-tabs", timeout=30000)

        # ---- 1. alignment, on both panes that carry the search row ----
        for tab, grid in [("Video prompts", ".showcase-grid"), ("Prompt library", ".library-grid")]:
            page.get_by_role("tab", name=tab).click()
            page.wait_for_selector(f"{grid} > *", timeout=45000)
            rows = {}
            for sel in [".gallery-head", ".seedance-search-row", grid]:
                rows[sel] = page.evaluate(
                    "s => { const e = document.querySelector(s); if (!e) return null;"
                    " const b = e.getBoundingClientRect();"
                    " return [Math.round(b.left), Math.round(b.width)]; }",
                    sel,
                )
            print(f"[{tab}] " + "  ".join(f"{k}={v}" for k, v in rows.items()))
            if any(v is None for v in rows.values()):
                fails.append(f"{tab}: a row is missing entirely: {rows}")
                continue
            lefts = [v[0] for v in rows.values()]
            if max(lefts) - min(lefts) > 1:
                fails.append(
                    f"{tab}: rows are not aligned — lefts {lefts}. A shorthand margin with an "
                    "explicit 0 overwrites the auto that centres the column."
                )

        # ---- 2 & 3. the library dialog: on screen, and modal ----
        page.get_by_role("tab", name="Prompt library").click()
        page.wait_for_selector(".library-card", timeout=45000)
        page.locator(".library-card").first.click()
        page.wait_for_selector(".scrim", timeout=15000)

        geo = page.evaluate(
            "() => { const s = document.querySelector('.scrim'),"
            " p = document.querySelector('.showcase-detail');"
            " if (!s || !p) return null;"
            " const pb = p.getBoundingClientRect(), sc = getComputedStyle(s), pc = getComputedStyle(p);"
            " return {scrimPos: sc.position, scrimParent: s.parentElement.tagName,"
            "  top: Math.round(pb.top), left: Math.round(pb.left),"
            "  w: Math.round(pb.width), h: Math.round(pb.height),"
            "  bg: pc.backgroundColor, vh: window.innerHeight}; }"
        )
        print(f"dialog: {geo}")
        if geo is None:
            fails.append("the dialog did not mount")
        else:
            # The portal is what escapes the stacking context, so the parent is the assertion.
            if geo["scrimParent"] != "BODY":
                fails.append(
                    f"the scrim's parent is {geo['scrimParent']}, not BODY — inside .shell its "
                    "z-index cannot outrank the top bar, whatever value it holds"
                )
            if geo["scrimPos"] != "fixed":
                fails.append(f"the scrim is {geo['scrimPos']}, not fixed")
            # The original defect: appended at y=9928 in a 950px viewport.
            if not (0 <= geo["top"] < geo["vh"]):
                fails.append(
                    f"the panel is at y={geo['top']} in a {geo['vh']}px viewport — off screen, "
                    "which is what a class with no CSS rule behind it looks like"
                )
            if geo["bg"] in ("rgba(0, 0, 0, 0)", "transparent"):
                fails.append("the panel has no background — the grid reads through it")
            if geo["w"] < 400:
                fails.append(f"the panel is only {geo['w']}px wide")

        hits = {}
        for x, y in BEHIND_POINTS:
            hits[(x, y)] = page.evaluate(
                "pt => { const e = document.elementFromPoint(pt[0], pt[1]);"
                " return e ? e.tagName + '.' + (e.className || '') : null; }",
                [x, y],
            )
        print("hit test behind the dialog:")
        for pt, el in hits.items():
            print(f"  {pt} -> {el}")
        leaked = {
            pt: el for pt, el in hits.items() if el is not None and not el.startswith("DIV.scrim")
        }
        if leaked:
            fails.append(
                f"{len(leaked)} points behind the dialog hit a live element instead of the "
                f"backdrop: {leaked} — the dialog is not modal"
            )

        # The prompt must be readable, and both actions must be real styled buttons rather than
        # default browser text (which is what an unrecognised class renders as).
        chars = len(page.inner_text(".showcase-prompt"))
        print(f"prompt chars: {chars}")
        if chars < 100:
            fails.append(f"the prompt is only {chars} characters")
        for label in ["Copy prompt", "Make your own"]:
            btn = page.get_by_role("button", name=label)
            if btn.count() == 0:
                fails.append(f"no '{label}' button in the dialog")
                continue
            pad = btn.first.evaluate("e => getComputedStyle(e).padding")
            print(f"button '{label}': padding={pad}")
            if pad in ("0px", ""):
                fails.append(f"'{label}' has no padding — its class has no rule behind it")

        # Backdrop click closes. Uses the top-left point that used to hit the top bar, so this
        # doubles as proof the backdrop now receives the event.
        page.mouse.click(12, 12)
        page.wait_for_timeout(600)
        if page.locator(".scrim").count() != 0:
            fails.append("clicking the backdrop did not close the dialog")
        else:
            print("backdrop click closes the dialog")

        browser.close()

    print()
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS: rows align on both panes; the dialog opens on screen, is modal, and closes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
