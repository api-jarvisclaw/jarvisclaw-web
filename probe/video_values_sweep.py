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
# ## What is OBSERVED — no mechanism claimed
#
# Bogus requests do not disturb the control: 14 consecutively, all rejected. A legal request does,
# and on azure/sora-2 a single one is enough:
#
#     4s:  bogus=400  legal=402  bogus=402   <- rejection stopped happening right here
#     8s:  bogus=402  ...                    <- and did not come back within the row
#
# Recovery timed at 250s.
#
# ## The mechanism: the gateway's probe cache, and the parameters are not in its key
#
# middleware/x402_price_probe.go keys cached upstream prices on
#
#     method : baseURL/path : model : max_tokens : inputScale
#
# with a 5 minute TTL — which matches the 250s recovery. `duration_seconds`, `resolution` and
# `aspect_ratio` appear NOWHERE in that key. So a legal request and a bogus one with the same model
# and the same prompt land in the SAME slot: the first fills it, the second is answered from cache
# and the upstream is never asked, so its rejection cannot come back.
#
# Confirmed by varying only the part of the key that does exist:
#
#     legal 8s,   prompt A                 -> 402   (fills the slot)
#     bogus 999,  prompt A  (same slot)    -> 402   <- upstream never consulted
#     bogus 999,  prompt B  (diff length)  -> 400   <- different slot, upstream asked, refusal returns
#
# I first called this "an allowance being spent", which reads as though a counter had been found;
# none had. That framing also produced a wrong claim — "the earlier models drained a shared budget
# and sora is first" — disproved by sweeping sora alone. The honest position at that point was "I do
# not know why", and the answer turned out to be in our own source rather than upstream behaviour.
#
# ## The same defect overcharges real users, and is NOT this probe's problem to fix
#
# Two callers wanting different videos share one slot for 5 minutes, so whoever probes first sets the
# other's price — and video price DOES vary with these fields (measured: `resolution: 480p` settles
# at exactly half, 284,370 against 568,240). The identical bug was already found and fixed for TTS
# by adding `inputScale` to the key; see that file's own note about 10/150/1000/1680 chars all
# quoting 89201, "the 10-char caller overpaid 45x". Video's fields have not been added. Worse, a
# bogus value can be handed a valid 402 from cache, which is the "quote for a request that cannot be
# fulfilled" that file opens by warning about.
#
# That belongs in the gateway. Here it only means a 402 is trustworthy exactly when a bogus value in
# the SAME cache slot was just rejected — which is what the control establishes, and why it must run
# immediately before the measurement rather than once per session.
CONTROL_ATTEMPTS = int(os.environ.get("SWEEP_CONTROL_ATTEMPTS", "4"))
BACKOFF_S = float(os.environ.get("SWEEP_BACKOFF_S", "45"))

# Models where a single legal request stops the control from rejecting, so the batch loop cannot
# verify them at all: waiting for the
# control between EVERY value is the only cadence that works. Kept as a list rather than applied to
# everything because it costs ~5 minutes per value, and the other seven models sweep fine in a row.
PER_VALUE_COOLDOWN = {m for m in os.environ.get("SWEEP_SLOW_MODELS", "azure/sora-2").split(",") if m}


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

    A lapse is usually temporary — rejection starts happening again — so aborting the whole sweep on it
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


# Distinguishes this RUN's prompt lengths from any other run's within the cache TTL.
#
# The lengths have to be unique across runs, not just within one. Slot numbers restart per model, and
# the cache key holds the model, so a second run within 5 minutes reuses the same (model, length)
# pairs the first one filled — which is exactly what happened: 5 values were SKIPPED because a sweep
# of sora minutes earlier had already filled the slots that run wanted. Retested in fresh lengths,
# all five passed with their controls at 400.
#
# Correctly reported rather than silently passed, which is the point: the probe said "this slot quotes
# bogus values too" instead of counting 402s it could not vouch for.
RUN_SALT = int(time.time()) % 2000


def slotted_prompt(n: int) -> str:
    """A prompt whose LENGTH is unique to this value, in this run.

    `inputScale` is part of the gateway's probe cache key, so a distinct prompt length means a
    distinct cache slot — and an unfilled slot is probed against the upstream for real. That is what
    removes the wait: instead of ~250s for a shared slot to expire, each value gets its own.

    The padding is trailing filler on a genuine prompt so the request stays one the upstream would
    serve. Only its length is load-bearing.
    """
    return f"{PROMPT} {'x' * (3 + RUN_SALT + n * 7)}"


def control_in_slot(model: str, prompt: str) -> bool:
    """Is a bogus value rejected IN THIS SLOT, right now?

    Same prompt as the value about to be measured, so the control and the measurement share a cache
    slot. That is the whole point: a control taken in a different slot says nothing about whether the
    answer to THIS request came from the upstream or from cache.

    Only `duration_seconds: 999` is used. The question is binary — is the refusal signal reaching us
    — and each extra field is another request.
    """
    status, _ = post({"model": model, "prompt": prompt, "duration_seconds": 999})
    return status == 400


