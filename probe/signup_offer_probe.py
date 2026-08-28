"""A signed-out visitor is offered BOTH signing in and creating an account.

The gap this pins: the panel showed one link, "Sign in", and nothing else. Someone who does not
have an account had a form they could not fill and no next step — a dead end at exactly the point
where a newcomer decides whether the product is for them.

Checked in a browser rather than as a unit test because what matters is that a visitor can SEE
both, in the signed-out state, without hunting. A test asserting `SIGN_UP_URL` exists would pass
with the button rendered nowhere.
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
        # A fresh context with no cookies: the signed-out state is the one under test, and a
        # lingering session would silently skip the whole check by rendering the signed-in panel.
        page = browser.new_page(viewport={"width": 1400, "height": 950})

        page.goto(localised(URL), wait_until="domcontentloaded")
        page.wait_for_timeout(1500)

        # The account panel lives in the sidebar. Opened by its nav control, the way a user
        # reaches it — driving internal state would pass even if the control were unreachable.
        for name in ("account", "settings", "wallet"):
            btn = page.get_by_role("button", name=re.compile(name, re.I))
            if btn.count() > 0:
                btn.first.click()
                page.wait_for_timeout(800)
                break

        page.wait_for_selector(".account-blurb, .account-name", timeout=15000)

        if page.locator(".account-name").count() > 0:
            print("SKIP: a session is already signed in; the signed-out panel is what this tests.")
            browser.close()
            return 0

        links = page.locator(".panel a.panel-btn")
        texts = [links.nth(i).inner_text().replace("\n", " ").strip() for i in range(links.count())]
        hrefs = [links.nth(i).get_attribute("href") for i in range(links.count())]
        for t, h in zip(texts, hrefs):
            print(f"  {t!r:44s} -> {h}")

        joined = " ".join(texts).lower()
        if "sign in" not in joined:
            fails.append("no sign-in link offered")
        if not any(w in joined for w in ("create an account", "sign up", "new here")):
            fails.append("no way to create an account — a visitor without one has no next step")

        signup = [h for h in hrefs if h and "/en/sign-up" in h]
        signin = [h for h in hrefs if h and "/en/sign-in" in h]
        if not signup:
            fails.append(f"no href points at /en/sign-up: {hrefs}")
        if not signin:
            fails.append(f"no href points at /en/sign-in: {hrefs}")
        # Two buttons that go the same place is the copy-paste failure, and the half that would be
        # missing is the one a new user needs.
        if signup and signin and signup[0] == signin[0]:
            fails.append("sign-in and sign-up point at the same URL")

        # The label must not name a hostname. "Sign in on api.jarvisclaw.ai" was the old copy;
        # nobody has an account "on api.jarvisclaw.ai", they have one on JarvisClaw.
        if "api.jarvisclaw.ai" in joined:
            fails.append(f"a button label still names a hostname: {texts}")

        browser.close()

    print()
    if fails:
        for f in fails:
            print("  FAIL:", f)
        return 1
    print("PASS: both sign-in and account creation are offered, pointing at distinct real routes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
