import { CheckIcon, LoaderIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { getMediaUrl } from '../lib/blobstore'
import { mediaMimeType } from '../lib/modality'

export interface ToolStep {
  tool: string
  running: boolean
  spentUsd?: number
  declined?: boolean
  /**
   * The call was not made because this session cannot pay. Distinct from `declined`, which is the
   * user refusing a charge they COULD have made.
   *
   * Needed because "spent nothing" is not the same as "was free": without it a refused `call_api`
   * rendered a green tick and the word "free", which reads as a paid API having been called at no
   * charge. Reported from a screenshot showing exactly that, twice in one turn.
   */
  unpayable?: boolean
}

export type Turn =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string; reasoning: string; steps: ToolStep[]; model?: string }
  | { kind: 'error'; text: string }
  /**
   * Something the user should know that is not a failure — currently a model downgrade.
   * Styled apart from an error on purpose: the request is still being served, and
   * colouring it red would report a working fallback as a breakage.
   */
  | { kind: 'notice'; text: string }
  /**
   * A generated image, video or track. Carries what was paid, because a media turn is the
   * one place a user is likely to have spent real money in a single step — a video runs to
   * several hundred times a chat reply.
   */
  | {
      kind: 'media'
      /**
       * Stable identity for this turn.
       *
       * A generation's wait runs detached and can land minutes later, after more messages have
       * been sent or another conversation opened. Locating the turn by array index would let a
       * result be written into a different conversation's turn that happens to sit at the same
       * position — so the turn carries its own id and the update finds it by that.
       */
      id: string
      media: 'image' | 'video' | 'music' | 'speech'
      url?: string
      /**
       * Inline bytes, for this page load only.
       *
       * NEVER persisted — `saveConversations` strips it. Speech returns audio as base64 rather
       * than a URL, and one 30s clip is ~640 KB of it; seven of those filled this origin's 4 MB
       * localStorage, after which every conversation write failed silently and a refresh threw
       * away everything since. The bytes go to IndexedDB and `mediaKey` points at them.
       */
      b64?: string
      /**
       * Key into the IndexedDB blob store, for media that arrived as bytes rather than a URL.
       *
       * This is what makes a speech clip survive a reload. It is NOT a substitute for the R2
       * archive: anything with an http(s) URL is copied to the CDN and is permanent and
       * shareable, whereas this exists in one browser only — the CDN Worker copies from an
       * allowlisted host and inline bytes have no host to copy from.
       */
      mediaKey?: string
      raw?: string
      prompt: string
      model: string
      spentUsd: number
      /**
       * Set while the media is still being generated upstream.
       *
       * Video generation is asynchronous: the POST returns a receipt and the clip arrives
       * minutes later. Without this the turn had nowhere to say "still coming", so a paid
       * video rendered as "returned no media we could read" — a permanent-looking failure
       * for a job that was working. The job id is kept because it stays valid afterwards:
       * the media is retrievable long after this tab stopped waiting.
       */
      job?: { id: string; pollUrl: string }
      /** Wall-clock spent waiting so far, so a long wait shows progress. */
      waitedMs?: number
      /** Set once waiting ended without media, distinguishing "gave up" from "never started". */
      timedOut?: boolean
      /**
       * Set when this wait was picked up again after a page load.
       *
       * Worth saying out loud rather than resuming silently: someone who reloaded during a long
       * generation needs to know the job survived the reload. Without it the turn looks like it
       * restarted from zero, which invites a second paid attempt at something already running.
       */
      resumed?: boolean
      /** A terminal upstream failure, with the provider's own wording. */
      failed?: { message: string; retryable: boolean }
    }


export function Transcript({
  turns,
  empty,
}: {
  turns: Turn[]
  /**
   * What to show when there are no turns yet.
   *
   * Passed in rather than built here. This used to be a hero and six starter buttons defined in
   * this file, which was fine until the first screen needed to say what the product is — that
   * content needs the live model and marketplace counts, and Transcript has no business fetching
   * a catalogue. The slot keeps the scroll container here and the copy where its data is.
   */
  empty: ReactNode
}) {
  const endRef = useRef<HTMLDivElement>(null)

  // Follows the stream. Anchored to a trailing element rather than setting scrollTop, so
  // it works while content is still growing.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  if (turns.length === 0) {
    return <div className="transcript">{empty}</div>
  }

  return (
    <div className="transcript">
      {turns.map((turn, i) => (
        <TurnView key={i} turn={turn} />
      ))}
      <div ref={endRef} />
    </div>
  )
}

/**
 * The last line of a reasoning stream, for the one-line live tail.
 *
 * Exported for its test. Takes the tail rather than the head because the head stops changing
 * immediately — a frozen first sentence is exactly the "nothing is happening" this exists to
 * dispel — and collapses newlines so a multi-line thought cannot grow the layout mid-stream.
 *
 * `TAIL_CHARS` is a display cap, not a semantic one: this text is decoration, and the full
 * reasoning stays available in the `<details>` above it.
 */
