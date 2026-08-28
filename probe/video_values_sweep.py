"""Every video value the UI offers must be one the gateway accepts.

## Why this can be checked for free, when the image parameters cannot

The 402 quote validates NOTHING on the image endpoint — measured directly:

    {"quality": "hd"}    -> 402, $0.064   (a documented 400 downstream)
    {"quality": "zzzz"}  -> 402, $0.064
    {"size": "3x3"}      -> 402, $0.064

But the VIDEO endpoint validates before quoting:

    sora-2 + duration_seconds: 30  -> 400 "not accepted as-is"
    sora-2 + duration_seconds: 8   -> 402 $0.84
    2.0-fast + resolution: 4K      -> 400
    grok + aspect_ratio: 21:9      -> 400

That asymmetry is what makes this sweep possible: a 402 means the value is accepted, a 400 means it
is rejected, and neither spends anything. It is the only free criterion available anywhere in this
parameter surface, so it is worth using exhaustively.

## What was previously unverified

VIDEO_LIMITS was read from BlockRun's API reference and only two points were exercised with real
paid calls (duration_seconds: 10 -> a 10.05s file; resolution: 480p -> half price). Everything else
was documented-only, and the docs have been wrong before — the IMAGE reference documents
`standard`/`hd` for quality, which is exactly the value the running service rejects.

    Deliverable: every value a user can pick must be one the model accepts.
    Criterion:   402 for each offered (model, field, value); 400 for a control bogus value.
    Falsifier:   a 400 on an offered value (we advertise something that fails), or a 402 on the
                 bogus control (validation is not happening and this sweep proves nothing).

The bogus control is load-bearing. Without it a gateway that answered 402 to everything would make
every case "pass" — the empty-feed shape that has produced false all-clears in this repo before.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://api.jarvisclaw.ai"
ROOT = Path(__file__).resolve().parent.parent


def offered_limits() -> dict:
    """Read VIDEO_LIMITS out of the TypeScript source itself, via tsx.

    Not a checked-in JSON copy. A copy is a second source of truth that drifts silently — and a
    sweep that measures the copy while the UI offers something else would report a clean pass on
    values nobody can pick. Same reasoning as the showcase manifest: derive it, do not duplicate it.
    """
    script = ROOT / "vlimits.probe.mjs"
    script.write_text(
        "import { VIDEO_LIMITS, videoLimitsFor } from './src/lib/modality.ts'\n"
        "const out = {}\n"
        "for (const m of [...Object.keys(VIDEO_LIMITS), 'auto/video']) out[m] = videoLimitsFor(m)\n"
        "console.log(JSON.stringify(out))\n",
        encoding="utf8",
    )
    try:
        raw = subprocess.run(
            ["npx", "tsx", str(script)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=180,
            shell=True,
        )
        if raw.returncode != 0:
            raise SystemExit(f"could not read VIDEO_LIMITS from source:\n{raw.stderr[-600:]}")
        limits = json.loads(raw.stdout.strip().splitlines()[-1])
    finally:
        script.unlink(missing_ok=True)
    if len(limits) < 5:
        raise SystemExit(f"only {len(limits)} models read from source — refusing to sweep on that")
    return limits


LIMITS = offered_limits()

# Enough of a prompt that a rejection cannot be blamed on the prompt itself.
PROMPT = "a calm sea at sunset, slow dolly forward"

# Seconds between requests. NOT politeness — correctness. Unthrottled, the upstream answers 429, the
# gateway treats that as a soft probe failure (429 is excluded from isBodyRejectionStatus, correctly)
# and quotes a local estimate instead, so every bogus value "passes".
#
# Measured: 25/25 bogus values accepted back-to-back; 10/10 rejected at 6s. 4s was not enough — a
# sweep at 4s lapsed after three values. 6 is the smallest spacing observed to hold.
THROTTLE_S = float(os.environ.get("SWEEP_THROTTLE_S", "6"))


def post(body: dict) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{BASE}/v1/videos/generations",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (probe)"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return res.status, ""
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:160].decode("utf8", "replace")
    except Exception as exc:  # noqa: BLE001
        return -1, str(exc)[:120]


def control_live(model: str) -> tuple[bool, list[str]]:
    """Does validation happen FOR THIS MODEL, right now?

    Checked per model and re-checked as the sweep goes, because validation is NOT a stable property
    of this endpoint. It is a property of the request rate.

    ## Request rate is the whole variable

    Measured on `azure/sora-2` with a bogus `duration_seconds: 999`:

        back to back                 -> 402 twelve times out of twelve
        spaced 6s apart              -> 400 ten times out of ten

    And the same on `bytedance/seedance-2.0`: 25/25 accepted unthrottled, 6/6 rejected spaced.

    I first read this as a per-model difference — "sora-2 validates nothing" — because the sora
    samples happened to come from a burst and the seedance ones from spaced calls. Two variables were
    moving at once. With the rate held fixed, every model validates.

    The mechanism is in the gateway's own source: `isBodyRejectionStatus` excludes 429
    (middleware/x402_probe_refusal.go) — correctly, since load is not the caller's payload problem —
    so under rate limiting the upstream's refusal degrades to a soft probe failure. That file's own
    comment names the outcome: "a 402 quote for a request that cannot be fulfilled".

    Hence a 402 carries information only while this model's control is red, which is why the control
    runs before AND after each model's row. Checking once at the start would let the sweep drift into
    the permissive state and report a clean verdict on a sample it never actually examined.
    """
    results = []
    for field, value in (("duration_seconds", 999), ("resolution", "16K"), ("aspect_ratio", "99:1")):
        status, _ = post({"model": model, "prompt": PROMPT, field: value})
        results.append(f"{field}={value!r}->{status}")
        if status != 400:
            return False, results
        time.sleep(THROTTLE_S)
    return True, results


def main() -> int:
    checked = 0
    rejected: list[str] = []
    unknown: list[str] = []
    control_runs = 0

    unverifiable: list[str] = []

    # ---- every offered value ----
    print("\n== every value the UI offers ==")
    for model, lim in LIMITS.items():
        if model == "auto/video":
            # A virtual: the gateway resolves it per request, so a rejection here would not name a
            # model and the intersection is already covered by its members.
            print(f"\n{model}: skipped (virtual — resolved upstream, members covered above)")
            continue
        print(f"\n{model}")

        # BEFORE trusting a single 402 from this model, prove it would say 400 to something.
        ok, detail = control_live(model)
        control_runs += 1
        print(f"  control: {' '.join(detail)} -> {'validates' if ok else 'ACCEPTS ANYTHING'}")
        if not ok:
            n = len([v for v in lim["durations"]]) + len(
                [v for v in lim["resolutions"] + lim["aspectRatios"] if v != "default"]
            )
            unverifiable.append(
                f"{model}: quotes bogus values too ({detail[-1]}), so its {n} offered values cannot "
                "be verified this way — they remain documented-only"
            )
            print(f"  -> skipping {n} values: a 402 from this model carries no information")
            continue

        for field, values in (
            ("duration_seconds", lim["durations"]),
            ("resolution", lim["resolutions"]),
            ("aspect_ratio", lim["aspectRatios"]),
        ):
            for value in values:
                if value == "default":
                    # The UI's own sentinel: buildBody omits the field entirely, so there is
                    # nothing on the wire to validate.
                    continue
                status, msg = post({"model": model, "prompt": PROMPT, field: value})
                checked += 1
                if status == 402:
                    mark = "ok"
                elif status == 400:
                    mark = "REJECTED"
                    rejected.append(f"{model} {field}={value!r} -> 400 {msg[:70]}")
                else:
                    mark = f"?{status}"
                    unknown.append(f"{model} {field}={value!r} -> {status} {msg[:70]}")
                print(f"  {field:17} {str(value):9} -> {status} {mark}")
                # Spaced out on purpose: back-to-back requests push the upstream into 429, the
                # gateway prices from an estimate, and every value starts "passing".
                time.sleep(THROTTLE_S)

        # Re-verify AFTER the row too: rate limiting can switch validation off partway through, and
        # then the tail of this row is 402s that mean nothing.
        ok, detail = control_live(model)
        control_runs += 1
        if not ok:
            print(f"  control after {model}: {' '.join(detail)} -> NOT VALIDATING")
            print(
                f"\nFAIL: validation lapsed partway through, after {checked} values. Everything "
                "quoted since the previous control check is unverified — reporting a pass on it "
                "would be a clean verdict on a sample that was never actually examined. Retry with "
                "a larger SWEEP_THROTTLE_S."
            )
            return 1

    print()
    print(f"VERIFIED:     {checked} offered values, each preceded and followed by a live control")
    print(f"controls run: {control_runs} (2 per model — before and after its row)")
    if unverifiable:
        # Reported prominently, NOT as a pass. These are values the UI offers whose acceptance this
        # method cannot establish, because the model quotes bogus values too.
        print(f"UNVERIFIABLE: {len(unverifiable)} model(s) — the sweep has no power over these:")
        for u in unverifiable:
            print(f"   {u}")
    if checked == 0:
        print("FAIL: nothing was checked — a zero sample is never a pass")
        return 1
    if unknown:
        print(f"INCONCLUSIVE ({len(unknown)}):")
        for u in unknown:
            print(f"   {u}")
    if rejected:
        print(f"FAIL ({len(rejected)} offered values the gateway rejects):")
        for r in rejected:
            print(f"   {r}")
        return 1
    if unknown:
        return 1
    print(
        f"PASS: {checked} offered values quote a price under a control proven to reject bogus ones"
        + (f"; {len(unverifiable)} model(s) remain documented-only" if unverifiable else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
