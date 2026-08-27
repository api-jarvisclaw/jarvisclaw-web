"""Serve dist/ with the real _headers applied, so the CSP is exercised before deploy.

Cloudflare Pages applies public/_headers at the edge. Nothing local does, which means a
CSP that blocks the app's own gateway calls builds fine, tests fine, and fails only once
it is live — as an opaque browser error with no stack trace.

This is the smallest thing that closes that gap: a static server that reads _headers and
sends them, so the browser enforces the deployed policy against the deployed bundle.
"""

import re
import sys
from functools import partial
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(__file__).resolve().parent.parent / "dist"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4173


def parse_headers(path: Path) -> list[tuple[re.Pattern[str], str, str]]:
    """Reads Cloudflare's _headers format into (path pattern, name, value) rules.

    Only the subset this project uses: a bare glob line followed by indented
    `Name: value` lines. Comments and blanks are skipped.
    """
    rules: list[tuple[re.Pattern[str], str, str]] = []
    pattern: re.Pattern[str] | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if not raw.startswith((" ", "\t")):
            # A glob line. Only `*` is meaningful here, and it matches any suffix.
            pattern = re.compile("^" + re.escape(raw.strip()).replace(r"\*", ".*") + "$")
            continue
        if pattern is None or ":" not in raw:
            continue
        name, _, value = raw.strip().partition(":")
        rules.append((pattern, name.strip(), value.strip()))
    return rules


RULES = parse_headers(DIST.parent / "public" / "_headers")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        """SPA fallback, matching the Worker's `not_found_handling: single-page-application`.

        Needed the moment this app gained routes: `/chat` is not a file, so without this the probe
        gets a 404 page and every assertion about the console reports as a missing element. That is
        a probe defect that looks exactly like a broken app — the same one that cost a run on the
        main site's homepage.

        Rewritten in `do_GET`, NOT `send_head`: the 404 for a missing extensionless path is produced
        before send_head runs, so an override there sits doing nothing. Confirmed by logging.

        Only extensionless paths fall back. A missing /assets/x.js must stay a 404, or a broken
        asset reference becomes a confusing parse error instead.
        """
        target = self.translate_path(self.path)
        if not os.path.exists(target) and "." not in os.path.basename(target):
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self) -> None:
        for pattern, name, value in RULES:
            if pattern.match(self.path.split("?")[0]):
                self.send_header(name, value)
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # noqa: A002
        # Quiet: the point of this server is the browser's console, not its own.
        pass


if __name__ == "__main__":
    if not DIST.is_dir():
        raise SystemExit("dist/ is missing — run `bun run build` first")
    handler = partial(Handler, directory=str(DIST))
    print(f"serving {DIST} on http://localhost:{PORT} with {len(RULES)} header rules")
    ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
