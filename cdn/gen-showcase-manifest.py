"""Writes src/lib/showcase-manifest.ts — the list of assets R2 actually serves.

## Why this file exists

`cdn/showcase/` is gitignored on purpose: 7.9 MB of jpg/mp4 whose real home is R2, and a git
object is permanent even after a delete. So a test asserting "every entry points at a poster that
exists" had nothing to read on CI and crashed the whole suite with ENOENT — green on my machine,
where the directory happens to exist, red everywhere else.

Deleting that assertion was the tempting fix and the wrong one. A wrong or missing filename is
exactly the defect that renders 105 blank tiles with the markup perfectly intact, and no build,
type check or behavioural test can see it.

## What is authoritative

R2, not a working copy. This asks the live CDN for each file the data references and records what
it answered. A local `ls` would freeze whatever my laptop happens to hold — including files that
were never uploaded with `--remote` and therefore do not exist for any visitor.

Verified the channel carries the signal before trusting it: a name that was never uploaded
answers 404, not 200. Without that check a CDN misconfigured to serve an SPA fallback would
report every asset present, including ones that are not.

Regenerate after uploading new assets:

    python cdn/gen-showcase-manifest.py

It refuses to write a manifest that lost entries, because the failure mode is a network blip
during the sweep silently shrinking the list into something the tests then happily agree with.
"""

import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CDN = "https://cdn.jarvisclaw.ai/showcase"
OUT = ROOT / "src" / "lib" / "showcase-manifest.ts"

# The two data files that name assets, and the fields that hold a filename.
SOURCES = [
    ROOT / "src" / "lib" / "seedance.ts",
    ROOT / "src" / "lib" / "showcase.ts",
]
FIELD = re.compile(r'^\s*(?:poster|video|asset)\s*:\s*"([^"]+)"', re.M)

# A name nothing ever uploaded. Its answer is what proves a 200 means anything at all.
CANARY = "zz-canary-never-uploaded.jpg"

# Cloudflare answers 403 to urllib's default User-Agent — for every name, present or not. The
# canary caught it on the first run: without a stated UA this script records all 146 assets as
# absent and the tests then agree with it. Left as a header rather than a retry because the
# failure is deterministic.
UA = "Mozilla/5.0 (compatible; jarvisclaw-manifest/1.0)"


def referenced() -> list[str]:
    names: set[str] = set()
    for src in SOURCES:
        if not src.exists():
            sys.exit(f"missing source: {src}")
        names.update(FIELD.findall(src.read_text(encoding="utf-8")))
    return sorted(names)


def head(name: str) -> tuple[str, int]:
    req = urllib.request.Request(f"{CDN}/{name}", method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return name, r.status
    except urllib.error.HTTPError as e:
        return name, e.code
    except Exception as e:  # noqa: BLE001 — a transport error is not a 404, and must not read as one
        print(f"  transport error on {name}: {e}", file=sys.stderr)
        return name, 0


def main() -> int:
    names = referenced()
    if not names:
        sys.exit("no asset names found in the data files — the field regex stopped matching")
    print(f"{len(names)} assets referenced by the data")

    _, canary = head(CANARY)
    if canary != 404:
        sys.exit(
            f"the canary answered {canary}, not 404 — the CDN is not distinguishing present from "
            "absent, so a 200 here would prove nothing. Refusing to write a manifest."
        )
    print(f"canary {CANARY} -> 404 (channel carries the signal)")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = dict(pool.map(head, names))

    present = sorted(n for n, code in results.items() if code == 200)
    missing = sorted(n for n, code in results.items() if code == 404)
    errors = sorted(n for n, code in results.items() if code not in (200, 404))

    print(f"present {len(present)}, missing {len(missing)}, unresolved {len(errors)}")
    for n in missing:
        print(f"  MISSING {n}")
    for n in errors:
        print(f"  UNRESOLVED {n} (http {results[n]})")

    if errors:
        sys.exit(
            "some assets could not be resolved. A manifest written now would record them as "
            "absent and the tests would agree with it. Re-run."
        )

    prior = 0
    if OUT.exists():
        prior = len(re.findall(r"^\s*'", OUT.read_text(encoding="utf-8"), re.M))
    if prior and len(present) < prior:
        sys.exit(
            f"the manifest would shrink from {prior} to {len(present)}. Either assets were "
            "deleted from R2 on purpose (then delete this file and re-run) or the sweep was "
            "partial. Refusing to overwrite."
        )

    body = "".join(f"  '{n}',\n" for n in present)
    OUT.write_text(HEAD + body + TAIL, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(present)} assets)")
    return 0


HEAD = """/**
 * The showcase assets R2 actually serves. GENERATED — run cdn/gen-showcase-manifest.py.
 *
 * `cdn/showcase/` is gitignored (7.9 MB of media whose home is R2, and a git object outlives its
 * delete), so the tests that check "every entry points at a file that exists" have no directory to
 * read. This is that directory listing, committed, and measured against the live CDN rather than a
 * working copy — a local `ls` would also count files that were never uploaded with `--remote` and
 * so exist for nobody but me.
 *
 * A name missing from here renders a blank tile with the markup perfectly intact, which is why the
 * check is worth keeping even though it costs a generated file.
 */
export const SHOWCASE_ASSETS: readonly string[] = [
"""

TAIL = """]

export const SHOWCASE_ASSET_SET: ReadonlySet<string> = new Set(SHOWCASE_ASSETS)
"""


if __name__ == "__main__":
    raise SystemExit(main())
