import { CheckIcon, LoaderIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { mediaMimeType } from '../lib/modality'

export interface ToolStep {
  tool: string
  running: boolean
  spentUsd?: number
  declined?: boolean
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
      b64?: string
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

/**
 * Starters, each one something this gateway can actually do — the marketplace really does
 * carry search, on-chain and prediction-market services, and the catalogue really does
 * expose per-model pricing. A suggestion that fails on click is worse than none: it is the
 * first thing a new visitor tries.
 */
const SUGGESTIONS = [
  'What can you do, and what does it cost?',
  'Find me an API for Ethereum gas prices.',
  'Which models are free right now?',
  'Search the marketplace for on-chain data services.',
  'What would a 5-second video cost me?',
  'Compare the cheapest and most capable chat models.',
]

export function Transcript({
  turns,
  onSuggestion,
}: {
  turns: Turn[]
  onSuggestion: (text: string) => void
}) {
  const endRef = useRef<HTMLDivElement>(null)

  // Follows the stream. Anchored to a trailing element rather than setting scrollTop, so
  // it works while content is still growing.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  if (turns.length === 0) {
    return (
      <div className="transcript">
        <div className="empty">
          <span className="eyebrow">The agent with a wallet</span>
          <h1>
            What should <em>JarvisClaw</em> do?
          </h1>
          <p>
            330+ models and thousands of callable APIs, paid per call. Start now — no account,
            no key, no card. Anything paid shows its price and asks first.
          </p>
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => onSuggestion(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
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
      {turn.steps.map((step, i) => (
        <StepView key={i} step={step} />
      ))}

      {/* Collapsed by default: on several free models the reasoning is most of the
          output, and showing it expanded reads as the answer. */}
      {turn.reasoning.trim() !== '' && (
        <details className="reasoning">
          <summary>Thinking</summary>
          {turn.reasoning}
        </details>
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
  // A data: URL for base64 payloads, with the mime type of the actual medium. It used to be
  // hardcoded `image/png`, which is right for an image and silently broken for a clip: an
  // <audio> element handed an image mime type renders a dead player, so a paid speech call
  // looked like it produced nothing.
  //
  // The deployed CSP now sets `media-src 'self' data: https:`. Without it a data: clip is
  // refused by default-src, which is the same dead player by a different cause — stated here
  // rather than discovered, because a blank result after a real charge is the worst outcome.
  const src = turn.url ?? (turn.b64 ? `data:${mediaMimeType(turn.media)};base64,${turn.b64}` : undefined)

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
      ) : (step.spentUsd ?? 0) > 0 ? (
        <span className="price">${step.spentUsd!.toFixed(6)}</span>
      ) : (
        <span className="price-free">free</span>
      )}
    </div>
  )
}
