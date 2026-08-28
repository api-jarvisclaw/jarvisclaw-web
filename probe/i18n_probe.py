"""The site is readable in Chinese, the URL says which language, and switching keeps your place.

What a unit test cannot see, and each of these has a specific way of failing silently:

  1. **The locale-prefixed URL actually serves the app.** `/zh/gallery` has to render the gallery, not
     the landing page. The SPA fallback means a wrong route still answers 200 with index.html, so a
     broken prefix looks like a working link that lands somewhere else.

  2. **The copy is really Chinese.** t() falls back to the English key by design, which is the right
     behaviour and also means a completely unwired component renders perfect English with no error
     anywhere. Measured as a ratio of CJK characters, not as "some Chinese is present".

  3. **The switcher is styled.** Its classes are new; a class name with no CSS rule renders as
     unstyled inline text, which is how the prompt-library dialog ended up off screen while every
     probe passed.

  4. **Switching keeps the pane.** /en/gallery -> /zh/gallery, not /zh. Losing the pane on a language
     switch reads as the site forgetting where you were.

  5. **A bare path redirects once, with no history trap.** `/chat` becomes `/en/chat` via
     replaceState — if it used pushState, Back would return to `/chat`, redirect again, and the
     reader could not leave the site.
"""

import os
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai")

CJK = re.compile(r"[一-鿿]")


