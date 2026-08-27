import { CheckIcon, CopyIcon, ExternalLinkIcon, PlayIcon, SparklesIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  SEEDANCE,
  SEEDANCE_COLLECTION_URL,
  seedanceUrl,
  type SeedancePrompt,
} from '../lib/seedance'

/**
 * The Seedance 2.0 prompt collection.
 *
 * 105 published video prompts with the frame each produced. This is reference material for the
 * hardest thing to write in this product — several of these run past ten thousand words of
 * shot-by-shot direction, and reading one real example beats staring at an empty box.
 *
 * ## The distinction this pane exists to get right
 *
 * Only 5 of the 105 have a clip we can serve. The rest publish Cloudflare Stream HLS only, which
 * this page's CSP has no reason to admit a player for. So a non-playable entry renders as a still
 * — no `<video>`, no play affordance, and a label saying it is a frame.
 *
 * Putting a play button over a frame that cannot move would be the same defect as the paid $0.83
 * video that rendered a dead player, except by construction rather than by accident. `playable`
 * carries that fact in the data so no part of the UI has to infer it.
 */
export function SeedancePane({
  onUsePrompt,
}: {
  onUsePrompt: (prompt: string, mode: 'image' | 'video') => void
}) {
  const [open, setOpen] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const selected = useMemo(() => SEEDANCE.find((p) => p.id === open) ?? null, [open])

  /**
   * Client-side search, unlike the marketplace's — and correct here for the opposite reason.
   * The whole collection is already in memory (that is what the lazy chunk bought), so a filter
   * is exact and instant, and a count from it is true rather than a guess about a page.
   */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return SEEDANCE
    return SEEDANCE.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.prompt.toLowerCase().includes(q) ||
        (p.author ?? '').toLowerCase().includes(q),
    )
  }, [query])

  const playable = useMemo(() => SEEDANCE.filter((p) => p.playable).length, [])

  return (
    <>
      <div className="gallery-head">
        <div>
          <h2>Video prompts that worked</h2>
          <p className="gallery-sub">
            {SEEDANCE.length} published Seedance 2.0 prompts with the frame each one produced, from{' '}
            {/* The collection's own credit, shown once. Per-item credits name the prompt's author;
                this names the people who assembled the collection. CC BY 4.0 asks for both, and
                they are genuinely different contributions. */}
            <a href={SEEDANCE_COLLECTION_URL} target="_blank" rel="noopener noreferrer">
              awesome-seedance-2-prompts
              <ExternalLinkIcon size={11} aria-hidden="true" />
            </a>{' '}
            (CC BY 4.0). Open one to read it in full, then run it yourself.
          </p>
          {/* Said plainly rather than discovered by clicking. Someone who opens ten stills in a row
              expecting video would conclude the gallery is broken; naming the ratio up front makes
              a still the expected thing. */}
          <p className="gallery-sub gallery-sub-quiet">
            {playable} include the clip. The rest are the result frame plus the prompt — the
            original videos are hosted as streams we cannot re-serve.
          </p>
        </div>
      </div>

      <div className="seedance-search-row">
        <input
          className="market-search"
          type="search"
          value={query}
          placeholder="search prompts"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() !== '' && (
          <span className="seedance-count">
            {shown.length} of {SEEDANCE.length}
          </span>
        )}
      </div>

      {shown.length === 0 && <p className="gallery-sub">Nothing matches “{query}”.</p>}

      <div className="showcase-grid">
        {shown.map((p) => (
          <button
            key={p.id}
            className="showcase-card"
            onClick={() => setOpen(p.id)}
            aria-label={`Open ${p.title}`}
          >
            {p.playable && p.video !== null ? (
              <video
                src={seedanceUrl(p.video)}
                poster={seedanceUrl(p.poster)}
                muted
                loop
                playsInline
                preload="metadata"
              />
            ) : (
              // A plain image. Not a <video> with a poster and no source, which is what a dead
              // player looks like in markup.
              <img src={seedanceUrl(p.poster)} alt={p.title} loading="lazy" />
            )}
            <span className="showcase-card-body">
              <span className="showcase-card-title">{p.title}</span>
              <span className="showcase-card-meta">
                {p.playable ? (
                  <span className="seedance-badge">
                    <PlayIcon size={9} aria-hidden="true" />
                    clip
                  </span>
                ) : (
                  <span className="seedance-badge seedance-badge-quiet">frame</span>
                )}
                {p.author && <span className="showcase-author">{p.author}</span>}
              </span>
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <SeedanceDetail item={selected} onClose={() => setOpen(null)} onUsePrompt={onUsePrompt} />
      )}
    </>
  )
}

