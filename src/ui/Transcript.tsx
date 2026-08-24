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

const SUGGESTIONS = [
  'What can you do?',
  'Find an API for ethereum gas prices',
  'Which models are free right now?',
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
          <span className="eyebrow">Agent console</span>
          <h1>
            Ask for anything.
            <br />
            <em>It pays per call.</em>
          </h1>
          <p>
            4000+ callable APIs and 80+ models. Start now — no account, no key, no card. Paid
            APIs ask before they spend anything.
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
