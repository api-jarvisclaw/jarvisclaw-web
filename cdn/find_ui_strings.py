"""Counts the user-visible English strings in the UI, so the i18n job has a denominator.

A grep for `>Text<` finds a fraction of them: this codebase writes multi-line JSX text, splits
sentences across `{' '}` joins, and puts copy in `placeholder`, `aria-label` and `title`. Guessing
the size of the job from a partial count is how half a translation ships and the untouched half
only shows up in the language nobody on the team reads.

So this reports what it found AND what it deliberately skipped, per file. It is a survey, not a
transformer — nothing is rewritten here.

Not translated, by decision:
  - `src/lib/library.ts`, `seedance.ts`, `showcase.ts` — other people's prompts, under licences
    that ask for the work to travel intact. A translated prompt is a different prompt and would
    produce a different image.
  - model ids, class names, URLs, currency amounts.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

SKIP_FILES = {"library.ts", "seedance.ts", "showcase.ts", "library-count.ts", "seedance-count.ts"}

# JSX text between tags, allowing newlines. Requires a letter so `{x}` and punctuation-only nodes
# are ignored.
JSX_TEXT = re.compile(r">\s*([A-Za-z][^<>{}]*?)\s*<", re.S)
# Copy that lives in attributes.
ATTR = re.compile(r'\b(?:placeholder|aria-label|title|alt)=(?:"([^"]+)"|\{[\'"]([^\'"]+)[\'"]\})')
# Strings passed to throw new Error(...) — these surface verbatim in the transcript.
ERROR = re.compile(r"new Error\(\s*[`'\"]([^`'\"]{6,})[`'\"]")

# A node that is only punctuation, a number, or a single word that is also an identifier is not
# copy. Kept deliberately loose: over-counting a few is better than under-counting, since the
# point of this survey is to size the work honestly.
NOT_COPY = re.compile(r"^[\s\d.,:;·—–\-/$%()\[\]]*$")


def strings_in(path: Path) -> dict[str, list[str]]:
    text = path.read_text(encoding="utf-8")
    out: dict[str, list[str]] = {"jsx": [], "attr": [], "error": []}
    for m in JSX_TEXT.finditer(text):
        s = " ".join(m.group(1).split())
        if len(s) >= 3 and not NOT_COPY.match(s):
            out["jsx"].append(s)
    for m in ATTR.finditer(text):
        s = m.group(1) or m.group(2)
        if s and len(s) >= 3:
            out["attr"].append(" ".join(s.split()))
    for m in ERROR.finditer(text):
        out["error"].append(" ".join(m.group(1).split()))
    return out


def main() -> int:
    files = sorted(
        [p for p in SRC.rglob("*.tsx") if not p.name.endswith(".test.tsx")]
        + [p for p in SRC.rglob("*.ts") if ".test." not in p.name and p.name not in SKIP_FILES]
    )
    if not files:
        sys.exit("no source files found — the glob stopped matching")

    total = {"jsx": 0, "attr": 0, "error": 0}
    rows = []
    for f in files:
        found = strings_in(f)
        n = sum(len(v) for v in found.values())
        if n == 0:
            continue
        rows.append((n, f.relative_to(ROOT), found))
        for k in total:
            total[k] += len(found[k])

    rows.sort(reverse=True, key=lambda r: r[0])
    for n, rel, found in rows:
        print(f"{n:4d}  {rel}   jsx={len(found['jsx'])} attr={len(found['attr'])} err={len(found['error'])}")

    grand = sum(total.values())
    print()
    print(f"TOTAL {grand} strings across {len(rows)} files")
    print(f"  jsx text {total['jsx']}   attributes {total['attr']}   error messages {total['error']}")
    print()
    print(f"skipped by decision: {sorted(SKIP_FILES)}")
    print("  (licensed prompt data — a translated prompt is a different prompt)")

    if "--dump" in sys.argv:
        print("\n--- every string ---")
        for _, rel, found in rows:
            print(f"\n## {rel}")
            for kind in ("jsx", "attr", "error"):
                for s in found[kind]:
                    print(f"  [{kind}] {s}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
