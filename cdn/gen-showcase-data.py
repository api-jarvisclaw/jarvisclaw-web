"""Generates src/lib/showcase.ts from the extracted Franklin gallery data."""
import json

rows = json.load(open('probe/_showcase_rows.json', encoding='utf-8'))

HEAD = '''/**
 * The prompt gallery — 32 curated examples, each with the prompt that made it.
 *
 * Transcribed from franklin.run/gallery, which is a SHOWCASE rather than a history: real prompts
 * with their results, there to be read, copied and re-run. That is a different thing from the
 * gallery this app already had, which lists the media the user themselves paid for — hence two
 * tabs rather than one merged list. Merging them would put someone else's example next to your
 * own $0.40 video with no way to tell which is which.
 *
 * ATTRIBUTION IS PART OF THE DATA, not decoration. These prompts were written by named people
 * (18 distinct handles) and the video prompts come from YouMind-OpenLab/awesome-seedance-2-prompts.
 * Franklin credits every one, and so does this. `author` and `credit` are therefore required
 * reading wherever a prompt is shown.
 *
 * The `{argument name="…" default="…"}` placeholders inside the prompts are left exactly as
 * written. They mark the parts meant to be changed — a headline, a brand name — and rewriting
 * them into finished text would remove the one thing that makes a prompt reusable.
 *
 * Media lives on our own R2 under `showcase/`, not hotlinked. Two independent reasons, both
 * measured: the page's CSP allows images only from `self`, `data:` and our CDN, and the CDN
 * Worker's copy-from allowlist refuses franklin.run outright (403, host not allowed). Uploaded
 * by cdn/upload-showcase.sh; that prefix has no expiry rule, unlike `media/` which is a cache
 * and clears daily.
 */

import { CDN_BASE_URL } from './gallery'

export interface ShowcaseItem {
  slug: string
  title: string
  /** The model that produced it, as published. */
  model: string
  /** The prompt's author, when they are credited by handle. */
  author: string | null
  kind: 'image' | 'video'
  /** Filename under showcase/ on the CDN. */
  asset: string
  /** Still frame for a video, when it differs from the asset itself. */
  poster: string | null
  /**
   * The full prompt. Null for the four launch-film stills, which were assembled with a skill
   * rather than a single prompt — there is nothing to copy, and inventing one would be worse
   * than the button being absent.
   */
  prompt: string | null
  /** Upstream source for the prompt, where one is published. */
  credit: string | null
}

/** Absolute URL for a showcase asset. */
export function showcaseUrl(file: string): string {
  return `${CDN_BASE_URL}/showcase/${file}`
}

/**
 * Which generation mode a showcase item's prompt should run in.
 *
 * Mapped from the published model name rather than guessed from the media type: a still frame
 * from a video shoot is an image file describing a video prompt, and sending it to the image
 * endpoint would produce a poster of a scene instead of the scene.
 */
export function showcaseMode(item: ShowcaseItem): 'image' | 'video' {
  return /seedance/i.test(item.model) ? 'video' : 'image'
}

export const SHOWCASE: ShowcaseItem[] = '''


def js(v):
    if v is None:
        return 'null'
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    return json.dumps(v)


body = ['[']
for r in rows:
    body.append('  {')
    for k in ('slug', 'title', 'model', 'author', 'kind', 'asset', 'poster', 'prompt', 'credit'):
        body.append(f'    {k}: {js(r[k])},')
    body.append('  },')
body.append(']')

out = HEAD + '\n'.join(body) + '\n'
open('src/lib/showcase.ts', 'w', encoding='utf-8').write(out)
print('wrote src/lib/showcase.ts', len(out), 'bytes,', len(rows), 'items')