export const TAIL_CHARS = 140

export function tailOf(reasoning: string): string {
  const flat = reasoning.replace(/\s+/g, ' ').trim()
  if (flat.length <= TAIL_CHARS) return flat
  return `…${flat.slice(flat.length - TAIL_CHARS)}`
}

/**
 * The catalogue tools. Looking something up in our own directory is plumbing: it costs
 * nothing, reaches no third party, and the user did not ask for it.
 *
 * `call_api` is deliberately NOT here. It is the one step that spends the user's money on an
 * outside service, so hiding it would hide a charge, and it is also the thing the product is
 * for — an agent paying for an API mid-conversation. Money stays visible.
 */
const PLUMBING_TOOLS = new Set(['search_apis', 'list_models'])

export function isPlumbing(step: ToolStep): boolean {
  // A refused call is never plumbing regardless of which tool it was: "not called — needs
  // payment" is the answer to "why did nothing happen", and it must not be collapsed out of
  // sight along with the catalogue lookups.
  if (step.declined || step.unpayable) return false
  if ((step.spentUsd ?? 0) > 0) return false
  return PLUMBING_TOOLS.has(step.tool)
}

/**
 * Splits a turn's steps into the ones worth a row of their own and the ones that only need a
 * count.
 *
 * Reported as "11+ consecutive search_apis calls in ~60s ... never returned", read as a
 * runaway loop. The looping was a separate defect (a single model emitting 229k characters of
 * reasoning, fixed by the runaway cap), but the READING came from the transcript: every
 * catalogue lookup took a full row, so three lookups looked like thrashing and eleven looked
 * like a hang. The same turn shown as one "searched the catalogue x3" line reads as progress.
 *
 * While a lookup is still running it keeps its own row — a spinner is the only thing telling
 * the user the turn is alive at that moment.
 */
export function partitionSteps(steps: ToolStep[]): { shown: ToolStep[]; plumbingDone: number } {
  const shown: ToolStep[] = []
  let plumbingDone = 0
  for (const step of steps) {
    if (isPlumbing(step) && !step.running) {
      plumbingDone += 1
      continue
    }
    shown.push(step)
  }
  return { shown, plumbingDone }
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === 'user') {
    return (
      <div className="turn turn-user">
        <div className="bubble">{turn.text}</div>
      </div>
    )
  }

  if (turn.kind === 'error') {
    return <div className="error">{turn.text}</div>
  }

  if (turn.kind === 'notice') {
    return <div className="notice">{turn.text}</div>
  }

  if (turn.kind === 'media') {
    return <MediaView turn={turn} />
  }

  return (
    <div className="turn turn-agent">
      <StepsView steps={turn.steps} />

      {/* Collapsed by default: on several free models the reasoning is most of the
          output, and showing it expanded reads as the answer.

          The live tail is what makes the wait legible. Measured against the gateway: the first
          reasoning frame arrives in 1.3-1.8s while the first content frame can be 23-91s later, so
          for most of the wait this component HAS data and was rendering a static word. The page
          looked frozen while the stream was healthy — the complaint was "都要等待一段时间", and
          the honest fix is partly to show that something is happening. Only while it is still the
          last thing in the turn: once text arrives the tail would compete with the answer. */}
      {turn.reasoning.trim() !== '' && (
        <details className="reasoning">
          <summary>Thinking</summary>
          {turn.reasoning}
        </details>
      )}
      {/* Labelled "Thinking", and that label is a fix rather than a decoration.

          Reported as "chain-of-thought leaking into the answer", with the example "We can pick
          five: Crypto Token Price (3709)… Better to ask user which token". That text is real
          model reasoning, and it was never in the answer channel — measured across five free
          models on an answer-writing turn, `content` carries no deliberation markers. It is THIS
          element: the live tail, rendered as bare prose directly under the tool rows with nothing
          saying what it was. A reader has no way to tell it from the reply, so the honest reading
          of that report is that the tail was indistinguishable from the answer.

          The tail itself stays — it is what makes a 20-90s wait legible, and removing it would
          restore the frozen "Thinking" it was added to fix. What changes is that it now says what
          it is, in a form the answer never takes. */}
      {turn.reasoning.trim() !== '' && turn.text.trim() === '' && (
        <div className="reasoning-tail">
          {/* aria-hidden on the text, not the label: a screen reader announcing a partial
              half-sentence that changes several times a second is noise, while the label tells
              someone using one that the turn is working. */}
          <span className="reasoning-tail-label">Thinking</span>
          <span aria-hidden="true">{tailOf(turn.reasoning)}</span>
        </div>
      )}

      {turn.text.trim() !== '' && <div className="bubble">{turn.text}</div>}

      {turn.model && (
        <div className="answered-by">
          {/* auto/free resolves per request, so naming the concrete model is the only
              way the user learns which one answered. */}
          <span>answered by</span>
          <span className="tool-name">{turn.model}</span>
        </div>
      )}
    </div>
  )
}