def cjk_ratio(text: str) -> float:
    letters = [c for c in text if c.isalpha() or CJK.match(c)]
    if not letters:
        return 0.0
    return len(CJK.findall(text)) / len(letters)


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()

        def page_for(langs):
            ctx = browser.new_context(
                viewport={"width": 1500, "height": 1000}, locale=langs[0] if langs else "en-US"
            )
            pg = ctx.new_page()
            pg.route(
                "**/api/marketplace/**",
                lambda r: r.fulfill(
                    status=200,
                    json={"success": True, "data": {"items": [], "total": 0, "categories": []}},
                ),
            )
            pg.route("**/api/discovery/models**", lambda r: r.fulfill(status=200, json={"free": []}))
            return pg

        # ---- 1 & 2. the Chinese landing page ----
        pg = page_for(["zh-CN"])
        pg.goto(f"{URL}/zh", wait_until="domcontentloaded")
        pg.wait_for_selector("h1", timeout=30000)
        pg.wait_for_timeout(800)
        body = pg.inner_text("body")
        ratio = cjk_ratio(body)
        print(f"/zh  CJK ratio: {ratio:.2f}  ({len(body)} chars)  <html lang>={pg.get_attribute('html', 'lang')}")
        print(f"  h1: {pg.inner_text('h1')[:60]}")
        if ratio < 0.35:
            fails.append(
                f"/zh is only {ratio:.0%} Chinese — t() falls back to English keys, so an unwired "
                "component renders flawless English and nothing reports it"
            )
        if pg.get_attribute("html", "lang") != "zh":
            fails.append(f"<html lang> is {pg.get_attribute('html', 'lang')!r}, not 'zh'")

        # ---- 3. the switcher is styled ----
        tog = pg.locator(".locale-toggle")
        if tog.count() == 0:
            fails.append("no language switcher on the page")
        else:
            box = tog.first.bounding_box()
            style = tog.first.evaluate(
                "e => { const c = getComputedStyle(e); return [c.display, c.borderStyle, c.backgroundColor]; }"
            )
            print(f"  switcher: box={box} display={style[0]} border={style[1]} bg={style[2]}")
            # Positive assertions about the rule that must exist, NOT just "it is not inline".
            #
            # Measured: deleting the .locale-toggle block entirely leaves `display: block;
            # border: none` and a box 81x23 — which passed a size floor and an is-not-inline check
            # both. That is the same shape as the library dialog whose four class names had no rule:
            # a control that renders as bare text still occupies space and still reports visible.
            if not box or box["height"] < 28 or box["width"] < 80:
                fails.append(f"the switcher has no real size: {box} — its classes have no CSS rule")
            if style[0] != "flex":
                fails.append(
                    f"the switcher's display is {style[0]!r}, not flex — .locale-toggle has no rule "
                    "behind it and the control is rendering as plain text"
                )
            if style[1] == "none":
                fails.append("the switcher has no border — it does not read as a control at all")
            on = pg.locator(".locale-btn-on")
            if on.count() == 0:
                fails.append("no active language is marked")
            elif on.first.inner_text().strip() != "中文":
                fails.append(f"the active language reads {on.first.inner_text()!r}, expected 中文")
            else:
                # The active state has to be visible, not only present in the class list. Without a
                # background there is nothing on screen saying which language you are reading.
                on_bg = on.first.evaluate("e => getComputedStyle(e).backgroundColor")
                print(f"  active language background: {on_bg}")
                if on_bg in ("rgba(0, 0, 0, 0)", "transparent"):
                    fails.append(
                        "the active language has no background — .locale-btn-on has no rule, so "
                        "nothing indicates which language is showing"
                    )

        # ---- 4. switching keeps the pane ----
        pg.goto(f"{URL}/en/gallery", wait_until="domcontentloaded")
        pg.wait_for_selector(".gallery-tabs", timeout=30000)
        en_body = pg.inner_text("body")
        print(f"/en/gallery  CJK ratio: {cjk_ratio(en_body):.2f}  (English expected)")
        if cjk_ratio(en_body) > 0.15:
            fails.append("/en/gallery is showing Chinese — the URL is not deciding the language")
        pg.locator(".locale-btn", has_text="中文").first.click()
        pg.wait_for_timeout(900)
        print(f"  after switching: {pg.url}")
        if not pg.url.endswith("/zh/gallery"):
            fails.append(f"switching went to {pg.url}, not /zh/gallery — the pane was lost")

        # Measured on the CHROME, not on the whole body.
        #
        # A body-wide ratio reported this as failing when the switch had worked perfectly: the
        # gallery's own tabs and nav were Chinese, and the number was dragged under the threshold by
        # untranslated copy elsewhere on screen plus 105 English prompt titles — which are other
        # people's work and must NOT be translated. A ratio over a mixed sample measures the sample,
        # not the switch.
        chrome = " ".join(
            pg.eval_on_selector_all(".gallery-tab, .topnav-item", "es => es.map((e) => e.textContent)")
        )
        r = cjk_ratio(chrome)
        print(f"  chrome after switching: {r:.2f} — {chrome[:70]}")
        if r < 0.6:
            fails.append(
                f"the chrome is only {r:.0%} Chinese after switching ({chrome[:80]!r}) — the locale "
                "changed in the URL but the components did not re-render"
            )

        # Back must undo a language switch, since it is a navigation the reader made.
        pg.go_back()
        pg.wait_for_timeout(700)
        print(f"  after Back: {pg.url}")
        if not pg.url.endswith("/en/gallery"):
            fails.append(f"Back landed on {pg.url}, not /en/gallery")

        # ---- 5. a bare path redirects once ----
        pg2 = page_for(["en-US"])
        pg2.goto(f"{URL}/chat", wait_until="domcontentloaded")
        pg2.wait_for_timeout(1500)
        print(f"/chat -> {pg2.url}")
        if not pg2.url.endswith("/en/chat"):
            fails.append(f"/chat resolved to {pg2.url}, expected /en/chat")
        # replaceState, not pushState: Back must leave the site rather than bounce off the redirect.
        depth = pg2.evaluate("() => history.length")
        print(f"  history length after the redirect: {depth}")
        if depth > 2:
            fails.append(
                f"the redirect left {depth} history entries — pushState instead of replaceState "
                "traps the reader, since Back returns to /chat and redirects again"
            )

        # A zh-CN browser on a bare path should land in Chinese.
        pg3 = page_for(["zh-CN"])
        pg3.goto(f"{URL}/chat", wait_until="domcontentloaded")
        pg3.wait_for_timeout(1500)
        print(f"/chat from a zh-CN browser -> {pg3.url}")
        if not pg3.url.endswith("/zh/chat"):
            fails.append(f"a zh-CN browser landed on {pg3.url}, expected /zh/chat")

        browser.close()

    print()
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS: /zh reads as Chinese, the URL decides it, switching keeps the pane, Back works")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
