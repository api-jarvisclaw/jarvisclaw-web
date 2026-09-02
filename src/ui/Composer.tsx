import {
  AudioLinesIcon,
  ImageIcon,
  MessageSquareIcon,
  MusicIcon,
  SendIcon,
  VideoIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { CatalogueModel } from '../lib/catalogue'
import {
  GENERATIONS,
  modeForModel,
  type GenerationKind,
  type GenerationOptions as GenOptions,
} from '../lib/modality'
import { GenerationOptions } from './GenerationOptions'
import { effectiveModel, ModelPicker } from './ModelPicker'
import { useT } from './LocaleContext'

/**
 * Mode icons, from lucide-react — the same library the main site uses in 340 files.
 *
 * These were unicode glyphs (◧ ▷ ♪ ◔). Glyphs are not a styling choice so much as a
 * rendering gamble: each one falls back to whatever font on the machine happens to carry it,
 * so weight, size and baseline all drift per platform, and ◔ in particular reads as nothing
 * recognisable. Real icons render identically everywhere and match the rest of the product.
 */
const MODE_ICONS = {
  image: ImageIcon,
  video: VideoIcon,
  music: MusicIcon,
  speech: AudioLinesIcon,
} as const

/**
 * The modes shown in the composer, chat first.
 *
 * Chat used to be absent from this row, and that absence was the whole defect. Reported as
 * "一旦切到 image 或者其他的 就回不去正常聊天了" — once you switch to Image you cannot get
 * back to normal chat.
 *
 * The mechanism was never broken. Measured on the live console: pressing the ACTIVE mode
 * toggles back, the model resets from `openai/gpt-image-2` to `auto/free`, and a question
 * then answers. What was missing was any way to KNOW that:
 *
 *   buttons labelled exactly "Chat": 0
 *
 * Every other mode is a button you press to enter it, so the row taught a rule that chat
 * was the one exception to — and the only escape was pressing a button that already looked
 * pressed, which reads as "already there, this does nothing". A toggle whose off-switch is
 * the on-switch is discoverable only to whoever wrote it.
 *
 * So chat becomes a peer: visible, labelled, pressable, and highlighted when active. The
 * toggle behaviour on the other four stays, because it now costs nothing and someone who
 * found it will keep using it.
 */
export const COMPOSER_MODES = ['chat', 'image', 'video', 'music', 'speech'] as const

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
  options,
  onModel,
  onMode,
  onOptions,
  onSend,
  draft,
}: {
  busy: boolean
  anonymous: boolean
  models: CatalogueModel[]
  modelsLoading: boolean
  model: string
  mode: GenerationKind | 'chat'
  options: GenOptions
  onModel: (m: string) => void
  onMode: (m: GenerationKind | 'chat') => void
  onOptions: (o: GenOptions) => void
  onSend: (text: string) => void
  /**
   * Text pushed in from outside — a prompt picked in the showcase gallery.
   *
   * Carries a counter rather than being a bare string, so choosing the SAME prompt twice still
   * lands. A repeated identical value is a no-op to React, and the second attempt would do
   * nothing at all, which reads as a broken button.
   */
  draft?: { text: string; n: number } | null
}) {
  const t = useT()
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  /**
   * Accepts an incoming draft, focuses the box and grows it to fit.
   *
   * Keyed on the counter, not the text. Focus is part of the point: a prompt that appears in a
   * box the user has not been moved to is a prompt they may not notice arrived, and these run to
   * 4000 characters — without the height reset the box shows one line of a page-long prompt.
   */
  useEffect(() => {
    if (!draft) return
    setText(draft.text)
    const el = ref.current
    if (!el) return
    el.focus()
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
    // The caret goes to the end so typing continues the prompt rather than inserting at the top.
    el.setSelectionRange(draft.text.length, draft.text.length)
  }, [draft?.n])

  // What the picked model actually is, and therefore where it will run. Computed from the
  // catalogue rather than the name so a repriced or renamed model needs no change here.
  const picked = models.find((m) => m.model === model)
  const routed = picked ? modeForModel(picked.model, picked.modality) : null

  // Shared with the picker rather than recomputed here. Two copies of this rule is how the
  // trigger came to show one model while the hint below it named another.
  const effective = effectiveModel(models, model, mode)

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
            mode={mode}
            onSelect={onModel}
          />

          {COMPOSER_MODES.map((kind) => {
            const Icon = kind === 'chat' ? MessageSquareIcon : MODE_ICONS[kind]
            // GENERATIONS has no 'chat' entry — it maps a generation kind to an endpoint,
            // a price and a unit, and chat has none of those. Labelling it here rather
            // than adding a fake row keeps that type honest.
            const label = kind === 'chat' ? t('Chat') : t(GENERATIONS[kind].label)
            return (
              <button
                key={kind}
                className={mode === kind ? 'mode-btn mode-btn-active' : 'mode-btn'}
                // Pressing the active generation mode still returns to chat, which is how
                // this worked before Chat had a button of its own. Chat itself is a no-op
                // when already active rather than a toggle: there is nothing to toggle to,
                // and switching to a paid mode by accident is exactly what a visitor
                // reaching for "put it back" must not get.
                onClick={() => onMode(mode === kind ? 'chat' : kind)}
                aria-pressed={mode === kind}
              >
                {/* aria-hidden because the label right beside it already names the mode; a
                    screen reader announcing "image image" is worse than silence. */}
                <Icon className="mode-glyph" size={15} aria-hidden="true" />
                {label}
              </button>
            )
          })}

          {/* Only in a generation mode. In chat these fields mean nothing, and a disabled
              knob is a worse explanation of that than no knob. */}
          {mode !== 'chat' && (
            <GenerationOptions
              mode={mode}
              // The RESOLVED model, not the picker's raw value: `auto/video` has no limits of its
              // own, and the options a user sees have to match what will actually be called.
              model={effective}
              options={options}
              onChange={onOptions}
            />
          )}

          <span className="spacer" />

          <button
            className="send-btn"
            onClick={submit}
            disabled={busy || text.trim() === ''}
            aria-label={t('Send')}
          >
            {busy ? <span className="send-busy" aria-hidden="true" /> : <SendIcon size={15} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div className="hint">
        {mode !== 'chat' ? (
          <>
            {`${GENERATIONS[mode].label} is paid per ${GENERATIONS[mode].unit} — one price, one signature. You'll see the exact amount before anything is spent.`}
            {/* Only when the default took over, and phrased as an offer rather than a notice.
                The picker itself now shows the model that will run, so repeating the name
                here unconditionally was the interface talking about its own state instead of
                the user's next move — and when the two disagreed, this small print was the
                only place the truth appeared. */}
            {effective !== model && (
              <span className="hint-model"> Picked {effective} for you — change it above.</span>
            )}
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
