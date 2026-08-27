"""The marketplace shows categories, and clicking one narrows to a truthful count.

Run against the built bundle with the real gateway, NOT against stubs. The whole design rests on
a claim only a live run can check: that `category=` filters server-side and the facet's counts are
true across all 2,720 rows. A stub returning whatever the test wants would confirm the plumbing and
prove nothing about the claim.

What this catches that a unit test cannot:

  - the response envelope. `/api/marketplace/apis` wraps its payload in `{"data": …}` while the
    two endpoints beside it in catalogue.ts return theirs at the top level. Reading the wrong
    level yields an EMPTY marketplace from a perfectly working gateway — and it looks like an
    empty marketplace, not like a bug.
  - the counts add up. A category pill claiming 1,312 endpoints must actually produce 1,312 when
    clicked; a client-side filter can only ever count the page it downloaded.
  - the CSP allows the call at all. `_headers` is applied by the edge and by serve_dist.py, and
    nothing else — a blocked request is a browser-level error with no stack trace.
"""

import os
import re
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = os.environ.get("CHAT_URL", "http://localhost:4173")


def main() -> int:
    fails = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 950})

        # cloudflareinsights is excluded: the edge injects its beacon and `script-src 'self'`
        # refuses it, which is the policy working. Counting it means this probe can never pass in
        # production, and a probe that always fails is one whose findings get ignored.
        csp = []
        page.on(
            "console",
            lambda m: csp.append(m.text)
            if m.type == "error"
            and "Content Security Policy" in m.text
            and "cloudflareinsights" not in m.text
            else None,
        )

        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)

        # Reach the marketplace. The nav label is what a user clicks, so that is what this uses —
        # driving the app by internal state would pass even if the button were unreachable.
        page.get_by_role("button", name=re.compile("marketplace", re.I)).first.click()
        page.wait_for_selector(".market-cat", timeout=25000)

        pills = page.locator(".market-cat")
        n = pills.count()
        print(f"category pills: {n}")
        if n < 10:
            fails.append(f"only {n} category pills — the facet did not load")

        labels = []
        for i in range(min(n, 25)):
            labels.append(pills.nth(i).inner_text().replace("\n", " "))
        print("  " + " | ".join(labels))

        # The count line states a total for the WHOLE filter, which is the claim being tested.
        page.wait_for_selector(".market-count-line", timeout=20000)
        all_line = page.locator(".market-count-line").inner_text()
        print(f"unfiltered: {all_line}")
        all_total = int(re.sub(r"[^0-9]", "", all_line.split("endpoint")[0]) or 0)
        if all_total < 2000:
            fails.append(f"unfiltered total {all_total} — expected the full ~2,720 catalogue")

        cards = page.locator(".market-card").count()
        print(f"cards on page 1: {cards}")
        if cards == 0:
            # The envelope bug reads exactly like this: markup intact, zero rows.
            fails.append("no endpoint cards rendered — check the {data:…} envelope")

        # Pick a specific, small category and check the pill's own number against what the
        # filtered view reports. These are two separate paths through the gateway (the facet vs a
        # filtered query), and them agreeing is what makes the pill's number trustworthy.
        target = None
        for i in range(n):
            text = pills.nth(i).inner_text()
            if "Video" in text and "Barcode" not in text:
                target = (i, text)
                break
        if target is None:
            fails.append("no Video pill to click")
        else:
            i, text = target
            claimed = int(re.sub(r"[^0-9]", "", text.split("\n")[-1]) or 0)
            pills.nth(i).click()
            page.wait_for_timeout(2500)
            line = page.locator(".market-count-line").inner_text()
            print(f"after clicking {text!r}: {line}")
            got = int(re.sub(r"[^0-9]", "", line.split("endpoint")[0]) or 0)
            if got != claimed:
                fails.append(
                    f"pill claimed {claimed} endpoints but the filter reports {got} — "
                    "the facet and the query disagree"
                )
            if got >= all_total:
                fails.append(f"filtering did not narrow anything ({got} vs {all_total})")
            if "Video" not in line:
                fails.append(f"count line does not name the active category: {line!r}")

            # Clicking the active pill again must clear it. A filter with no way out is a dead end.
            pills.nth(i).click()
            page.wait_for_timeout(2500)
            back = page.locator(".market-count-line").inner_text()
            print(f"after clicking it again: {back}")
            if int(re.sub(r"[^0-9]", "", back.split("endpoint")[0]) or 0) != all_total:
                fails.append("clicking the active category again did not clear the filter")

        if csp:
            fails.append(f"CSP blocked {len(csp)} request(s): {csp[:2]}")

        browser.close()

    print()
    if fails:
        for f in fails:
            print("  FAIL:", f)
        return 1
    print("PASS: categories load, counts agree with the server, and the filter clears.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
