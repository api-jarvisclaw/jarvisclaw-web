"""One place that decides which locale a probe drives the site in.

## Why this exists

The site is now localised by URL path (/en/chat, /zh/gallery), and a BARE path resolves to whatever
the browser asks for. Playwright inherits the machine's languages, so `/chat` opened on a
Chinese-configured laptop renders Chinese — and every probe asserting `.mode-btn:has-text('Image')`
fails on a page that is working perfectly.

That failure is expensive in a specific way: it names a control, so it reads as a UI defect. Two
probes had already been chased that way before this file existed.

Named `_probe_locale`, not `_locale`: CPython ships a built-in `_locale` module and importing this
one shadowed it, so the import failed with "cannot import name … (unknown location)" — a message that
says nothing about the collision.

## The rule

A probe asserts on English copy unless it is testing the translation itself. So probes pin `/en`,
and only i18n_probe.py drives `/zh`. Set PROBE_LOCALE to override for a one-off run.

    from _probe_locale import localised
    page.goto(localised(URL, "/gallery"))     # -> https://…/en/gallery

Pinning is not a workaround for the redirect — the redirect works and is tested. It removes the
tester's own machine from the result, which is a different thing and the reason a probe can be
trusted on someone else's laptop.
"""

import os

LOCALE = os.environ.get("PROBE_LOCALE", "en")


def localised(base: str, path: str = "/", locale: str | None = None) -> str:
    """Builds a locale-prefixed URL from a base and an app path.

    `base` may already carry a locale (a caller that set CHAT_URL by hand); in that case it is left
    alone, so an explicit choice is never silently rewritten.
    """
    b = base.rstrip("/")
    loc = locale or LOCALE
    for known in ("/en", "/zh"):
        if b.endswith(known):
            return b if path in ("", "/") else b + path
    p = path if path.startswith("/") else "/" + path
    return b + "/" + loc if p == "/" else b + "/" + loc + p
