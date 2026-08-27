"""Generates src/lib/library.ts from the extracted prompt library.

Separate from seedance.ts and showcase.ts, and the reason is the same one that kept those two
apart: these entries have NO media at all. Every seedance row has a result frame and every
showcase row has a playable asset, so both types assume an image exists. Merging this in would
make `poster` optional across all three and the first symptom of getting it wrong is a broken
image icon where a card should be — so this collection carries its own type, and the UI renders
it as what it is: text.

Input comes from extract_prompt_library.py. Run that first.

Usage: python cdn/gen-library-data.py [library.json]
"""

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
OUT = HERE.parent / "src" / "lib" / "library.ts"

HEAD = '''/**
 * The prompt library — 122 production-ready prompts for image and video generation.
 *
 * Transcribed from raojiacui/prompt-engineering-text-to-image-and-video- (MIT), whose author
 * wrote and tested these themselves. Several run to a thousand characters of shot-by-shot
 * direction with explicit camera moves, physics notes and negative prompts, which is exactly the
 * thing this product's users cannot write from a blank box.
 *
 * ## Why only this source
 *
 * Four other candidate collections were reviewed and rejected, all on licensing rather than
 * quality:
 *
 *   - phodal/understand-prompt — no licence file, so copyright is reserved by default.
 *   - yujianwudi/ai-image-prompts — no licence file, and its own 授权与使用边界 states it
 *     "does not grant any right to use third-party characters, works, trademarks, images or
 *     brand elements". Its templates are built around named anime characters and IP.
 *   - lissettecarlr/nano-banana-prompt-studio — MIT, but it is a GUI application. Its images
 *     are UI screenshots; there is no prompt collection to ingest.
 *   - zhongpei/image2text_prompt_generator — an image-TO-text tool, the inverse of what this is.
 *
 * Publishing prompts we have no licence to republish would put the IP risk on us, and a gallery
 * is a public surface.
 *
 * ## No images, deliberately
 *
 * The upstream repo ships zero images for these prompts — it is 18 markdown files. The options
 * were to generate ~122 illustrations through our own gateway at real cost, or to ship the text.
 * A generated image that does not match its prompt is worse than no image, because it
 * misrepresents what the prompt produces. So these render as text cards, and any illustration
 * added later has to be one somebody looked at.
 *
 * ## Attribution
 *
 * MIT requires the copyright notice to travel with the work. `SOURCE_URL` and `LICENSE` are
 * shown wherever this collection appears, and `sourceFile` records which of the author's own
 * documents each prompt came from.
 */

export interface LibraryPrompt {
  /** Stable id, derived from the source file and position so it survives re-extraction. */
  id: string
  /** The author's own section title, untranslated. */
  title: string
  /**
   * The prompt as published. Not reflowed, not trimmed, not translated.
   *
   * The line structure is the craft: a shot description reads as Start / Action / End because
   * that is how the model is meant to receive it.
   */
  prompt: string
  category: LibraryCategory
  /** Which endpoint this belongs to. Only the text-to-image collection is 'image'. */
  kind: 'image' | 'video'
  /**
   * The author's generation parameters (aspect_ratio, duration_s, negative, ...), when stated.
   *
   * 104 of 122 carry them. Kept as published strings rather than parsed into fields: they are
   * advice for a human choosing settings, and inventing a schema for "8-12" would lose the range.
   */
  params: Record<string, string>
  /** The author's own 用途 / 适用场景 note, where one exists. */
  intent: string | null
  /** The upstream markdown file, so a reader can find the original in context. */
  sourceFile: string
}

export type LibraryCategory =
'''

TAIL = '''
/** The upstream collection, credited wherever the library is shown. */
export const LIBRARY_SOURCE_URL =
  'https://github.com/raojiacui/prompt-engineering-text-to-image-and-video-'

/** MIT, and the notice travels with the work. */
export const LIBRARY_LICENSE = 'MIT'

/**
 * Category order for the UI: the two largest series first, then by size.
 *
 * Fixed rather than sorted by count at render time, so the tab order does not shuffle when a
 * category grows. Labels are the author's own Chinese groupings — these are curated series, and
 * a series is a better grouping than any keyword rule (the same reason inferCategory's
 * word-boundary bug was worth fixing rather than replacing with more keywords).
 */
export const LIBRARY_CATEGORIES: Array<{ id: LibraryCategory; label: string; en: string }> = [
'''


