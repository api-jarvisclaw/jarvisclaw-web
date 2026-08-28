"""Checks _locale.localised, because every probe's target URL now depends on it.

Run directly: python probe/_locale_test.py
"""

import sys

from _probe_locale import localised

CASES = [
    # (base, path, expected)
    ("https://ducat.jarvisclaw.ai", "/", "https://ducat.jarvisclaw.ai/en"),
    ("https://ducat.jarvisclaw.ai/", "/", "https://ducat.jarvisclaw.ai/en"),
    ("https://ducat.jarvisclaw.ai", "/chat", "https://ducat.jarvisclaw.ai/en/chat"),
    ("http://localhost:4173", "/gallery", "http://localhost:4173/en/gallery"),
    ("http://localhost:4173/", "gallery", "http://localhost:4173/en/gallery"),
    # An explicit locale in the base is respected, never rewritten: a caller who set CHAT_URL to a
    # Chinese path meant it.
    ("http://localhost:4173/zh", "/chat", "http://localhost:4173/zh/chat"),
    ("http://localhost:4173/zh", "/", "http://localhost:4173/zh"),
    ("http://localhost:4173/en", "/gallery", "http://localhost:4173/en/gallery"),
]


def main() -> int:
    fails = []
    for base, path, want in CASES:
        got = localised(base, path)
        if got != want:
            fails.append(f"localised({base!r}, {path!r}) = {got!r}, want {want!r}")
    # An explicit locale argument wins over the env default.
    got = localised("http://localhost:4173", "/chat", "zh")
    if got != "http://localhost:4173/zh/chat":
        fails.append(f"explicit locale ignored: {got!r}")

    print(f"{len(CASES) + 1} cases checked")
    if fails:
        print(f"FAIL ({len(fails)}):")
        for f in fails:
            print(f"   {f}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
