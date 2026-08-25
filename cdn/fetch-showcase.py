"""Re-downloads the prompt-gallery assets into cdn/showcase/, ready to upload.

The media itself is not in git — 7.9 MB of jpg and mp4, and a git object survives even after a
delete. R2 is where these live and are served from; this script exists so the upload can be
repeated (a new bucket, a lost object) without hunting for the sources by hand.

Sources come from `src/lib/showcase.ts`, so the file list cannot drift from what the app renders.
The upstream is franklin.run, which is also why these are copied at all: its host is not in the
CDN Worker's copy-from allowlist, so `POST /gallery` refuses it (403) — correctly.

    python cdn/fetch-showcase.py        # download
    ./cdn/upload-showcase.ps1           # then upload, with --remote
"""

import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SRC = 'https://franklin.run/showcase/'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'showcase')
UA = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/128.0 Safari/537.36'
    )
}


def wanted() -> list[str]:
    """Every asset and poster named in showcase.ts."""
    ts = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'lib', 'showcase.ts')
    text = open(ts, encoding='utf-8').read()
    names = re.findall(r'(?:asset|poster): "([^"]+)"', text)
    return sorted(set(names))


def get(name: str) -> tuple[str, int, str]:
    path = os.path.join(OUT, name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return name, os.path.getsize(path), 'cached'
    try:
        r = urllib.request.urlopen(urllib.request.Request(SRC + name, headers=UA), timeout=90)
        data = r.read()
        # Written only after a complete read, so an interrupted download cannot leave a
        # truncated file that the next run would treat as cached and upload as a broken asset.
        with open(path, 'wb') as f:
            f.write(data)
        return name, len(data), r.headers.get('Content-Type') or ''
    except Exception as exc:
        return name, 0, f'ERROR {getattr(exc, "code", type(exc).__name__)}'


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    names = wanted()
    print(f'{len(names)} assets named in showcase.ts')

    total = 0
    failed = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for name, size, note in ex.map(get, names):
            total += size
            if size == 0:
                failed.append((name, note))

    print(f'have {len(names) - len(failed)}/{len(names)}, {total / 1024 / 1024:.2f} MB in {OUT}')
    for name, note in failed:
        print(f'  FAILED {name}: {note}')
    return 1 if failed else 0


sys.exit(main())
