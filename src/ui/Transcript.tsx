import { useEffect, useRef } from 'react'

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
      media: 'image' | 'video' | 'music'
      url?: string
      b64?: string
      raw?: string
      prompt: string
      model: string
      spentUsd: number
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
  // A data: URL for base64 payloads. The deployed CSP allows `img-src 'self' data:`, which
  // is why an inlined image renders — but `media-src` is not set, so it falls back to
  // default-src 'self' and a data: video would be refused. That is stated here rather than
  // discovered: a silently blank video after a paid call is the worst possible outcome.
  const src = turn.url ?? (turn.b64 ? `data:image/png;base64,${turn.b64}` : undefined)

  return (
    <div className="turn turn-agent">
      <div className="media-card">
        <div className="media-head">
          <span className="media-kind">{turn.media}</span>
          <span className="tool-name">{turn.model}</span>
          <span className="price">${turn.spentUsd.toFixed(6)}</span>
        </div>

        {src === undefined ? (
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

function StepView({ step }: { step: ToolStep }) {
  return (
    <div className={step.running ? 'tool-row is-running' : 'tool-row'}>
      <span className="tool-glyph">{step.running ? '◇' : '◆'}</span>
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
