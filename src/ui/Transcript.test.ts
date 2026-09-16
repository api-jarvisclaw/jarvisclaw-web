import { describe, expect, it } from 'vitest'

import {
  formatWait,
  isPlumbing,
  partitionSteps,
  tailOf,
  showsWait,
  publicModelName,
  waitHeadline,
  TAIL_CHARS,
  type ToolStep,
} from './Transcript'

/**
 * The one-line live tail of a reasoning stream.
 *
 * Measured against the gateway: the first reasoning frame arrives in 1.3-1.8s while the first
 * content frame can be 23-91s later, because the model writes thousands of characters of
 * deliberation first. For that whole gap the transcript HAD data and rendered a static
 * "Thinking" label, so a healthy stream looked frozen.
 */
describe('tailOf', () => {
  it('keeps a short thought whole', () => {
    expect(tailOf('Checking the catalogue')).toBe('Checking the catalogue')
  })

  it('shows the END of a long thought, not the beginning', () => {
    // The head stops changing after the first frame, and a frozen first sentence is exactly the
    // "nothing is happening" impression this exists to dispel.
    const s = 'A'.repeat(400) + 'THE-NEWEST-PART'
    const out = tailOf(s)
    expect(out.endsWith('THE-NEWEST-PART')).toBe(true)
    expect(out.startsWith('…')).toBe(true)
  })

  it('collapses newlines so the layout cannot grow mid-stream', () => {
    // Rendered on one clipped line. A multi-line thought arriving would otherwise push the
    // composer around several times a second.
    expect(tailOf('first line\n\nsecond   line\ttabbed')).toBe('first line second line tabbed')
    expect(tailOf('x\n'.repeat(50)).includes('\n')).toBe(false)
  })

  it('caps the length, counting the ellipsis as extra', () => {
    const out = tailOf('B'.repeat(1000))
    expect(out.length).toBe(TAIL_CHARS + 1)
  })

  it('survives the empty and whitespace-only cases', () => {
    // Reached in practice: a model can emit an empty reasoning delta before its first real one.
    expect(tailOf('')).toBe('')
    expect(tailOf('   \n  ')).toBe('')
  })
})

/**
 * The elapsed-time label on a running generation. It exists because a video takes minutes, and
 * the complaint that produced it was "I wait a long time with no indication of anything".
 */
describe('formatWait', () => {
  it('uses bare seconds under a minute', () => {
    expect(formatWait(0)).toBe('0s')
    expect(formatWait(45)).toBe('45s')
    expect(formatWait(59)).toBe('59s')
  })

  it('pads the seconds so a live counter does not jump width', () => {
    // `2m 5s` and `2m 10s` are different widths, so the label shifts every ten seconds while
    // someone is watching it. Padding keeps it still.
    expect(formatWait(125)).toBe('2m 05s')
    expect(formatWait(130)).toBe('2m 10s')
  })

  it('drops the seconds on a whole minute', () => {
    // The typical-duration estimate is 180s. "usually about 3m 00s" claims a precision nobody
    // has — two padded zeros read as a measured figure rather than a rough one.
    expect(formatWait(60)).toBe('1m')
    expect(formatWait(180)).toBe('3m')
    expect(formatWait(90)).toBe('1m 30s')
  })
})

/**
 * Which tool steps get a row of their own.
 *
 * Reported as "11+ consecutive search_apis calls in ~60s ... never returned", read as a
 * runaway loop. The loop was a separate defect in one model; the READING came from here —
 * every catalogue lookup took a full row, so a handful looked like thrashing.
 *
 * The rule is about money, not tidiness: a step that spends or refuses to spend the user's
 * funds is never collapsed.
 */