function MediaView({ turn }: { turn: Extract<Turn, { kind: 'media' }> }) {
  /**
   * Bytes recovered from IndexedDB after a reload.
   *
   * A speech clip arrives as base64 and `turn.b64` carries it for this page load, but that field
   * is never persisted (it filled a 4 MB localStorage in seven clips and silently killed every
   * later write). After a refresh the turn has only `mediaKey`, and this is what turns it back
   * into something playable.
   */
  const [storedUrl, setStoredUrl] = useState<string | null>(null)
  useEffect(() => {
    // Only when there is nothing else to show. A turn with a CDN URL or bytes still in memory
    // needs no lookup, and doing one anyway would hit IndexedDB on every render of every clip.
    if (turn.url || turn.b64 || !turn.mediaKey) return
    let revoke: string | null = null
    let live = true
    void getMediaUrl(turn.mediaKey).then((url) => {
      if (!live) {
        // Resolved after unmount. Revoking here rather than leaking: an object URL pins its blob
        // in memory until released, and a long scroll through a transcript of clips would hold
        // every one of them.
        if (url) URL.revokeObjectURL(url)
        return
      }
      revoke = url
      setStoredUrl(url)
    })
    return () => {
      live = false
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [turn.url, turn.b64, turn.mediaKey])

  // A data: URL for base64 payloads, with the mime type of the actual medium. It used to be
  // hardcoded `image/png`, which is right for an image and silently broken for a clip: an
  // <audio> element handed an image mime type renders a dead player, so a paid speech call
  // looked like it produced nothing.
  //
  // The deployed CSP sets `media-src 'self' data: https: blob:`. Without it a data: or blob: clip
  // is refused by default-src, which is the same dead player by a different cause — stated here
  // rather than discovered, because a blank result after a real charge is the worst outcome.
  const src =
    turn.url ??
    (turn.b64 ? `data:${mediaMimeType(turn.media)};base64,${turn.b64}` : undefined) ??
    storedUrl ??
    undefined

  return (
    <div className="turn turn-agent">
      <div className="media-card">
        <div className="media-head">
          <span className="media-kind">{turn.media}</span>
          <span className="tool-name">{turn.model}</span>
          <span className="price">${turn.spentUsd.toFixed(6)}</span>
        </div>

        {src === undefined && turn.failed ? (
          <p className="media-missing">
            {turn.failed.message}
            {turn.failed.retryable ? ' You can try again.' : null}
          </p>
        ) : src === undefined && turn.job ? (
          <WaitingView turn={turn} />
        ) : src === undefined ? (
          <p className="media-missing">
            The call completed but returned no media we could read.
            {turn.raw ? <code className="media-raw">{turn.raw}</code> : null}
          </p>
        ) : turn.media === 'image' ? (
          <img className="media-img" src={src} alt={turn.prompt} loading="lazy" />
        ) : turn.media === 'video' ? (
          <video className="media-video" src={src} controls preload="metadata" />
        ) : (
          <audio className="media-audio" src={src} controls preload="metadata" />
        )}

        <p className="media-prompt">{turn.prompt}</p>

        {/* Opened in a tab rather than offered as a download: the artifact viewer's sandbox
            blocks page-initiated downloads, so a download link would look broken. */}
        {turn.url && (
          <a className="media-open" href={turn.url} target="_blank" rel="noopener noreferrer">
            Open original
          </a>
        )}
      </div>
    </div>
  )
}

/** Roughly how long each kind takes, so a wait can be shown against something. */
const TYPICAL_WAIT_S: Record<'image' | 'video' | 'music' | 'speech', number> = {
  video: 180,
  music: 90,
  image: 30,
  speech: 10,
}

/**
 * A generation in progress.
 *
 * Reported as "I ask for a video, then I wait a long time with no indication of anything".
 * The previous version did show elapsed seconds — but only from `waitedMs`, which updates when
 * a POLL RETURNS, i.e. every five seconds. Measured: the counter read 0s, 0s, 5s, 5s, 10s, 10s,
 * 10s, 15s over eighteen seconds. A number that sits still for three checks is indistinguishable
 * from a frozen page, which is precisely the impression to avoid.
 *
 * So the clock runs locally, once a second, and is anchored to a start time rather than
 * accumulated — a browser throttles timers in a background tab, and a counter that ticks 60
 * times per minute only while visible would under-report a wait someone left running.
 *
 * The progress bar is bounded by a TYPICAL duration, not a promise. It fills to 90% and stops:
 * a bar that reaches the end and keeps sitting there says the thing is finished when it is not.
 */
function WaitingView({ turn }: { turn: Extract<Turn, { kind: 'media' }> }) {
  // Anchored to mount rather than to the turn's own timestamp: this component appears when the
  // wait starts, and after a resume the wait genuinely did restart from here.
  const startedAt = useRef(Date.now() - (turn.waitedMs ?? 0))
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt.current)

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startedAt.current), 1000)
    return () => clearInterval(id)
  }, [])

  const seconds = Math.floor(elapsed / 1000)
  const typical = TYPICAL_WAIT_S[turn.media]
  const pct = Math.min(90, Math.round((seconds / typical) * 90))
  const overdue = seconds > typical

  return (
    <div className="media-waiting-box">
      <p className="media-waiting">
        <LoaderIcon className="tool-glyph is-spinning" size={13} aria-hidden="true" />
        <span>
          {turn.resumed ? 'Still generating' : 'Generating'} · {formatWait(seconds)}
          {/* Named while it is still normal, so a long wait is expected rather than alarming.
              Past that point the claim is dropped instead of repeated — insisting on "about
              3 min" at four minutes is worse than saying nothing. */}
          {!overdue && <span className="media-waiting-eta"> · usually about {formatWait(typical)}</span>}
        </span>
      </p>

      {/* Movement independent of the polls. Even at 90% it is still animating, which is the
          part that says "working" rather than "stuck". */}
      <div className="media-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="media-progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <p className="media-waiting-note">
        {turn.timedOut
          ? // The client stopped asking; the job did not stop running. The gateway allows itself
            // 900s upstream and stores the result either way, so the media is very likely coming.
            'This is taking longer than usual. It keeps running on the server — reopen this chat in a minute and it will appear.'
          : turn.resumed
            ? 'Picked this back up after the page reloaded — the job kept running, and you were not charged again.'
            : 'Already paid. You can keep chatting or close the tab; this carries on and will be here when you come back.'}
      </p>
    </div>
  )
}

