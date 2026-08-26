"""Signing in on the platform makes the chat console recognise you.

The bug, reported as "登录主站似乎有点bug": you sign in on the main site, press "I've signed in",
and the panel still shows the signed-out text.

Root cause, measured from https://chat.jarvisclaw.ai with a real session:

    /api/user/self WITHOUT New-Api-User -> 401 "Unauthorized, New-Api-User header not provided"
    /api/user/self WITH    New-Api-User -> 200

Every session-authenticated route sits behind UserAuth, which requires that header to carry the
caller's own user id. The FIRST call cannot send it — asking who you are cannot require knowing
who you are. The console avoids the problem by storing the id from its login response in
localStorage, which is per-origin, so nothing here can read it.

This probe creates a throwaway account, signs in through the platform's own API in the browser
(so the cookie is set exactly as a real sign-in sets it), then drives the panel. It never touches
anyone's real credentials.

One thing worth stating: it also checks the cross-origin call directly, because my first diagnosis
was wrong. The session cookie carries no Domain attribute, which is host-only by spec — but
chat. and api.jarvisclaw.ai are same-site, so it travels anyway. Measuring the call beats
reasoning about the cookie.
"""

import os
import re
import secrets
import sys

from playwright.sync_api import sync_playwright

CHAT = os.environ.get("CHAT_URL", "https://chat.jarvisclaw.ai/")
API = os.environ.get("API_URL", "https://api.jarvisclaw.ai")


def main() -> int:
    fails = []
    user = f"probe{secrets.token_hex(4)}"
    pw = "Pr0be!" + secrets.token_hex(3)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})

        # ── a real session, created through the platform's own endpoints ──
        api = ctx.new_page()
        api.goto(f"{API}/en/sign-in", wait_until="domcontentloaded", timeout=60000)
        api.wait_for_timeout(2500)
        signup = api.evaluate(
            """async ([u, p]) => {
              const reg = await fetch('/api/user/register', {method: 'POST', credentials: 'include',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username: u, password: p, password2: p})});
              const log = await fetch('/api/user/login', {method: 'POST', credentials: 'include',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username: u, password: p})});
              const j = await log.json().catch(() => null);
              return {register: reg.status, login: log.status, id: j?.data?.id ?? null};
            }""",
            [user, pw],
        )
        print(f"== a real session ==\n   register {signup['register']}  login {signup['login']}  id {signup['id']}")
        if not signup["id"]:
            print("   cannot create a test account; nothing below would mean anything")
            return 1

        cookies = [(c["name"], c["domain"]) for c in ctx.cookies()]
        session = [c for c in cookies if c[0] == "session"]
        print(f"   session cookie: {session or '<none>'}")
        if not session:
            fails.append("no session cookie was set")

        # ── the two calls, from the chat origin ──
        chat = ctx.new_page()
        chat.goto(CHAT, wait_until="domcontentloaded", timeout=60000)
        chat.wait_for_selector(".composer-shell textarea", timeout=30000)
        chat.wait_for_timeout(3000)

        calls = chat.evaluate(
            """async ([api, id]) => {
              const call = async (path, headers) => {
                try {
                  const r = await fetch(api + path, {credentials: 'include',
                    headers: {'Content-Type': 'application/json', ...headers}});
                  const b = await r.json().catch(() => null);
                  return {status: r.status, success: b?.success ?? null, id: b?.data?.id ?? null,
                          message: b?.message ?? null};
                } catch (e) { return {status: 'blocked', message: String(e) }; }
              };
              return {
                selfBare:    await call('/api/user/self', {}),
                selfWithId:  await call('/api/user/self', {'New-Api-User': String(id)}),
                sessionRoute: await call('/api/user/session', {}),
              };
            }""",
            [API, signup["id"]],
        )
        print("\n== from the chat origin ==")
        for name in ("selfBare", "selfWithId", "sessionRoute"):
            c = calls[name]
            print(f"   {name:13} {c['status']}  success={c['success']}  id={c['id']}  {str(c['message'])[:52]}")

        if calls["selfBare"]["status"] != 401:
            # Not a failure of ours — but if this ever stops being 401 the whole fix is moot, and
            # a silent change here would leave dead code behind.
            print("   note: /self no longer needs the header; the two-call bootstrap is now redundant")
        if calls["selfWithId"]["status"] != 200:
            fails.append("the session does not reach the chat origin at all")
        if calls["sessionRoute"]["status"] != 200 or calls["sessionRoute"]["id"] != signup["id"]:
            fails.append(
                f"/api/user/session did not identify the session "
                f"({calls['sessionRoute']['status']}, id={calls['sessionRoute']['id']})"
            )
        if calls["sessionRoute"]["status"] == 404:
            fails.append("the gateway does not have /api/user/session deployed yet")

        # ── the panel itself ──
        #
        # No assertion that the re-check button exists, and two wrong versions taught me why.
        # First I looked for it AFTER clicking, where a successful sign-in has correctly removed
        # it. Then I looked before clicking — and it was still absent, because by then the page
        # had already found the session on its own mount and rendered the signed-in panel.
        #
        # Both were false failures on a run that had just proved the whole flow works. The button
        # is a convenience for the case where sign-in finishes in another tab AFTER this page
        # loaded; whether it is on screen depends on timing that is not the app's contract. What
        # IS the contract is the panel naming the account, which is asserted below.
        btn = chat.get_by_role("button", name="I've signed in")
        if btn.count():
            btn.first.click()
            chat.wait_for_timeout(5000)
            print("   (pressed the re-check button)")
        else:
            # The session was already picked up on mount, which is the better outcome.
            chat.wait_for_timeout(1500)
            print("   (session recognised on load, no re-check needed)")

        sidebar = re.sub(r"\s+", " ", chat.inner_text(".sidebar")).strip()
        i = sidebar.find("ACCOUNT")
        panel = sidebar[i : i + 300] if i >= 0 else sidebar[:300]
        print(f"\n== the panel after pressing the button ==\n   {panel[:240]}")

        if "Already have a JarvisClaw account" in panel:
            # The reported bug, in its own words.
            fails.append("the panel still shows the signed-out text after signing in")
        if user not in panel and "probe" not in panel.lower():
            fails.append("the panel does not name the signed-in account")

        # The sign-in link's label must name the host it opens — it said "jarvisclaw.ai" while
        # pointing at api.jarvisclaw.ai, a different host and the one the cookie belongs to.
        chat2 = ctx.new_page()
        chat2.goto(CHAT, wait_until="domcontentloaded", timeout=60000)
        chat2.wait_for_selector(".composer-shell textarea", timeout=30000)
        chat2.wait_for_timeout(3000)
        link = chat2.locator(".sidebar a", has_text="Sign in on")
        if link.count():
            label = link.first.inner_text().strip()
            href = link.first.get_attribute("href") or ""
            host = re.sub(r"^https?://([^/]+).*$", r"\1", href)
            print(f"\n== the sign-in link ==\n   {label!r} -> {href}")
            if host and host not in label:
                fails.append(f"the label says {label!r} but the link opens {host}")

        browser.close()

    print()
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS: a platform sign-in is recognised here, and the link names the host it opens.")
    return 0


sys.exit(main())