def ts_string(s: str) -> str:
    """A single-quoted TS string literal. Newlines become \\n rather than a template literal.

    Template literals would be more readable in the source but they are a hazard here: a prompt
    containing a backtick or ${ would break the file, and several of these carry both.
    """
    return "'" + (
        s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    ) + "'"


# English labels, so the tab strip reads in either language. Written out rather than machine
# translated: "梦核" is "dreamcore", a specific aesthetic, not "dream nucleus".
EN_LABELS = {
    "cinematic": "Cinematic shots",
    "food": "Food transformation",
    "dystopian": "Dystopian narrative",
    "surreal": "Surreal concepts",
    "asmr": "ASMR visuals",
    "product": "Product reveal",
    "image-style": "Image restyling",
    "xianxia": "Eastern fantasy",
    "dreamcore": "Dreamcore",
}

# Fixed display order: the two biggest series lead, then by size. See the note in TAIL.
ORDER = ["cinematic", "food", "dystopian", "surreal", "asmr", "product",
         "image-style", "xianxia", "dreamcore"]


def main() -> int:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "library.json")
    rows = json.loads(src.read_text(encoding="utf-8"))

    labels = {}
    for r in rows:
        labels[r["category"]] = r["categoryLabel"]

    missing = [c for c in labels if c not in ORDER or c not in EN_LABELS]
    if missing:
        print(f"ERROR: categories with no display order or English label: {missing}")
        print("  Add them explicitly rather than falling back to the raw id.")
        return 1

    # Ids are counted per SOURCE FILE and namespaced by it, not by category.
    #
    # Keyed on the file but numbered per category, the first version produced nine duplicate
    # ids: 魔法食物球 and 无限美食空间 are both category "food", so both restarted the category
    # counter from 1. React keys off these and duplicate keys silently drop cards.
    #
    # A title-derived slug would not work either: two files both contain a "镜头一".
    stems: dict[str, str] = {}
    seen: dict[str, int] = {}
    for r in rows:
        stem = r["sourceFile"].removesuffix(".md")
        if stem not in stems:
            # A short ASCII namespace per file, so an id is readable and stable. Derived from the
            # category plus a per-category file ordinal rather than the Chinese filename, which
            # would make an id that cannot be typed or grepped.
            same = sum(1 for s, c in stems.items() if c.startswith(r["category"]))
            stems[stem] = f"{r['category']}{same + 1 if same else ''}"
        ns = stems[stem]
        n = seen.get(ns, 0) + 1
        seen[ns] = n
        r["id"] = f"{ns}-{n:03d}"

    parts = [HEAD]
    parts.append("\n".join(f"  | '{c}'" for c in ORDER) + "\n\n")
    parts.append("export const LIBRARY: LibraryPrompt[] = [\n")
    for r in rows:
        params = ", ".join(f"{json.dumps(k)}: {ts_string(v)}" for k, v in r["params"].items())
        parts.append("  {\n")
        parts.append(f"    id: '{r['id']}',\n")
        parts.append(f"    title: {ts_string(r['title'])},\n")
        parts.append(f"    prompt: {ts_string(r['prompt'])},\n")
        parts.append(f"    category: '{r['category']}',\n")
        parts.append(f"    kind: '{r['kind']}',\n")
        parts.append(f"    params: {{{params}}},\n")
        parts.append(f"    intent: {ts_string(r['intent']) if r['intent'] else 'null'},\n")
        parts.append(f"    sourceFile: {ts_string(r['sourceFile'])},\n")
        parts.append("  },\n")
    parts.append("]\n")
    parts.append(TAIL)
    for c in ORDER:
        parts.append(f"  {{ id: '{c}', label: {ts_string(labels[c])}, "
                     f"en: {ts_string(EN_LABELS[c])} }},\n")
    parts.append("]\n")

    OUT.write_text("".join(parts), encoding="utf-8")
    print(f"wrote {OUT} — {len(rows)} prompts, {len(ORDER)} categories")
    by_cat: dict[str, int] = {}
    for r in rows:
        by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
    for c in ORDER:
        print(f"  {c:<12} {by_cat.get(c, 0):>3}  {labels[c]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
