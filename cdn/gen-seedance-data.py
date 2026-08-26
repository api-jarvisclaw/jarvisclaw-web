"""Generates src/lib/seedance.ts from the parsed README rows.

Kept separate from showcase.ts rather than appended to it. The two collections differ in a way
that matters to the UI: every Franklin item has playable media, while 100 of these 105 have a
still and a prompt and no video we can serve. Merging them would mean threading that distinction
through a type that currently does not need it, and the first symptom of getting it wrong is a
play button over a frame that never moves — the same defect class as the paid video that rendered
a dead player.
"""

import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
ROWS = HERE / "_seedance_rows.json"
SHOWCASE = HERE / "showcase"
OUT = HERE.parent / "src" / "lib" / "seedance.ts"

HEAD = '''/**
 * The Seedance 2.0 prompt collection — 105 published video prompts, each with its result frame.
 *
 * Transcribed from YouMind-OpenLab/awesome-seedance-2-prompts (CC BY 4.0), which collects prompts
 * people published on X along with the clips they produced. These are the reference material for
 * the hardest thing to write in this product: a video prompt that actually holds together. Several
 * run to thousands of words of shot-by-shot direction, which is exactly why reading a real one
 * beats staring at an empty box.
 *
 * ## Their statistics table says 6,156. This has 105, and that is the honest ceiling
 *
 * The 6,156 figure counts their Payload CMS, which is behind `CMS_API_KEY`. The README is the
 * published artifact and it carries ~105 entries. Shipping 105 while implying 6,156 would be a
 * gap nobody notices until they count, so: 105, from the public source, in full.
 *
 * ## Why `playable` exists
 *
 * Only 5 entries have an MP4 (published on the repo's GitHub Releases). The other 100 have
 * Cloudflare Stream or twimg stills only — measured, `/downloads/default.mp4` on those Stream ids
 * answers 404 and only HLS manifests exist, and playing HLS needs a JS player this page's CSP has
 * no reason to admit.
 *
 * So `playable` is false for those 100 and the UI must render them as a still with a prompt,
 * NEVER as a video element with a poster. A play control over a frame that cannot move is the
 * same defect that made a paid $0.83 video look like a charge for nothing, and it is worse here
 * because it would be by construction rather than by accident.
 *
 * ## Attribution is data, not decoration
 *
 * CC BY 4.0 requires it and it is the right thing regardless: every prompt here was written by a
 * named person and links to the post it came from. `author`, `authorLink` and `source` are
 * required reading wherever a prompt is shown.
 *
 * Media is on our own R2 under `showcase/`, uploaded by cdn/upload-showcase.ps1. That prefix has
 * no expiry rule; `media/` clears daily and would delete all of this overnight.
 */

import { CDN_BASE_URL } from './gallery'

export interface SeedancePrompt {
  /** Upstream prompt id, which is also the asset filename stem. */
  id: number
  title: string
  /** The prompt itself, as published. Not reflowed or trimmed — the formatting is the craft. */
  prompt: string
  /** Filename under showcase/ for the result frame. Every entry has one. */
  poster: string
  /**
   * Filename under showcase/ for the clip, or null when no servable video exists.
   *
   * Null for 100 of 105. See the note above: those upstreams publish HLS only, and a video
   * element with a poster and no source is a dead player.
   */
  video: string | null
  /** Whether a clip can actually play. Derived from `video`, stated so no caller has to infer it. */
  playable: boolean
  author: string | null
  authorLink: string | null
  /** The post the prompt was published in. */
  source: string | null
  published: string | null
  /** The language the prompt was WRITTEN in; the text here is the collection's English rendering. */
  lang: 'zh' | 'en'
}

/** Absolute URL for a seedance asset. Shares the showcase/ prefix and its no-expiry rule. */
export function seedanceUrl(file: string): string {
  return `${CDN_BASE_URL}/showcase/${file}`
}

/**
 * The collection's own source, shown once in the UI.
 *
 * A per-item `source` credits the prompt's author; this credits the people who assembled the
 * collection. CC BY 4.0 asks for both, and they are genuinely different contributions.
 */
export const SEEDANCE_COLLECTION_URL =
  'https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts'

export const SEEDANCE: SeedancePrompt[] = [
'''

TAIL = ''']

/** Only the entries whose clip can actually play. */
export const SEEDANCE_PLAYABLE = SEEDANCE.filter((p) => p.playable)
'''


def js(s):
    """A JS string literal. json.dumps handles the escaping, including the newlines these
    prompts are full of — hand-rolled quoting is how a stray backslash breaks a build."""
    if s is None:
        return 'null'
    return json.dumps(s, ensure_ascii=False)


def clean_title(t):
    # Strip the collection's own ordinal ("No. 1: ..."), which numbers a position in THEIR
    # featured list and means nothing in ours.
    return re.sub(r'^No\.\s*\d+:\s*', '', t).strip()


def main() -> int:
    rows = json.loads(ROWS.read_text(encoding='utf-8'))
    print(f'{len(rows)} rows')

    out = [HEAD]
    kept = 0
    skipped = []
    for r in rows:
        poster = f"sd-{r['id']}-poster.jpg"
        if not (SHOWCASE / poster).exists():
            # An entry without a downloaded frame is dropped rather than shipped pointing at a
            # missing asset. A broken tile reads as a bug in our page, not a gap upstream.
            skipped.append((r['id'], 'no poster on disk'))
            continue
        video = f"sd-{r['id']}.mp4"
        has_video = (SHOWCASE / video).exists()

        out.append('  {\n')
        out.append(f"    id: {r['id']},\n")
        out.append(f"    title: {js(clean_title(r['title']))},\n")
        out.append(f"    prompt: {js(r['prompt'])},\n")
        out.append(f"    poster: {js(poster)},\n")
        out.append(f"    video: {js(video) if has_video else 'null'},\n")
        out.append(f"    playable: {'true' if has_video else 'false'},\n")
        out.append(f"    author: {js(r['author'])},\n")
        out.append(f"    authorLink: {js(r['authorLink'])},\n")
        out.append(f"    source: {js(r['source'])},\n")
        out.append(f"    published: {js(r['published'])},\n")
        out.append(f"    lang: {js(r['lang'])},\n")
        out.append('  },\n')
        kept += 1

    out.append(TAIL)
    OUT.write_text(''.join(out), encoding='utf-8')

    playable = sum(1 for r in rows if (SHOWCASE / f"sd-{r['id']}.mp4").exists())
    print(f'wrote {OUT}')
    print(f'  entries  {kept}')
    print(f'  playable {playable}')
    print(f'  chinese  {sum(1 for r in rows if r["lang"] == "zh")}')
    print(f'  bytes    {OUT.stat().st_size / 1e6:.2f}MB')
    if skipped:
        print(f'  skipped  {len(skipped)}: {skipped[:5]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
