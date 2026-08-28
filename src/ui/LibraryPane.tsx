import { CheckIcon, CopyIcon, ExternalLinkIcon, SparklesIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  LIBRARY,
  LIBRARY_CATEGORIES,
  LIBRARY_LICENSE,
  LIBRARY_SOURCE_URL,
  type LibraryCategory,
  type LibraryPrompt,
} from '../lib/library'
import { Scrim } from './Scrim'
import { useT } from './LocaleContext'

/**
 * The prompt library — 119 tested prompts, organised by what they are for.
 *
 * ## Why this pane looks nothing like the Seedance one
 *
 * Seedance entries each have a result frame, so that pane is a grid of images and the picture does
 * the browsing. These have no media at all: the upstream repo is 18 markdown files. Generating
 * ~119 illustrations through our own gateway would cost real money and produce a proportion that
 * do not match their prompt, and an illustration that misrepresents its prompt is worse than none.
 *
 * So the browsing weight falls on the CATEGORY strip and the intent line. A reader arrives not
 * knowing what is on offer, which is the same problem the marketplace has, and the answer is the
 * same: show the choices before the results.
 *
 * ## Two things the card must state before it is opened
 *
 * The category and whether it is an image or a video prompt. Without the second one a reader picks
 * a cinematic shot description, sends it to the image endpoint, and gets a poster of a scene
 * instead of the scene — which reads as the model being bad rather than the prompt being for
 * something else.
 */
export function LibraryPane({
  onUsePrompt,
}: {
  onUsePrompt: (prompt: string, mode: 'image' | 'video') => void
}) {
  const t = useT()
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<LibraryCategory | null>(null)

  const selected = useMemo(() => LIBRARY.find((p) => p.id === open) ?? null, [open])

  /**
   * Category counts over the WHOLE library, not the filtered set, so the strip keeps showing
   * every option rather than collapsing to the one already chosen — the same rule the marketplace
   * facet follows, and for the same reason: a filter UI that hides the alternatives is a dead end.
   */
  const counts = useMemo(() => {
    const out = new Map<LibraryCategory, number>()
    for (const p of LIBRARY) out.set(p.category, (out.get(p.category) ?? 0) + 1)
    return out
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return LIBRARY.filter((p) => {
      if (category !== null && p.category !== category) return false
      if (q === '') return true
      // Title, prompt and the author's intent note. The intent is what makes a prompt findable
      // by what it DOES ("平面图转线稿") rather than by the style words inside it.
      return (
        p.title.toLowerCase().includes(q) ||
        p.prompt.toLowerCase().includes(q) ||
        (p.intent ?? '').toLowerCase().includes(q)
      )
    })
  }, [query, category])

  const videoCount = useMemo(() => LIBRARY.filter((p) => p.kind === 'video').length, [])

  return (
    <>
      <div className="gallery-head">
        <div>
          <h2>{t('Prompts that were tested')}</h2>
          <p className="gallery-sub">
            {LIBRARY.length} prompts written and tested by their author, from{' '}
            {/* MIT requires the notice to travel with the work, and crediting the person who
                wrote them is the right thing regardless. */}
            <a href={LIBRARY_SOURCE_URL} target="_blank" rel="noopener noreferrer">
              prompt-engineering-text-to-image-and-video
              <ExternalLinkIcon size={11} aria-hidden="true" />
            </a>{' '}
            ({LIBRARY_LICENSE}). Open one to read it in full, then run it yourself.
          </p>
          {/* Stated up front rather than discovered by clicking. Most of this collection is video
              direction, and someone expecting image prompts should know that before picking one. */}
          <p className="gallery-sub gallery-sub-quiet">
            {videoCount} are video shot descriptions with camera moves and physics notes; the
            other {LIBRARY.length - videoCount} restyle an image you upload. Most carry the
            author&rsquo;s own aspect ratio, duration and negative prompt.
          </p>
        </div>
      </div>

      {/* Categories above the results. With no thumbnails to scan, this strip is the only thing
          telling a reader what the collection contains. */}
      <nav className="library-cats" aria-label="Prompt categories">
        <button
          className={category === null ? 'market-cat is-on' : 'market-cat'}
          onClick={() => setCategory(null)}
        >
          {t('All')}
          <span className="market-cat-n">{LIBRARY.length}</span>
        </button>
        {LIBRARY_CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={category === c.id ? 'market-cat is-on' : 'market-cat'}
            // Clicking the active category clears it: a filter with no visible way out is a dead
            // end, and the "All" button is easy to miss once the list has scrolled.
            onClick={() => setCategory((cur) => (cur === c.id ? null : c.id))}
            title={c.label}
          >
            {c.en}
            <span className="market-cat-n">{counts.get(c.id) ?? 0}</span>
          </button>
        ))}
      </nav>

      <div className="seedance-search-row">
        <input
          className="market-search"
          type="search"
          value={query}
          placeholder={t('search prompts')}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(query.trim() !== '' || category !== null) && (
          <span className="seedance-count">
            {shown.length} of {LIBRARY.length}
          </span>
        )}
      </div>

      {shown.length === 0 && (
        <p className="gallery-sub">
          Nothing matches{query.trim() !== '' ? ` “${query}”` : ''}
          {category !== null ? ' in this category' : ''}.
        </p>
      )}

      <div className="library-grid">
        {shown.map((p) => (
          <button
            key={p.id}
            className="library-card"
            onClick={() => setOpen(p.id)}
            aria-label={`Open ${p.title}`}
          >
            <span className="library-card-head">
              <span className="library-card-title">{p.title}</span>
              <span
                className={
                  p.kind === 'video' ? 'library-kind library-kind-video' : 'library-kind'
                }
              >
                {p.kind}
              </span>
            </span>
            {/* The author's own note about what this is for, when there is one. Six of the entries
                have it and they are the image-restyling ones, where "what it does" is the whole
                point. Falls back to the opening of the prompt, which for a shot description names
                the scene. */}
            <span className="library-card-body">{p.intent ?? p.prompt}</span>
            <span className="library-card-meta">
              <span className="library-cat-tag">
                {LIBRARY_CATEGORIES.find((c) => c.id === p.category)?.en ?? p.category}
              </span>
              {p.params.aspect_ratio && (
                <span className="library-param">{p.params.aspect_ratio}</span>
              )}
              {p.params.duration_s && (
                <span className="library-param">{p.params.duration_s}s</span>
              )}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <LibraryDetail item={selected} onClose={() => setOpen(null)} onUsePrompt={onUsePrompt} />
      )}
    </>
  )
}

