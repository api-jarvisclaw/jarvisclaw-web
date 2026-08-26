"""Downloads the seedance prompt-gallery media into cdn/showcase/ ready for upload.

Copied to our own R2 rather than hotlinked, for two reasons that are both measured rather than
cautious:

  - the page's CSP allows images from `self`, `data:` and our CDN only. Hotlinking pbs.twimg.com
    means either a blank tile or widening the policy to a host we do not control.
  - the media belongs to other people's accounts. A deleted tweet or a rotated Cloudflare Stream
    id turns a gallery item into a hole, and the gallery's whole job is to look reliable.

The CDN Worker's copy-from allowlist refuses all three source hosts (it takes a URL, not bytes, so
it can only re-host from hosts we already trust). Hence downloading here and uploading with
wrangler, the same route the Franklin gallery took.

What each entry gets:
  - a poster JPEG, always. Every one of the 105 entries has a usable still.
  - an MP4, for the 5 entries whose video is published on GitHub Releases. The other 100 have
    Cloudflare Stream HLS only — no direct MP4 (measured: /downloads/default.mp4 -> 404, only
    manifest/video.m3u8 and .mpd), and playing HLS needs a JS player the CSP has no reason to
    admit. So those are poster-plus-prompt, and the UI must say so rather than render a play
    button over a still.
"""

import json
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).parent
ROWS = HERE / "_seedance_rows.json"
OUT = HERE / "showcase"


def get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def main() -> int:
    rows = json.loads(ROWS.read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)
    print(f"{len(rows)} entries -> {OUT}")

    ok = 0
    failed = []
    for i, r in enumerate(rows, 1):
        slug = f"sd-{r['id']}"
        poster = OUT / f"{slug}-poster.jpg"
        if not poster.exists():
            try:
                b = get(r["thumbnail"])
                # A tiny response is an error page, not an image. Writing it would give a broken
                # tile that looks like a layout bug rather than a failed download.
                if len(b) < 2000:
                    raise ValueError(f"suspiciously small ({len(b)}B)")
                poster.write_bytes(b)
            except Exception as e:
                failed.append((slug, "poster", str(e)))
                print(f"  [{i:>3}] {slug} POSTER FAILED {e}")
                continue

        if r["video"]:
            mp4 = OUT / f"{slug}.mp4"
            if not mp4.exists():
                try:
                    b = get(r["video"], timeout=300)
                    if len(b) < 20000:
                        raise ValueError(f"suspiciously small ({len(b)}B)")
                    mp4.write_bytes(b)
                except Exception as e:
                    # NOT fatal for the entry: it still has a poster and a prompt, which is the
                    # same shape as the 100 entries that never had an MP4. Dropping the whole
                    # entry over a missing video would lose a usable prompt.
                    failed.append((slug, "video", str(e)))
                    print(f"  [{i:>3}] {slug} video failed, keeping poster: {e}")

        ok += 1
        if i % 20 == 0:
            print(f"  [{i:>3}/{len(rows)}] …")

    posters = len(list(OUT.glob("sd-*-poster.jpg")))
    videos = len(list(OUT.glob("sd-*.mp4")))
    total = sum(f.stat().st_size for f in OUT.glob("sd-*"))
    print(f"\nposters {posters}  videos {videos}  bytes {total / 1e6:.1f}MB")
    if failed:
        print(f"\n{len(failed)} failures:")
        for slug, what, err in failed[:15]:
            print(f"  {slug} {what}: {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