describe('partitionSteps', () => {
  const done = (tool: string, extra: Partial<ToolStep> = {}): ToolStep => ({
    tool,
    running: false,
    ...extra,
  })

  it('collapses finished catalogue lookups into a count', () => {
    const { shown, plumbingDone } = partitionSteps([
      done('search_apis'),
      done('search_apis'),
      done('search_apis'),
    ])
    expect(shown).toHaveLength(0)
    expect(plumbingDone).toBe(3)
  })

  it('never treats an outside API call as plumbing, by name alone', () => {
    // The three tests below pass a call_api carrying a price or a refusal flag, so they are
    // satisfied by the money guards and say nothing about the NAME. Adding call_api to the
    // plumbing set left every one of them green. This is the assertion that catches it: a call
    // to a third party is not plumbing even when nothing was recorded against it.
    expect(isPlumbing(done('call_api'))).toBe(false)
  })

  it('keeps a catalogue lookup visible if it was ever refused or declined', () => {
    // Exercises the refusal guard on a PLUMBING-named tool. Passing a refused call_api instead
    // proves nothing, because call_api is not in the plumbing set to begin with — deleting the
    // guard entirely left that test green.
    expect(isPlumbing(done('search_apis', { unpayable: true }))).toBe(false)
    expect(isPlumbing(done('list_models', { declined: true }))).toBe(false)
  })

  it('never collapses a paid call', () => {
    // This is the product's whole claim — an agent paying an outside API mid-conversation.
    // Hiding it would hide a charge.
    const { shown, plumbingDone } = partitionSteps([
      done('search_apis'),
      done('call_api', { spentUsd: 0.00115 }),
    ])
    expect(shown.map((s) => s.tool)).toEqual(['call_api'])
    expect(plumbingDone).toBe(1)
  })

  it('never collapses a refused call', () => {
    // "not called — needs payment" is the answer to "why did nothing happen".
    const { shown } = partitionSteps([done('call_api', { unpayable: true })])
    expect(shown).toHaveLength(1)
  })

  it('never collapses a declined call', () => {
    const { shown } = partitionSteps([done('call_api', { declined: true })])
    expect(shown).toHaveLength(1)
  })

  it('keeps a RUNNING lookup visible', () => {
    // While it is in flight the spinner is the only thing telling the user the turn is alive.
    const { shown, plumbingDone } = partitionSteps([
      done('search_apis'),
      { tool: 'search_apis', running: true },
    ])
    expect(shown).toHaveLength(1)
    expect(shown[0].running).toBe(true)
    expect(plumbingDone).toBe(1)
  })

  it('keeps an unknown tool visible', () => {
    // The plumbing list is an allowlist: a tool nobody classified must not vanish.
    const { shown } = partitionSteps([done('some_future_tool')])
    expect(shown.map((s) => s.tool)).toEqual(['some_future_tool'])
  })

  it('treats a catalogue lookup that somehow charged as chargeable', () => {
    // Defensive: if search_apis ever costs money, the row showing that must not be hidden by
    // the name-based rule.
    expect(isPlumbing(done('search_apis', { spentUsd: 0.0001 }))).toBe(false)
  })

  it('preserves the order of the steps it shows', () => {
    const { shown } = partitionSteps([
      done('call_api', { spentUsd: 0.001 }),
      done('search_apis'),
      done('call_api', { spentUsd: 0.002 }),
    ])
    expect(shown.map((s) => s.spentUsd)).toEqual([0.001, 0.002])
  })
})

/**
 * Whether an unfinished media turn shows the waiting indicator.
 *
 * Reported as "在处理都没有一个类似状态条的东西" — a generation runs and the transcript shows
 * nothing but the prompt. What made it invisible in review is that the waiting UI already
 * existed and worked: `WaitingView` has a per-second clock and a progress bar, and video and
 * music both reach it. The predicate below is the whole defect. It read `turn.job` alone, and a
 * job id only exists for ASYNCHRONOUS media — an image or a speech clip returns its bytes from
 * the same call, so it never had one and could not reach the indicator at all.
 *
 * Measured on the live site, sampling the DOM every 500ms through an image generation:
 *
 *     transcript rows (max):        1     <- the user's own prompt
 *     rows that are NOT the prompt: 0
 *     media-waiting boxes:          0
 *     progressbar inside a turn:    0
 *     progressbar anywhere on page: 1     <- the sidebar's spend meter, not feedback
 *
 * That last line is why this is a unit test on a predicate rather than a selector count: my
 * first probe counted every [role=progressbar] on the page, found the sidebar's, and reported
 * PASS on a run where the transcript was empty for a full minute.
 */
