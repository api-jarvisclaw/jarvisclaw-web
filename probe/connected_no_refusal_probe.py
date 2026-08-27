"""A connected session must not repeat a walletless refusal, even after a reload.

The reported bug, twice. Second report came with a screenshot showing `test in use for paid
calls`, a wallet on Base, balance $8.09, the paid `deepseek/deepseek-chat` answering — and:

    "当前会话没有连接钱包或 API 密钥，这个调用无法执行。"
    "原因从未改变 —— ... 而这次会话没有连接钱包或 API 密钥"

Two distinct causes, and the first fix only closed one:

  connecting mid-conversation. The system prompt is swapped, but the model's own earlier
  refusals stay in the transcript and it agrees with itself. ("再次" was the tell.)

  RELOADING. Opening a saved conversation restores the transcript AND the prompt, so a
  conversation written while anonymous comes back with the paying prompt already installed.
  Nothing "changes" on the next message, so a fix keyed on the prompt changing never fires.

This drives the real console with a real key against the real gateway, because neither cause
is visible to a unit test: one needs a live credential, the other needs the persistence layer.

Creates its own throwaway account — it never asks for, reads, or stores the operator's
credentials, and the key it makes lives only in this process.

Usage: python probe/connected_no_refusal_probe.py
"""

import os
import re
import secrets
import sys
import time

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from playwright.sync_api import sync_playwright

CHAT = os.environ.get("CHAT_URL", "https://ducat.jarvisclaw.ai").rstrip("/")
API = os.environ.get("API_URL", "https://api.jarvisclaw.ai").rstrip("/")
ANSWER_TIMEOUT = 240_000

# The claim that must not appear once a credential is in use. Each alternative pairs a negation
# with the credential, so the model merely MENTIONING a wallet does not trip it.
REFUSAL = re.compile(
    r"(没有|未|无)(连接)?(钱包|api\s*密钥|API 密钥)"
    r"|(钱包|密钥).{0,8}(没有|未)连接"
    r"|无法(完成|执行|发起).{0,12}(付费|调用)"
    r"|(no|without)\s+(a\s+)?(wallet|api\s+key)"
    r"|cannot\s+(pay|complete\s+a\s+paid)",
    re.I,
)


def wait_idle(page) -> None:
    page.wait_for_function(
        "() => ![...document.querySelectorAll('button')]"
        ".some(b => b.textContent.trim() === 'Stop')",
        timeout=ANSWER_TIMEOUT,
    )


def ask(page, text: str) -> str:
    before = page.locator(".turn-agent .bubble").count()
    page.fill("textarea", text)
    page.click(".send-btn")
    page.wait_for_function(
        f"() => document.querySelectorAll('.turn-agent .bubble').length > {before}"
        " && [...document.querySelectorAll('.turn-agent .bubble')].pop().innerText.trim().length>0",
        timeout=ANSWER_TIMEOUT,
    )
    wait_idle(page)
    return page.locator(".turn-agent .bubble").last.inner_text()


