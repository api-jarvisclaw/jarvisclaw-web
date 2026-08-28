"""Does `/v1/marketplace/audio/voices` actually serve a voice roster? Paid, once.

## Why a paid call is the only way

The 402 quote cannot answer it. The marketplace `audio` service registers a WILDCARD rule —
`GET / -> $0.001`, visible in /api/marketplace/pricing — so every path under that prefix is
priced. Measured:

    GET /v1/marketplace/audio/voices                  -> 402
    GET /v1/marketplace/audio/zzz-not-a-real-endpoint -> 402
    GET /v1/marketplace/audio/                        -> 402

A 402 therefore has zero discriminating power over whether the endpoint exists. I had claimed
"the gateway does not proxy the voices endpoint (404)" from probing `/v1/audio/voices` alone,
which does 404 — but that is one path missing, not the capability missing. The marketplace path
answers 402 and is the thing that looks available.

The repo's own note says what to expect (model/marketplace_retired_routes.go):

    // Voice is a body field. Only POST /audio/speech exists.

and that same file retires `/speech/turbo-v2`-style sub-paths, i.e. someone already made the
mistake of treating per-model names as routes. So the expectation is that `voices` is not a real
upstream resource. Expectation is not measurement, hence this.

## Criterion

    Deliverable: is there a usable voices roster behind the marketplace audio prefix?
    Criterion:   pay for BOTH /voices and a deliberately bogus sibling.
                 - real roster  => /voices returns voice data, bogus returns an error
                 - wildcard只是转发 => both return the same shape (upstream 404/HTML)
    Falsifier:   the bogus path returning voice-like data, or both returning identical bodies.
                 Either means a 200 on /voices says nothing about /voices.

The bogus control is the whole design. Without it, ANY 200 body would read as success — the same
mistake as reading the 402 as availability.

## Cost

Two GETs at $0.001 = $0.002. Charged after delivery (#561), so a failed upstream call should not
settle. Spend cap asserted before signing.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://api.jarvisclaw.ai"
WALLET = Path(os.path.expanduser("~")) / ".jarvisclaw" / "wallet.json"
SDK = Path("D:/python3_project/python-sdk")

# Hard ceiling. The quote is $0.001 per call; anything materially above that means the wildcard
# matched a different, more expensive rule and this probe should abort rather than pay it.
MAX_ATOMIC_PER_CALL = 5_000  # 0.005 USDC

PATHS = [
    ("/v1/marketplace/audio/voices", "the endpoint in question"),
    ("/v1/marketplace/audio/zz-bogus-never-existed", "CONTROL — must not look like a roster"),
]


def load_signer():
    sys.path.insert(0, str(SDK))
    from jarvisclaw.x402 import X402Signer  # noqa: PLC0415

    key = json.loads(WALLET.read_text())["privateKey"]
    return X402Signer(key)


class Resp:
    """Minimal shim: X402Signer.sign_from_402 wants .headers and .json()."""

    def __init__(self, headers, body):
        self.headers = headers
        self._body = body

    def json(self):
        return self._body


def quote(path: str) -> tuple[int, dict, dict]:
    req = urllib.request.Request(
        BASE + path, headers={"User-Agent": "Mozilla/5.0 (jarvisclaw-probe)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return res.status, dict(res.headers), json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            body = json.loads(raw or b"{}")
        except Exception:  # noqa: BLE001
            body = {"__raw__": raw[:400].decode("utf8", "replace")}
        return e.code, dict(e.headers), body


def paid_get(path: str, signature: str) -> tuple[int, str]:
    """The FULL body, not a slice.

    This was `read()[:3000]` and it produced a wrong verdict on a correct measurement: the roster
    came back complete, the truncation cut it mid-object, `json.loads` failed, and the probe
    reported "no list of named voices" about a response that plainly contained one. A judge that
    parses its input must be given all of it — truncating for display is fine, truncating before
    the parse turns a real answer into a fabricated negative.
    """
    req = urllib.request.Request(
        BASE + path,
        headers={
            "User-Agent": "Mozilla/5.0 (jarvisclaw-probe)",
            "X-PAYMENT": signature,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            return res.status, res.read().decode("utf8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf8", "replace")


def looks_like_roster(body: str) -> tuple[bool, str]:
    """Does this body contain a list of named voices?

    Deliberately structural rather than a substring hunt: the point is "a roster of voices",
    which means several entries each carrying a name or id.
    """
    try:
        data = json.loads(body)
    except Exception:  # noqa: BLE001
        return False, "not JSON"
    rows = None
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        for key in ("voices", "data", "items", "results"):
            if isinstance(data.get(key), list):
                rows = data[key]
                break
    if not rows:
        return False, f"no list of entries (keys: {list(data)[:6] if isinstance(data, dict) else type(data)})"
    named = [r for r in rows if isinstance(r, dict) and (r.get("voice_id") or r.get("name") or r.get("id"))]
    if len(named) < 2:
        return False, f"{len(rows)} entries, {len(named)} with a name/id"
    return True, f"{len(named)} named entries of {len(rows)}"


def shipped_voices() -> list[str]:
    """The ids SPEECH_VOICES.elevenlabs actually offers, read from the TypeScript source."""
    root = Path(__file__).resolve().parent.parent
    script = root / "voices.probe.mjs"
    script.write_text(
        "import { SPEECH_VOICES } from './src/lib/modality.ts'\n"
        "console.log(JSON.stringify(SPEECH_VOICES.elevenlabs.map(v => v.id)))\n",
        encoding="utf8",
    )
    try:
        run = subprocess.run(
            ["npx", "tsx", str(script)],
            cwd=root, capture_output=True, text=True, timeout=180, shell=True,
        )
        if run.returncode != 0:
            raise SystemExit(f"could not read SPEECH_VOICES:\n{run.stderr[-500:]}")
        return json.loads(run.stdout.strip().splitlines()[-1])
    finally:
        script.unlink(missing_ok=True)


def check_parity(body: str) -> int:
    """The shipped table must match the live roster — that is the point of paying for it.

    The table exists because reading the roster costs $0.001 and an anonymous visitor has no wallet,
    so the UI cannot fetch it to fill a dropdown. This is what keeps the copy honest: an alias or a
    voice_id the upstream retires, or a new voice it adds, shows up here as a FAIL.
    """
    rows = json.loads(body)["data"]
    live_ids = {r.get("alias") or r["voice_id"] for r in rows}
    live_all = {r["voice_id"] for r in rows} | {r["alias"] for r in rows if r.get("alias")}
    mine = shipped_voices()

    invalid = [v for v in mine if v not in live_all]
    missing = sorted(live_ids - set(mine))
    print(f"shipped {len(mine)} voices, upstream serves {len(rows)}")
    if invalid:
        print(
            f"FAIL: {len(invalid)} shipped voice(s) the upstream does not have: {invalid}\n"
            "       An out-of-roster name settles the payment and is THEN refused, so each of these "
            "is a way to lose money, not just a call."
        )
        return 1
    if missing:
        print(
            f"FAIL: {len(missing)} voice(s) served but not offered: {missing}\n"
            "       Unreachable from the UI — the roster and the table have drifted."
        )
        return 1
    print(f"PASS: all {len(mine)} shipped voices are in the live roster, and none is missing")
    return 0


def main() -> int:
    if not WALLET.exists():
        print(f"FAIL: no wallet at {WALLET}")
        return 1

    signer = load_signer()
    print(f"payer: {signer.address}")
    print(f"cap:   {MAX_ATOMIC_PER_CALL} atomic per call\n")

    results = {}
    spent = 0
    for path, why in PATHS:
        print(f"== {path}")
        print(f"   ({why})")
        status, headers, body = quote(path)
        if status != 402:
            print(f"   quote -> {status}, not 402. Body: {json.dumps(body)[:200]}")
            results[path] = (status, json.dumps(body)[:2000])
            continue

        amount = int(
            (body.get("accepts") or [{}])[0].get("amount")
            or (body.get("accepts") or [{}])[0].get("maxAmountRequired")
            or 0
        )
        print(f"   quote -> 402, {amount} atomic (${amount / 1e6:.4f})")
        if amount <= 0 or amount > MAX_ATOMIC_PER_CALL:
            print(f"   REFUSING to sign {amount} — above the {MAX_ATOMIC_PER_CALL} cap")
            results[path] = (-1, f"refused: {amount} atomic above cap")
            continue

        sig = signer.sign_from_402(Resp(headers, body), BASE + path)
        code, text = paid_get(path, sig)
        spent += amount
        print(f"   paid  -> {code}, {len(text)} bytes")
        print(f"   body  : {text[:300]}")
        results[path] = (code, text)
        print()

    # ---- verdict ----
    print("=" * 72)
    print(f"spent: up to {spent} atomic (${spent / 1e6:.4f}) — settlement is after delivery, so a")
    print("       failed upstream call should not have charged")
    print()

    real_path, bogus_path = PATHS[0][0], PATHS[1][0]
    real = results.get(real_path)
    bogus = results.get(bogus_path)
    if real is None or bogus is None:
        print("FAIL: one of the two calls never completed — nothing can be concluded")
        return 1

    real_roster, real_why = looks_like_roster(real[1])
    bogus_roster, bogus_why = looks_like_roster(bogus[1])
    print(f"/voices      -> {real[0]}  roster={real_roster}  ({real_why})")
    print(f"bogus sibling-> {bogus[0]}  roster={bogus_roster}  ({bogus_why})")
    print()

    if bogus_roster:
        print(
            "INCONCLUSIVE: the BOGUS path also returns roster-shaped data, so a roster from "
            "/voices would not be evidence that /voices exists. Same defect as reading the 402 "
            "as availability."
        )
        return 1
    if real[1] == bogus[1]:
        print(
            "ANSWER: NO usable voices endpoint. /voices and a path that was never registered "
            "return byte-identical responses, so the marketplace prefix is forwarding both to the "
            "same place — the wildcard priced them, nothing served them."
        )
        return 0
    if real_roster:
        print(f"ANSWER: YES — /voices serves a roster ({real_why}); the bogus sibling does not.\n")
        return check_parity(real[1])
    print(
        f"ANSWER: NO usable roster. /voices answered {real[0]} with no list of named voices "
        f"({real_why}); it differs from the bogus path, so the difference is recorded above rather "
        "than claimed either way."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
