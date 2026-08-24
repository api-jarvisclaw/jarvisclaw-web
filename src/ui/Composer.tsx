import { useRef, useState } from 'react'

import type { CatalogueModel } from '../lib/catalogue'
import { GENERATIONS, modeForModel, type GenerationKind } from '../lib/modality'
import { ModelPicker } from './ModelPicker'

/**
 * The composer: text box, model picker, and the generation modes.
 *
 * The mode buttons are not decoration — each maps to a real endpoint that quotes a real
 * price (verified live: images $0.064, video $0.40, music $0.159). Selecting one switches
 * what the send button does, and the price is quoted before anything is spent.
 */
export function Composer({
  busy,
  anonymous,
  models,
  modelsLoading,
  model,
  mode,
  onModel,
  onMode,
  onSend,
}: {
  busy: boolean
  anonymous: boolean
  models: CatalogueModel[]
  modelsLoading: boolean
  model: string
  mode: GenerationKind | 'chat'
  onModel: (m: string) => void
  onMode: (m: GenerationKind | 'chat') => void
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // What the picked model actually is, and therefore where it will run. Computed from the
  // catalogue rather than the name so a repriced or renamed model needs no change here.
  const picked = models.find((m) => m.model === model)
  const routed = picked ? modeForModel(picked.model, picked.modality) : null

  // In a generation mode, the picked model is only used if it can serve that mode; otherwise
  // the mode's verified default wins. Shown rather than applied silently.
  const effectiveModel =
    mode !== 'chat' && routed !== mode ? GENERATIONS[mode].defaultModel : model

  const submit = () => {
    if (busy || text.trim() === '') return
    onSend(text)
    setText('')
    // Height is set inline as the user types, so it has to be reset explicitly or the
    // box stays as tall as the message that was just sent.
    if (ref.current) ref.current.style.height = 'auto'
  }

  // A speech clip is written out, not described — "Describe the clip you want" would invite a
  // description that then gets read aloud verbatim.
  const placeholder =
    mode === 'chat'
      ? 'Ask anything…'
      : mode === 'speech'
        ? 'Type the words to speak…'
        : `Describe the ${GENERATIONS[mode].unit} you want…`

  return (
    <div className="composer">
      <div className="composer-shell">
        <textarea
          ref={ref}
          value={text}
          placeholder={placeholder}
          rows={1}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. IME composition must be excluded or
            // committing a Chinese/Japanese candidate with Enter sends a half-typed
            // message instead of accepting the word.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />

        <div className="composer-tools">
          <ModelPicker
            models={models}
            selected={model}
            loading={modelsLoading}
            onSelect={onModel}
          />

          {(['image', 'video', 'music', 'speech'] as const).map((kind) => (
            <button
              key={kind}
              className={mode === kind ? 'mode-btn mode-btn-active' : 'mode-btn'}
              // Toggles: pressing the active mode returns to chat, so there is always a
              // way back without hunting for a "chat" button that would otherwise be the
              // only unlabelled state.
              onClick={() => onMode(mode === kind ? 'chat' : kind)}
              aria-pressed={mode === kind}
            >
              <span className="mode-glyph" aria-hidden="true">
                {kind === 'image' ? '◧' : kind === 'video' ? '▷' : kind === 'music' ? '♪' : '◔'}
              </span>
              {GENERATIONS[kind].label}
            </button>
          ))}

          <span className="spacer" />

          <button
            className="send-btn"
            onClick={submit}
            disabled={busy || text.trim() === ''}
            aria-label="Send"
          >
            {busy ? '…' : '↑'}
          </button>
        </div>
      </div>

      <div className="hint">
        {mode !== 'chat' ? (
          <>
            {`${GENERATIONS[mode].label} is paid per ${GENERATIONS[mode].unit} — one price, one signature. You'll see the exact amount before anything is spent.`}
            {/* Named explicitly, because the mode's own default silently overrides the
                picker when the picked model is a chat model. Leaving that implicit is how
                someone concludes their choice was ignored. */}
            <span className="hint-model"> Using {effectiveModel}.</span>
          </>
        ) : routed !== null ? (
          // The picker offers image, video and audio models, and choosing one used to change
          // only the CHAT model — so a voice model was sent to /v1/chat/completions, which
          // bills it as chat and answers in words. Saying where it will go is the visible
          // half of that fix.
          `${model} makes ${GENERATIONS[routed].unit === 'track' ? 'music' : GENERATIONS[routed].unit + 's'}, so this runs as ${GENERATIONS[routed].label} rather than chat — paid per ${GENERATIONS[routed].unit}, priced before it runs.`
        ) : anonymous ? (
          'Free tier — no wallet needed. Anything paid shows its price and asks first.'
        ) : (
          'Wallet connected. Every charge is signed by you, showing the amount before it happens.'
        )}
      </div>
    </div>
  )
}