/**
 * `45s`, `2m 05s`, `3m` — seconds alone stop being readable somewhere around a minute.
 *
 * A whole number of minutes drops the seconds entirely. The estimate is 180s, and rendering that
 * as "usually about 3m 00s" claims a precision nobody has: two padded zeros read as a measured
 * figure rather than a rough one. Elapsed time keeps its seconds, because there the exact number
 * is the information.
 */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (s === 0) return `${m}m`
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/**
 * The tool rows for one turn: every paid or refused step in full, the finished catalogue
 * lookups as a single summary line.
 *
 * The summary is a `<details>` rather than a plain line so nothing is actually withheld —
 * "what did it search for" is a fair question and the answer is one click away.
 */
function StepsView({ steps }: { steps: ToolStep[] }) {
  const { shown, plumbingDone } = partitionSteps(steps)
  const plumbing = steps.filter((s) => isPlumbing(s) && !s.running)
  return (
    <>
      {shown.map((step, i) => (
        <StepView key={i} step={step} />
      ))}
      {plumbingDone > 0 && (
        <details className="tool-plumbing">
          <summary>
            <CheckIcon className="tool-glyph" size={13} aria-hidden="true" />
            <span>
              {plumbingDone === 1
                ? 'Searched the API catalogue'
                : `Searched the API catalogue ${plumbingDone}x`}
            </span>
          </summary>
          {plumbing.map((step, i) => (
            <StepView key={i} step={step} />
          ))}
        </details>
      )}
    </>
  )
}

function StepView({ step }: { step: ToolStep }) {
  return (
    <div className={step.running ? 'tool-row is-running' : 'tool-row'}>
      {step.running ? (
        <LoaderIcon className="tool-glyph is-spinning" size={13} aria-hidden="true" />
      ) : (
        <CheckIcon className="tool-glyph" size={13} aria-hidden="true" />
      )}
      <span className="tool-name">{step.tool}</span>
      {step.declined ? (
        <span className="declined">declined</span>
      ) : step.running ? (
        <span>running</span>
      ) : /**
         * Checked BEFORE the price, because an unpayable call spent nothing and so used to fall
         * through to "free".
         *
         * Reported from a screenshot: a free session's turn showed `call_api free`,
         * `call_api $0.001150`, `call_api free` — two green ticks claiming a paid API had been
         * called at no charge, when in fact those two were refused for having no payment method.
         * "Spent nothing" and "was free" are different facts and only `search_apis` and
         * `list_models` are the second one.
         */
      step.unpayable ? (
        <span className="declined">not called — needs payment</span>
      ) : (step.spentUsd ?? 0) > 0 ? (
        <span className="price">${step.spentUsd!.toFixed(6)}</span>
      ) : (
        <span className="price-free">free</span>
      )}
    </div>
  )
}