function SeedanceDetail({
  item,
  onClose,
  onUsePrompt,
}: {
  item: SeedancePrompt
  onClose: () => void
  onUsePrompt: (prompt: string, mode: 'image' | 'video') => void
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard access is refused outright in some contexts. The prompt is fully selectable on
      // screen, so failing quietly leaves a way to get it; an error dialog would not.
    }
  }

  return (
    <div className="scrim" onClick={onClose} role="presentation">
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
              <span className="tool-name">Seedance 2.0</span>
              {/* Attribution, required by CC BY 4.0 and right regardless: someone wrote this. The
                  handle links to their profile and the source to the post it was published in. */}
              {item.author &&
                (item.authorLink ? (
                  <a href={item.authorLink} target="_blank" rel="noopener noreferrer">
                    {item.author}
                    <ExternalLinkIcon size={11} aria-hidden="true" />
                  </a>
                ) : (
                  <span className="showcase-author">{item.author}</span>
                ))}
              {item.source && (
                <a href={item.source} target="_blank" rel="noopener noreferrer">
                  original post
                  <ExternalLinkIcon size={11} aria-hidden="true" />
                </a>
              )}
              {item.published && <span className="showcase-author">{item.published}</span>}
            </p>
          </div>
          <button className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="showcase-detail-media">
          {item.playable && item.video !== null ? (
            <video
              src={seedanceUrl(item.video)}
              poster={seedanceUrl(item.poster)}
              controls
              loop
              playsInline
              preload="metadata"
            />
          ) : (
            <img src={seedanceUrl(item.poster)} alt={item.title} />
          )}
        </div>

        {!item.playable && (
          // Explains the still rather than leaving someone to wonder why it will not play, and
          // points at where the video does exist. Silence here reads as a broken player.
          <p className="seedance-frame-note">
            A frame from the result. The clip is hosted as a stream on the original post
            {item.source && (
              <>
                {' — '}
                <a href={item.source} target="_blank" rel="noopener noreferrer">
                  watch it there
                  <ExternalLinkIcon size={11} aria-hidden="true" />
                </a>
              </>
            )}
            .
          </p>
        )}

        {/* Same structure and classnames as the showcase detail, deliberately. These two panes are
            the same kind of thing to a reader, and giving them separate styling would make them
            look like separate features that happen to sit behind adjacent tabs. */}
        <div className="showcase-prompt-head">
          <span>
            Prompt
            <span className="seedance-prompt-len">
              {item.prompt.length.toLocaleString()} chars
              {item.lang === 'zh' && ' · written in Chinese'}
            </span>
          </span>
          <div className="showcase-prompt-actions">
            <button className="ghost-btn" onClick={() => void copy()}>
              {copied ? (
                <CheckIcon size={13} aria-hidden="true" />
              ) : (
                <CopyIcon size={13} aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy prompt'}
            </button>
            {/* Loads the prompt into the composer rather than running it. These are other people's
                finished examples and reproducing one verbatim costs real money; the point is to
                edit it. The consent dialog still asks before anything is spent. */}
            <button
              className="approve"
              onClick={() => {
                onUsePrompt(item.prompt, 'video')
                onClose()
              }}
            >
              <SparklesIcon size={13} aria-hidden="true" />
              Make your own
            </button>
          </div>
        </div>
        {/* Preformatted, not reflowed. The line breaks and beat markers ("0–2s", "[Style]") ARE the
            craft in a prompt this long — collapsing them would turn a 15-shot storyboard into one
            paragraph and remove the only structure a reader can navigate by. */}
        <pre className="showcase-prompt">{item.prompt}</pre>

        {item.prompt.length > 4000 && (
          // Worth saying for the long ones. A prompt this size is a whole shot list, and running it
          // unedited buys someone else's finished film rather than your own.
          <p className="showcase-note">
            This one is {item.prompt.length.toLocaleString()} characters — a full shot list. Trim it
            to the beats you want before running, or you will pay to reproduce the example exactly.
          </p>
        )}
      </div>
    </div>
  )
}
