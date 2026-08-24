import { useEffect, useMemo, useRef, useState } from 'react'

import { displayPrice, type CatalogueModel, type Modality } from '../lib/catalogue'

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
  onSelect,
}: {
  models: CatalogueModel[]
  selected: string
  loading: boolean
  onSelect: (model: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [modality, setModality] = useState<Modality | 'all'>('all')
  const boxRef = useRef<HTMLDivElement>(null)

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
      if (modality !== 'all' && m.modality !== modality) return false
      return q === '' || m.model.toLowerCase().includes(q)
    })
    // Free first, then virtual (auto/*), then alphabetical. Cheapest-first would be
    // misleading: the per-call models all report 0 and would sort to the front while
    // actually being the expensive ones.
    return rows.sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1
      if (a.virtual !== b.virtual) return a.virtual ? -1 : 1
      return a.model.localeCompare(b.model)
    })
  }, [models, query, modality])

  const current = models.find((m) => m.model === selected)

  return (
    <div className="picker" ref={boxRef}>
      <button
        className="picker-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="picker-name">{selected}</span>
        {current?.free && <span className="picker-free">free</span>}
        <span className="picker-caret" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open && (
        <div className="picker-menu" role="listbox">
          <input
            className="picker-search"
            type="search"
            value={query}
            placeholder={loading ? 'loading models…' : `search ${models.length} models`}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />

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

          <div className="picker-rows">
            {shown.length === 0 ? (
              <p className="picker-empty">
                {loading ? 'Loading the catalogue…' : 'No model matches that.'}
              </p>
            ) : (
              shown.slice(0, 120).map((m) => (
                <button
                  key={m.model}
                  className={m.model === selected ? 'picker-row picker-row-active' : 'picker-row'}
                  role="option"
                  aria-selected={m.model === selected}
                  onClick={() => {
                    onSelect(m.model)
                    setOpen(false)
                  }}
                >
                  <span className="picker-row-name">{m.model}</span>
                  <span className={m.free ? 'picker-row-price is-free' : 'picker-row-price'}>
                    {displayPrice(m)}
                  </span>
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