describe('showsWait', () => {
  it('shows the wait for a synchronous generation, which has no job', () => {
    // The case that was broken: images and speech. If this passes with `waiting` ignored, the
    // indicator is unreachable for them however good WaitingView is.
    expect(showsWait({ waiting: true })).toBe(true)
  })

  it('still shows the wait for a queued job', () => {
    // The control. Extending the predicate must not cost the case that already worked — a
    // resumed video has `waiting` cleared and only a job.
    expect(showsWait({ job: { id: 'j1', pollUrl: '/v1/videos/generations/j1' } })).toBe(true)
  })

  it('shows nothing once the call has come back with neither', () => {
    // A finished turn with no media is the "returned no media we could read" case, and it must
    // stay that message rather than a spinner that never ends.
    expect(showsWait({})).toBe(false)
    expect(showsWait({ waiting: false })).toBe(false)
  })
})

/**
 * What the waiting row claims while it waits.
 *
 * The turn now exists from the moment Enter is pressed, which extends it over the PRICE CHECK as
 * well as the generation. Measured on the deployed page, that window rendered:
 *
 *     Generating · 11s · usually about 30s
 *     Paid and sent. Keep this tab open until it comes back.
 *
 * for an anonymous request that spends nothing and ended in "sign in with your JarvisClaw
 * account to use its quota". Two false claims — work that had not started, and a payment that
 * had not happened. Fixing the missing indicator by adding a lying one is not a fix.
 */
describe('waitHeadline', () => {
  it('does not claim generation before the call is paid for', () => {
    // spentUsd is 0 until the quote lands AND the spend is approved, which makes it the one
    // value that cannot announce work early.
    expect(waitHeadline({ spentUsd: 0 })).toBe('Checking price')
  })

  it('says generating once there is a real charge', () => {
    // The control: this must not become "Checking price" forever, or the paid path loses the
    // label it always had.
    expect(waitHeadline({ spentUsd: 0.064 })).toBe('Generating')
  })

  it('keeps the resumed wording, which only happens after payment', () => {
    expect(waitHeadline({ resumed: true, spentUsd: 0.4 })).toBe('Still generating')
  })
})

/**
 * What the attribution line is allowed to print.
 *
 * Reported from a screenshot as "这个不要透露出来好吗，answer by". The line rendered the response's
 * `model` field verbatim, and for one channel the upstream echoes a full resource identifier:
 *
 *     arn:aws:bedrock:us-east-1:<12-digit account>:application-inference-profile/<id>
 *
 * A region, an account number and a profile id, under an answer, on a page anyone can open without
 * signing in. It cannot be fixed by filtering the catalogue — 0 of the 319 advertised models
 * contain such a name, because the value arrives at answer time rather than from the listing.
 *
 * An allow-shape rather than a deny-list, and these tests pin that choice: a new channel echoing a
 * new format must default to showing nothing, not to leaking a shape nobody listed.
 */
describe('publicModelName', () => {
  it('refuses the ARN this was reported for', () => {
    expect(
      publicModelName(
        'arn:aws:bedrock:us-east-1:158525983107:application-inference-profile/i0f8apavqo5l',
      ),
    ).toBe('')
  })

  it('shows an ordinary vendor/model name', () => {
    // The control. Suppressing everything would "fix" the leak by removing a feature the user
    // asked for earlier — auto/free resolves per request, so naming the model that answered is
    // the only way to learn which one it was.
    expect(publicModelName('nvidia/nemotron-3-super-120b')).toBe('nvidia/nemotron-3-super-120b')
    expect(publicModelName('anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5')
    expect(publicModelName('glm-4-flash')).toBe('glm-4-flash')
  })

  it('refuses shapes no allowlist enumerated', () => {
    // Any identifier carrying infrastructure detail, not just the one measured. A deny-list that
    // named only ARNs would publish the next format unchallenged.
    expect(publicModelName('https://internal.example/v1/deployments/x')).toBe('')
    expect(publicModelName('projects/123456789012/locations/us/models/m')).toBe('')
    expect(publicModelName('acct-158525983107-profile')).toBe('')
    expect(publicModelName('a'.repeat(80))).toBe('')
  })

  it('returns empty rather than a partial identifier', () => {
    // Trimming an ARN to its last segment would still publish the profile id, and would read as
    // a model name — worse than saying nothing, because it looks trustworthy.
    const out = publicModelName('arn:aws:bedrock:us-east-1:158525983107:foo/i0f8apavqo5l')
    expect(out).toBe('')
    expect(out).not.toContain('i0f8apavqo5l')
  })

  it('handles the absent cases the caller passes through', () => {
    expect(publicModelName(undefined)).toBe('')
    expect(publicModelName('')).toBe('')
    expect(publicModelName('   ')).toBe('')
  })
})
