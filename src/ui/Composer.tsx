import { useRef, useState } from 'react'

import type { CatalogueModel } from '../lib/catalogue'
import { GENERATIONS, type GenerationKind } from '../lib/modality'
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

  const submit = () => {
    if (busy || text.trim() === '') return
    onSend(text)
    setText('')
    // Height is set inline as the user types, so it has to be reset explicitly or the
    // box stays as tall as the message that was just sent.
    if (ref.current) ref.current.style.height = 'auto'
  }

  const placeholder =
    mode === 'chat'
      ? 'Ask anything…'
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

          {(['image', 'video', 'music'] as const).map((kind) => (
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
                {kind === 'image' ? '◧' : kind === 'video' ? '▷' : '♪'}
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
        {mode !== 'chat'
          ? `${GENERATIONS[mode].label} generation is paid per ${GENERATIONS[mode].unit}. You'll see the exact price before anything is spent.`
          : anonymous
            ? 'Free tier — no key needed. Paid APIs will ask before spending anything.'
            : 'Signed in. Paid API calls are charged to your wallet, with a prompt above your per-call limit.'}
      </div>
    </div>
  )
}