function LibraryDetail({
  item,
  onClose,
  onUsePrompt,
}: {
  item: LibraryPrompt
  onClose: () => void
  onUsePrompt: (prompt: string, mode: 'image' | 'video') => void
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard access can be refused, and the prompt is selectable on screen either way.
      // A thrown error here would take down the dialog over a convenience.
    }
  }

  const params = Object.entries(item.params)

  return (
    /**
     * `scrim` + `showcase-detail`, the same pair SeedancePane uses. Deliberately reused rather
     * than given its own classes: my first version invented `showcase-modal`, `-inner`, `-head`
     * and `-actions`, and NONE of the four had a CSS rule. The dialog mounted, held a real 573px
     * box, and Playwright's is_visible() said true — at y=9928, appended a full ten thousand
     * pixels below the grid, with position:static, z-index:auto and a transparent background.
     *
     * So it opened and nothing happened on screen, and the probe that read .showcase-prompt (a
     * class that DOES have CSS) got its 518 characters and passed. A class name with no rule
     * behind it fails exactly this way: silently, and only for the person looking at it.
     */
    <Scrim onClose={onClose}>
      <div
        className="showcase-detail"
        role="dialog"
        aria-modal="true"
        aria-label={item.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="showcase-detail-head">
          <div>
            <h3>{item.title}</h3>
            <p className="showcase-detail-meta">
              {LIBRARY_CATEGORIES.find((c) => c.id === item.category)?.en ?? item.category}
              {' · '}
              {item.kind === 'video' ? 'video prompt' : 'image prompt'}
              {/* Which of the author's documents this came from, so a reader can find it in
                  context. The filename is Chinese and shown as-is: it is the author's own title
                  for that series, and translating it would make it unfindable in their repo. */}
              {' · '}
              <a
                href={`${LIBRARY_SOURCE_URL}/blob/main/${encodeURIComponent(item.sourceFile)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.sourceFile}
                <ExternalLinkIcon size={11} aria-hidden="true" />
              </a>
            </p>
          </div>
          <button className="link-btn" onClick={onClose}>
            {t('close')}
          </button>
        </div>

        {item.intent && <p className="library-intent">{item.intent}</p>}

        {/* pre-wrap, not a reflow. The Start / Action / End structure is how the prompt is meant
            to be read, and collapsing it would destroy the thing worth copying. */}
        <pre className="showcase-prompt">{item.prompt}</pre>

        {params.length > 0 && (
          <dl className="library-params">
            {params.map(([k, v]) => (
              <div key={k} className="library-param-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* `showcase-prompt-actions` and `approve` again rather than a new pair: `showcase-run`
            was also invented and also had no rule, so the primary action rendered as unstyled
            default-browser text. */}
        <div className="showcase-prompt-actions">
          <button className="ghost-btn" onClick={() => void copy()}>
            {copied ? (
              <CheckIcon size={13} aria-hidden="true" />
            ) : (
              <CopyIcon size={13} aria-hidden="true" />
            )}
            {copied ? t('Copied') : t('Copy prompt')}
          </button>
          {/* Loads the prompt into the composer; it does not spend anything. `item.kind`, never a
              literal — sending a shot description to the image endpoint returns a poster of the
              scene instead of the scene. */}
          <button
            className="approve"
            onClick={() => {
              onUsePrompt(item.prompt, item.kind)
              onClose()
            }}
          >
            <SparklesIcon size={13} aria-hidden="true" />
            {t('Make your own')}
          </button>
        </div>
      </div>
    </Scrim>
  )
}