def sweep_one_at_a_time(model: str, lim: dict) -> tuple[int, list[str]]:
    """Verify a model one value at a time, each in its own probe-cache slot.

    The batch loop cannot do these: after the first legal value, everything else with the same model
    and prompt is answered from that one cache entry, so bogus values get quoted too and no 402 in
    the row means anything.

    The fix is not patience, it is a fresh slot per value. `inputScale` is part of the cache key, so
    a distinct prompt LENGTH puts each value in a slot of its own, gets it probed upstream for real,
    and lets its own control be taken in the same slot. That turned a ~20 minute run of ~250s waits
    into about 20 seconds, with STRONGER evidence: the control now shares the measurement's slot
    instead of merely preceding it in time.

    On sora-2 the row ends with `duration_seconds: 5` — not a nonsense number like 999 but the length
    every OTHER video model accepts, and the value this code hard-coded as its fallback until it was
    fixed. Sora rejecting 5 while taking 4, 8 and 12 is positive evidence that the set is discrete.
    """
    print("  (one slot per value: distinct prompt lengths, so no value inherits another's price)")
    checked = 0
    rejected: list[str] = []
    slot = 0

    def measure(field: str, value, *, expect_reject: bool = False) -> None:
        nonlocal checked, slot
        slot += 1
        prompt = slotted_prompt(slot)
        if not control_in_slot(model, prompt):
            print(f"  {field:17} {str(value):9} -> SKIPPED: this slot quotes bogus values too")
            return
        status, msg = post({"model": model, "prompt": prompt, field: value})
        if expect_reject:
            verdict = "rejected — the discrete set is real" if status == 400 else f"ACCEPTED ({status})"
            print(f"  neighbour control  {str(value):9} -> {status} {verdict}")
            if status != 400:
                rejected.append(
                    f"{model} {field}={value!r} -> {status}: accepted a value our table says it "
                    "rejects, so the set is not discrete and VIDEO_LIMITS is wrong here"
                )
            return
        checked += 1
        if status == 402:
            mark = "ok"
        elif status == 400:
            mark = "REJECTED"
            rejected.append(f"{model} {field}={value!r} -> 400 {msg[:70]}")
        else:
            mark = f"?{status}"
        print(f"  {field:17} {str(value):9} -> {status} {mark}  (bogus rejected in this same slot)")

    # The neighbour control first: if the table's central claim is wrong, say so before the details.
    if model == "azure/sora-2" and 5 not in lim["durations"]:
        measure("duration_seconds", 5, expect_reject=True)

    for field, values in (
        ("duration_seconds", lim["durations"]),
        ("resolution", lim["resolutions"]),
        ("aspect_ratio", lim["aspectRatios"]),
    ):
        for value in values:
            if value == "default":
                continue
            measure(field, value)

    return checked, rejected


def main() -> int:
    checked = 0
    # Split so the verdict can report each path's own strength rather than one blurred number.
    batch_checked = 0
    slow_checked = 0
    rejected: list[str] = []
    unknown: list[str] = []
    control_runs = 0

    unverifiable: list[str] = []

    # ---- every offered value ----
    #
    # ONLY is for finishing a model the full run could not vouch for, without re-running the other
    # seven. azure/sora-2 needed it: the full sweep had to discard its row, and a single legal request
    # is enough to stop its control from rejecting (see the note above — the reason is not known).
    only = [m for m in (os.environ.get("SWEEP_ONLY", "").split(",")) if m]
    if only:
        print(f"\n== restricted to: {', '.join(only)} ==")

    print("\n== every value the UI offers ==")
    for model, lim in LIMITS.items():
        if only and model not in only:
            continue
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

        # EVERY model goes through the own-slot path now.
        #
        # The batch loop shared one prompt across a whole row, which means it shared cache slots: the
        # first value of the row filled them and the rest could be answered without the upstream ever
        # being asked. That is why it needed 6s throttling, brackets at both ends, and still had to
        # discard a model. Measuring each value in a slot of its own removes the shared state the
        # brackets were compensating for — stronger evidence, and seconds instead of ~16 minutes.
        n, bad = sweep_one_at_a_time(model, lim)
        checked += n
        slow_checked += n
        rejected.extend(bad)
        control_runs += n
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
                batch_checked += 1
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
            batch_checked -= row_checked
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
    # Stated separately, because the two paths carry DIFFERENT strength and saying "preceded and
    # followed" of both would overclaim. The batch path brackets a whole row with a control at each
    # end; the own-slot path pairs each value with a control in ITS OWN cache slot, which is
    # actually the stronger of the two — a control in a different slot cannot tell you whether this
    # request was answered by the upstream or from cache. Both are sound — a control confirmed
    # 400 immediately before the value is what makes that value's 402 mean "accepted" — but only the
    # batch path also proves the signal survived the row.
    if batch_checked:
        print(f"VERIFIED (bracketed): {batch_checked} values, a live control before AND after the row")
    if slow_checked:
        print(f"VERIFIED (own slot):  {slow_checked} values, each with a bogus value rejected IN THE SAME cache slot")
    print(f"controls run: {control_runs}")
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