def main() -> int:
    fails: list[str] = []
    user = f"probe{secrets.token_hex(4)}"
    pw = "Pr0be!" + secrets.token_hex(3)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})

        # ── a throwaway account, and a key from it ──
        api = ctx.new_page()
        api.goto(f"{API}/en/sign-in", wait_until="domcontentloaded", timeout=60_000)
        api.wait_for_timeout(2500)
        acct = api.evaluate(
            """async ([u, p]) => {
              const reg = await fetch('/api/user/register', {method:'POST', credentials:'include',
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({username:u, password:p, password2:p})});
              const log = await fetch('/api/user/login', {method:'POST', credentials:'include',
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({username:u, password:p})});
              const j = await log.json().catch(() => null);
              const id = j?.data?.id ?? null;
              if (!id) return {register: reg.status, login: log.status, id: null, key: null};
              // The console's own flow: create a token, then read it back.
              const mk = await fetch('/api/token/', {method:'POST', credentials:'include',
                headers:{'Content-Type':'application/json','New-Api-User': String(id)},
                body: JSON.stringify({name:'probe', remain_quota:0, unlimited_quota:true,
                                      expired_time:-1, model_limits_enabled:false})});
              const list = await fetch('/api/token/?p=0&size=10', {credentials:'include',
                headers:{'New-Api-User': String(id)}});
              const lj = await list.json().catch(() => null);
              const items = lj?.data?.items ?? lj?.data ?? [];
              const tok = Array.isArray(items) ? items.find(t => t?.key) : null;
              return {register: reg.status, login: log.status, id, mk: mk.status,
                      key: tok?.key ? 'sk-' + tok.key : null};
            }""",
            [user, pw],
        )
        print(f"account: register={acct['register']} login={acct['login']} id={acct['id']} "
              f"token={acct.get('mk')} key={'yes' if acct.get('key') else 'NO'}")
        if not acct["id"] or not acct.get("key"):
            # 429 is the registration route's rate limit, not a product defect. A probe that
            # fails for its own reasons trains you to ignore it.
            if 429 in (acct["register"], acct["login"], acct.get("mk") or 0):
                print("SKIPPED: platform rate limit (429). Wait a few minutes.")
                return 0
            print("SKIPPED: could not mint a key, so nothing below would mean anything")
            return 0
        key = acct["key"]
        api.close()

        page = ctx.new_page()
        page.goto(f"{CHAT}/chat", wait_until="domcontentloaded")
        page.wait_for_selector("textarea", timeout=30_000)

        # ── 1. anonymous first, to plant the refusal the way a real user does ──
        print("\n== 1. anonymous turn (plants the refusal) ==")
        first = ask(page, "北京时间是几点")
        print(f"   {first[:110].replace(chr(10), ' ')!r}")
        if not REFUSAL.search(first):
            print("   note: the anonymous turn did not refuse in the expected words; the rest of "
                  "this probe still checks the connected turns, but the setup is weaker")

        # ── 2. connect the key the way the UI actually does it ──
        #
        # NOT by pasting. My first version hunted for a password field and found none, then
        # reported "the UI flow changed" — the UI never had one. The console reads the platform
        # session and lists THAT ACCOUNT'S keys as buttons, so the user picks one and the secret
        # is never typed or displayed. The probe has to follow the same path: the session cookie
        # already exists in this browser context from the registration above.
        print("\n== 2. connect the key ==")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("textarea", timeout=30_000)
        signed_in = page.get_by_role("button", name=re.compile(r"I've signed in", re.I))
        if signed_in.count() > 0:
            signed_in.first.click()
        # Waited for, not slept through. A fixed `wait_for_timeout(2500)` reported "keys offered: 0"
        # against a working console: the panel was still on "Checking for a signed-in session…"
        # while the session request (verified separately: 200, correct username) was in flight. A
        # probe that races the thing it measures reports a UI defect that is its own impatience.
        try:
            page.wait_for_function(
                "() => !document.body.innerText.includes('Checking for a signed-in session')",
                timeout=30_000,
            )
        except Exception:
            print("   note: the session check never resolved")
        page.wait_for_timeout(1200)
        key_btns = page.locator(".account-key:not([disabled])")
        print(f"   keys offered: {key_btns.count()}")
        if key_btns.count() == 0:
            print("   SKIPPED: the console did not list this account's keys. Reading the session "
                  "only works from the canonical host, so this can be an origin limit rather "
                  "than a defect — check the ACCOUNT panel text.")
            return 0
        key_btns.first.click()
        page.wait_for_timeout(1500)
        in_use = page.get_by_text(re.compile("in use for paid calls", re.I)).count() > 0
        print(f"   key shown as in use: {in_use}")
        if not in_use:
            print("   SKIPPED: the key did not register in the UI, so a later refusal would be "
                  "correct rather than a bug")
            return 0

        # ── 3. the connected turn must not repeat the refusal ──
        print("\n== 3. connected turn ==")
        second = ask(page, "北京时间")
        print(f"   {second[:200].replace(chr(10), ' ')!r}")
        m = REFUSAL.search(second)
        if m:
            fails.append(
                f"a CONNECTED session still claims it cannot pay: "
                f"{second[max(0, m.start() - 40):m.end() + 40]!r}"
            )

        # ── 4. and still must not after a reload ──
        # This is the case the first fix missed: a reload restores the transcript with the paying
        # prompt already in place, so nothing "changes" and a prompt-change trigger never fires.
        print("\n== 4. after a reload ==")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("textarea", timeout=30_000)
        # A reload drops the key on purpose — it is held in component state only, never stored —
        # so it has to be picked again. That is exactly the state the screenshot was in.
        again = page.get_by_role("button", name=re.compile(r"I've signed in", re.I))
        if again.count() > 0:
            again.first.click()
        try:
            page.wait_for_function(
                "() => !document.body.innerText.includes('Checking for a signed-in session')",
                timeout=30_000,
            )
        except Exception:
            pass
        page.wait_for_timeout(1200)
        k2 = page.locator(".account-key:not([disabled])")
        if k2.count() > 0:
            k2.first.click()
            page.wait_for_timeout(1500)
        print(f"   key shown as in use after reload: "
              f"{page.get_by_text(re.compile('in use for paid calls', re.I)).count() > 0}")
        restored_turns = page.locator(".turn-agent .bubble").count()
        print(f"   restored agent turns: {restored_turns}")
        if restored_turns == 0:
            print("   note: nothing was restored, so this half tests less than intended")
        third = ask(page, "现在北京几点")
        print(f"   {third[:200].replace(chr(10), ' ')!r}")
        m3 = REFUSAL.search(third)
        if m3:
            fails.append(
                f"after a reload, a connected session claims it cannot pay again: "
                f"{third[max(0, m3.start() - 40):m3.end() + 40]!r}"
            )

        browser.close()

    if fails:
        print(f"\nFAIL ({len(fails)}):")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("\nPASS: a connected session does not repeat the walletless refusal, before or after a "
          "reload.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
