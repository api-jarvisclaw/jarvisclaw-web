"""`/en/sign-up` renders a real registration form, and `/en/login` still does not.

Why this exists: the account panel now offers a "Create an account" link, and the ONLY way to
know a console path is real is to render it. This repo already shipped `/en/login` on the
strength of a 200 — the console is an SPA whose host serves index.html for every path, so a
nonsense URL answers 200 exactly like a real route does.

`/en/nonsense-xyz` is checked alongside as the control. Without it, "sign-up rendered
something" is not evidence: every path renders something. The pair is what distinguishes a
route from a client-side 404.
"""

import sys

from playwright.sync_api import sync_playwright

# The Windows console is cp936 here, so any non-ASCII glyph in page text raises
# UnicodeEncodeError and kills the run mid-probe — a crash that looks like a product failure
# but is only this script printing. Reconfigured rather than stripped, so real page text still
# shows.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://api.jarvisclaw.ai"


def probe(page, path):
    page.goto(f"{BASE}{path}", wait_until="domcontentloaded")
    # The console hydrates slowly — measured at ~10s for the sign-in form to appear. A shorter
    # wait reports a real route as missing, which would send someone to "fix" a working link.
    try:
        page.wait_for_selector("form, [data-slot='card'], h1, h2", timeout=15000)
    except Exception:
        pass
    page.wait_for_timeout(2500)
    body = page.inner_text("body")[:400].replace("\n", " ⏎ ")
    return {
        "passwords": page.locator("input[type=password]").count(),
        "not_found": "Not Found" in body or "404" in body,
        "body": body,
    }


def main() -> int:
    fails = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})

        results = {}
        for path in ("/en/sign-up", "/en/sign-in", "/en/login", "/en/nonsense-xyz"):
            results[path] = probe(page, path)
            r = results[path]
            print(f"{path:20s} passwords={r['passwords']}  not_found={r['not_found']}")
            print(f"    {r['body'][:200]}")

        # A registration form must exist. Two password fields (password + confirm) is the usual
        # shape, but one is enough to prove the page is a real form and not a 404.
        if results["/en/sign-up"]["passwords"] < 1:
            fails.append("/en/sign-up rendered no password field — not a registration form")
        if results["/en/sign-up"]["not_found"]:
            fails.append("/en/sign-up rendered a Not Found page")

        # The control. If a nonsense path ALSO renders a form, this probe proves nothing and
        # must not be trusted — better to fail loudly than to report a false pass.
        if results["/en/nonsense-xyz"]["passwords"] > 0:
            fails.append(
                "control path rendered a password field: this probe cannot distinguish "
                "a real route from an SPA 404, so its verdict on sign-up is worthless"
            )
        if not results["/en/nonsense-xyz"]["not_found"]:
            fails.append("control path did not render Not Found — SPA fallback changed")

        browser.close()

    print()
    if fails:
        for f in fails:
            print("  FAIL:", f)
        return 1
    print("PASS: /en/sign-up is a real registration form; a nonsense path is not.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
