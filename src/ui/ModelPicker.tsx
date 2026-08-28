import { ChevronDownIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { displayPrice, type CatalogueModel, type Modality } from '../lib/catalogue'
import {
  GENERATIONS,
  modeForModel,
  UNSERVABLE_VIRTUALS,
  type GenerationKind,
} from '../lib/modality'
import { useT } from './LocaleContext'

/**
 * The model a mode will actually run, given what the user picked.
 *
 * In a generation mode the picked model is used only if it can serve that mode; otherwise the
 * mode's verified default takes over. That override always happened — it is what stops a video
 * model being POSTed to the music endpoint — but it was disclosed only in small print below
 * the composer while the trigger kept showing the stale name. Switching to Music with
 * `bytedance/seedance-2.0-fast` selected showed that name in the picker and
 * "Using minimax/music-2.5+" underneath: the interface contradicting itself, with the truth in
 * the smaller text. Reported as "the model is still the one I chose myself, this isn't smart".
 *
 * Exported and pure so the behaviour can be pinned without rendering: the bug was never in the
 * override, only in which of two disagreeing names was shown.
 */
export function effectiveModel(
  models: CatalogueModel[],
  selected: string,
  mode: GenerationKind | 'chat',
): string {
  if (mode === 'chat') return selected
  const picked = models.find((m) => m.model === selected)
  // An unknown name cannot be shown to serve the mode, so the default wins. This is the
  // catalogue-still-loading case, and claiming the picked model works would be a guess.
  if (!picked || modeForModel(picked.model, picked.modality) !== mode) {
    return GENERATIONS[mode].defaultModel
  }
  return selected
}

/**
 * Model chooser.
 *
 * 334 models is too many for a flat list, so it filters by modality and by typed text.
 * Free models are grouped first: on a page whose whole promise is "start with no account",
 * the models that work without one belong at the top.
 */
export function ModelPicker({
  models,
  selected,
  loading,
  mode,
  onSelect,
}: {
  models: CatalogueModel[]
  selected: string
  loading: boolean
  /**
   * The generation mode in force, or 'chat'.
   *
   * The picker used to ignore this, and the result read as the app not listening. Switching to
   * Music while `bytedance/seedance-2.0-fast` was picked left that name in the trigger, while
   * the hint underneath said "Using minimax/music-2.5+" — the interface contradicting itself,
   * with the truth in the smaller text. Reported as "the model is the one I chose myself, this
   * isn't smart".
   *
   * So the mode now drives the picker: the list narrows to models that can serve it, and the
   * trigger names the model that will actually run.
   */
  mode: GenerationKind | 'chat'
  onSelect: (model: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [modality, setModality] = useState<Modality | 'all'>('all')
  const boxRef = useRef<HTMLDivElement>(null)

  /**
   * Clears the search when the mode changes.
   *
   * Found by a probe, not by reading this: the query survived closing the menu, so searching
   * "seedance" in chat and then switching to Music left the filter as "seedance AND music" and
   * the list came up EMPTY — `search 0 music models`. An empty picker reads as "this gateway
   * has no music models", which is both wrong and exactly the kind of dead end that makes
   * someone give up. The narrowing this fix introduced is what made a stale query fatal
   * rather than merely untidy.
   */
  useEffect(() => {
    setQuery('')
    setModality('all')
  }, [mode])

  // Closes on an outside click and on Escape. Both are needed: this sits in the composer,
  // and a picker that traps the page is worse than no picker.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = models.filter((m) => {
      // In a generation mode, only models that can serve THAT mode. Offering a chat model
      // under Music is offering a choice the app will silently discard — the mode's default
      // wins anyway, so the list was advertising 334 options where a handful were real.
      //
      // Matched on the resolved mode, not the raw modality: `audio` covers both music
      // (/v1/audio/generations, per track) and speech (/v1/audio/speech, per clip), so
      // filtering by modality alone would put voices in the music list.
      if (mode !== 'chat' && modeForModel(m.model, m.modality) !== mode) return false
      if (modality !== 'all' && m.modality !== modality) return false
      return q === '' || m.model.toLowerCase().includes(q)
    })
    // Free first, then virtual (auto/*), then alphabetical. Cheapest-first would be
    // misleading: the per-call models all report 0 and would sort to the front while
    // actually being the expensive ones.
    //
    // The unservable virtuals are the exception, sorted last despite being "free" and
    // virtual. They are the most attractive-looking rows in the list and the only ones that
    // cannot work: `auto/tts` 400s on the speech endpoint while billing happily as chat.
    return rows.sort((a, b) => {
      const aBad = UNSERVABLE_VIRTUALS.includes(a.model)
      const bBad = UNSERVABLE_VIRTUALS.includes(b.model)
      if (aBad !== bBad) return aBad ? 1 : -1
      if (a.free !== b.free) return a.free ? -1 : 1
      if (a.virtual !== b.virtual) return a.virtual ? -1 : 1
      return a.model.localeCompare(b.model)
    })
  }, [models, mode, query, modality])

  const effective = effectiveModel(models, selected, mode)
  /** True when the shown name is the mode's default rather than the user's own pick. */
  const overridden = effective !== selected

  const current = models.find((m) => m.model === effective)

  return (
    <div className="picker" ref={boxRef}>
      <button
        className="picker-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="picker-name">{effective}</span>
        {current?.free && <span className="picker-free">{t('free')}</span>}
        {/* Says the choice was automatic. Without a marker the swapped-in default looks
            like the user's own selection, so a later "why is it using that model?" has no
            answer on screen. */}
        {overridden && <span className="picker-auto">{t('auto')}</span>}
        <ChevronDownIcon className="picker-caret" size={13} aria-hidden="true" />
      </button>

      {open && (
        <div className="picker-menu" role="listbox">
          <input
            className="picker-search"
            type="search"
            value={query}
            placeholder={
              loading
                ? 'loading models…'
                : // Counts what is actually reachable here. `models.length` promised 334 in a
                  // mode that offers eleven, which reads as a broken search rather than a
                  // deliberately narrowed list.
                  `search ${shown.length} ${mode === 'chat' ? '' : `${GENERATIONS[mode].label.toLowerCase()} `}models`
            }
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />

          {/* Hidden in a generation mode: the modality is already fixed by the mode, so the
              tabs could only ever narrow to nothing or to what is already shown. */}
          {mode === 'chat' && (
            <div className="picker-tabs">
              {(['all', 'text', 'image', 'video', 'audio'] as const).map((m) => (
                <button
                  key={m}
                  className={modality === m ? 'picker-tab picker-tab-active' : 'picker-tab'}
                  onClick={() => setModality(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          <div className="picker-rows">
            {shown.length === 0 ? (
              <p className="picker-empty">
                {loading ? 'Loading the catalogue…' : 'No model matches that.'}
              </p>
            ) : (
              shown.slice(0, 120).map((m) => (
                <button
                  key={m.model}
                  className={m.model === effective ? 'picker-row picker-row-active' : 'picker-row'}
                  role="option"
                  aria-selected={m.model === effective}
                  onClick={() => {
                    onSelect(m.model)
                    setOpen(false)
                  }}
                >
                  <span className="picker-row-name">{m.model}</span>
                  {UNSERVABLE_VIRTUALS.includes(m.model) ? (
                    // Labelled rather than hidden. Hiding it would leave someone searching for
                    // a name the catalogue advertises and concluding the picker is broken;
                    // this says the catalogue is the thing that is wrong.
                    <span className="picker-row-price is-broken">{t('not servable')}</span>
                  ) : (
                    <span className={m.free ? 'picker-row-price is-free' : 'picker-row-price'}>
                      {displayPrice(m)}
                    </span>
                  )}
                </button>
              ))
            )}
            {shown.length > 120 && (
              // Said out loud rather than silently truncated: a list that stops at 120
              // looks complete, and someone would conclude their model is unavailable.
              <p className="picker-empty">
                {shown.length - 120} more — narrow the search to see them.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
