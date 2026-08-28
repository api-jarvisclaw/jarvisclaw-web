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

# A lapsed control usually recovers, so it is retried rather than treated as fatal.
#
# Observed shape: 14 consecutive BOGUS requests never lapsed, but a control placed after a handful of
# LEGAL ones did. Legal requests are the ones that make the gateway probe the upstream for a real
# price, so those appear to be what exhausts whatever budget the refusal signal depends on. Waiting
# is therefore the right response, not a smaller batch.
CONTROL_ATTEMPTS = int(os.environ.get("SWEEP_CONTROL_ATTEMPTS", "4"))
BACKOFF_S = float(os.environ.get("SWEEP_BACKOFF_S", "45"))


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

    Checked per model, and again after each model's row, because validation is NOT a stable property
    of this endpoint. Whether a bogus value is rejected changes over time, and I could not determine
    what drives it.

    ## What is measured, and what is not

    The same request — `azure/sora-2` with `duration_seconds: 999` — has been observed both ways,
    minutes apart, at identical spacing:

        14 consecutive 400s over 99s at 6s spacing
        8  consecutive 402s over 128s at 8s spacing, interleaved 1:1 with seedance (which stayed 400)
        8/8 400s again later, every video model rejecting

    Three explanations were tested and each is contradicted by one of those runs:

      - Request rate. Unthrottled bursts do produce 402s (25/25), and the gateway's own source
        explains why: `isBodyRejectionStatus` excludes 429 (middleware/x402_probe_refusal.go),
        correctly, so under load the upstream's refusal degrades to a soft probe failure and a local
        estimate gets quoted. But 402s also appeared at 8s spacing with nothing else in flight.
      - Per-model. The interleaved run showed sora 402 and seedance 400 eight times out of eight,
        which looks decisive — until sora returned 400 eight times out of eight an hour later.
      - Per-call pricing (sora-2 is `per-call` at a fixed $2, so its price needs no upstream probe).
        Ruled out: seedance-2.0, 2.0-fast, 2.5, 1.5-pro and grok are all `per-call` too and reject.

    So the driver is unknown. What matters for this sweep is that it does not need to be known: the
    control establishes, at the moment of measurement, whether a 402 carries any information. When it
    does not, the sweep refuses to report a pass rather than counting quotes as acceptances. That is
    the whole point — the failure this repo keeps repeating is a clean verdict reached on a sample
    that was never examined, and an endpoint whose validation silently switches off is exactly the
    channel that produces one.
    """
    results = []
    for field, value in (("duration_seconds", 999), ("resolution", "16K"), ("aspect_ratio", "99:1")):
        status, _ = post({"model": model, "prompt": PROMPT, field: value})
        results.append(f"{field}={value!r}->{status}")
        if status != 400:
            return False, results
        time.sleep(THROTTLE_S)
    return True, results


def control_live_with_backoff(model: str) -> tuple[bool, list[str], int]:
    """control_live, retried with a growing pause.

    A lapse is usually temporary — the budget refills — so aborting the whole sweep on the first one
    throws away the run for a condition that resolves itself. Backing off recovers it; giving up
    after the last attempt records the model as UNVERIFIABLE, never as a pass.
    """
    detail: list[str] = []
    for attempt in range(CONTROL_ATTEMPTS):
        ok, detail = control_live(model)
        if ok:
            return True, detail, attempt + 1
        if attempt + 1 < CONTROL_ATTEMPTS:
            pause = BACKOFF_S * (attempt + 1)
            print(f"  control lapsed ({detail[-1]}); waiting {pause}s for it to recover")
            time.sleep(pause)
    return False, detail, CONTROL_ATTEMPTS


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

        offered_n = len(lim["durations"]) + len(
            [v for v in lim["resolutions"] + lim["aspectRatios"] if v != "default"]
        )

        # BEFORE trusting a single 402 from this model, prove it would say 400 to something.
        ok, detail, tries = control_live_with_backoff(model)
        control_runs += tries
        print(f"  control: {' '.join(detail)} -> {'validates' if ok else 'ACCEPTS ANYTHING'}")
        if not ok:
            unverifiable.append(
                f"{model}: still quoting bogus values after {tries} attempts ({detail[-1]}), so its "
                f"{offered_n} offered values cannot be verified this way — documented-only"
            )
            print(f"  -> skipping {offered_n} values: a 402 here carries no information")
            continue

        row_checked = 0
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
                row_checked += 1
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

        # Re-verify AFTER the row: validation can switch off partway through, and then the tail of
        # this row is 402s that mean nothing. The row only counts if the control held at BOTH ends.
        ok, detail, tries = control_live_with_backoff(model)
        control_runs += tries
        if not ok:
            print(f"  control after {model}: {' '.join(detail)} -> NOT VALIDATING")
            # This model's own results are discarded rather than the whole sweep aborted. They were
            # measured across an interval whose end state we cannot vouch for, so they are not
            # evidence — but the models already confirmed at both ends still are.
            checked -= row_checked
            for r in list(rejected):
                if r.startswith(f"{model} "):
                    rejected.remove(r)
            for u in list(unknown):
                if u.startswith(f"{model} "):
                    unknown.remove(u)
            unverifiable.append(
                f"{model}: the control held before its {row_checked} values but not after, so that "
                "interval cannot be vouched for — results discarded, documented-only"
            )
            continue

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
