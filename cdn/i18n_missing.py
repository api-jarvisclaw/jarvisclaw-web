"""Lists t() keys the catalogue does not have, and catalogue keys the source never asks for.

The same two checks strings.test.ts runs, printed as text so the gap can be worked through rather
than read out of an assertion diff. The test is the gate; this is the worklist.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
CATALOGUE = SRC / "lib" / "strings.ts"

# Both quote styles. Single-quote-only missed `t("Don't spend")` — a key whose own apostrophe forces
# double quotes — and reported it as an orphan, which invites deleting the translation of a button in
# the spend dialog.
T_CALL = re.compile(r"""\bt\(\s*(['"])((?:(?!\1)[^\\]|\\.)+?)\1""")
# A catalogue row: either a quoted key or a bare identifier key.
#
# Matched only INSIDE the zh object literal. Scanning the whole file also picked up `locale:` and
# `key:` — translate()'s own parameters — and reported them as untranslated UI copy. A tool whose
# output contains two entries that are not real findings is a tool whose output gets skimmed.
ROW = re.compile(
    r"""^  (?:(['"])((?:(?!\1)[^\\]|\\.)+?)\1|([A-Za-z][A-Za-z0-9]*)):""", re.M
)


def main() -> int:
    files = [
        p
        for p in list(SRC.rglob("*.tsx")) + list(SRC.rglob("*.ts"))
        if ".test." not in p.name and p.resolve() != CATALOGUE.resolve()
    ]
    if not files:
        sys.exit("no source files matched — the glob stopped working")

    asked: dict[str, list[str]] = {}
    for f in files:
        for m in T_CALL.finditer(f.read_text(encoding="utf-8")):
            asked.setdefault(m.group(2).replace("\\'", "'"), []).append(
                str(f.relative_to(ROOT))
            )

    text = CATALOGUE.read_text(encoding="utf-8")
    start = text.index("const zh: Record<string, string> = {")
    end = text.index("\n}\n", start)
    known = {(quoted or bare).replace("\\'", "'") for _, quoted, bare in ROW.findall(text[start:end])}
    if not known:
        sys.exit("no catalogue rows matched — the row regex stopped working")

    missing = sorted(set(asked) - known)
    orphans = sorted(known - set(asked))

    print(f"t() call sites: {sum(len(v) for v in asked.values())}  distinct keys: {len(asked)}")
    print(f"catalogue rows: {len(known)}")
    print(f"\nMISSING from the catalogue ({len(missing)}):")
    for k in missing:
        print(f"  [{asked[k][0]}] {k}")
    print(f"\nORPHANED in the catalogue ({len(orphans)}):")
    for k in orphans:
        print(f"  {k}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
