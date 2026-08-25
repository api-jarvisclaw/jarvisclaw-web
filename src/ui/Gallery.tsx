import { CheckIcon, CopyIcon, ExternalLinkIcon, SparklesIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { galleryTotalUsd, type GalleryItem } from '../lib/gallery'
import { SHOWCASE, showcaseMode, showcaseUrl, type ShowcaseItem } from '../lib/showcase'

export type GalleryTab = 'showcase' | 'mine'

/**
 * Two galleries behind two tabs, because they are two different things.
 *
 *   Prompt gallery — 32 curated examples with the prompt that made each one, there to be read,
 *                    copied and re-run. Nobody paid for these here.
 *   Your creations — media this user generated and was charged for.
 *
 * Merging them was the tempting shortcut and would have been wrong: someone else's example
 * sitting next to your own $0.40 video, with nothing saying which is which, makes the one number
 * that matters — what you have spent — unreadable.
 *
 * The prompt gallery is first because of who is looking. An empty "your creations" tab is the
 * default state of every new visitor, and landing on an empty page is what makes someone leave.
 * Thirty-two working prompts is the answer to "what can this thing actually do".
 */
export function Gallery({
  items,
  tab,
  onTab,
  onRemove,
  onUsePrompt,
}: {
  items: GalleryItem[]
  tab: GalleryTab
  onTab: (t: GalleryTab) => void
  onRemove: (id: string) => void
  /** Loads a prompt into the composer in the right mode, ready to run. */
  onUsePrompt: (prompt: string, mode: 'image' | 'video') => void
}) {
  return (
    <div className="transcript">
      <div className="gallery-tabs" role="tablist" aria-label="Gallery">
        <button
          role="tab"
          aria-selected={tab === 'showcase'}
          className={tab === 'showcase' ? 'gallery-tab gallery-tab-active' : 'gallery-tab'}
          onClick={() => onTab('showcase')}
        >
          Prompt gallery
          <span className="gallery-tab-count">{SHOWCASE.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'mine'}
          className={tab === 'mine' ? 'gallery-tab gallery-tab-active' : 'gallery-tab'}
          onClick={() => onTab('mine')}
        >
          Your creations
          {/* No count when empty. A grey "0" beside a tab reads as a broken counter, and it is
              the one thing a first-time visitor would see. */}
          {items.length > 0 && <span className="gallery-tab-count">{items.length}</span>}
        </button>
      </div>

      {tab === 'showcase' ? (
        <ShowcasePane onUsePrompt={onUsePrompt} />
      ) : (
        <MinePane items={items} onRemove={onRemove} />
      )}
    </div>
  )
}

function ShowcasePane({
  onUsePrompt,
}: {
  onUsePrompt: (prompt: string, mode: 'image' | 'video') => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const selected = useMemo(() => SHOWCASE.find((s) => s.slug === open) ?? null, [open])

  return (
    <>
      <div className="gallery-head">
        <div>
          <h2>Real prompts you can copy</h2>
          <p className="gallery-sub">
            Every one of these was made by paying per generation — GPT Image 2 and SeeDance. Open
            one to read the full prompt, then run it yourself.
          </p>
        </div>
      </div>

      <div className="showcase-grid">
        {SHOWCASE.map((item) => (
          <button
            key={item.slug}
            className="showcase-card"
            onClick={() => setOpen(item.slug)}
            aria-label={`Open ${item.title}`}
          >
            {item.kind === 'video' ? (
              // Muted, looping, inline autoplay — a grid of 32 sound sources would be unusable,
              // and `playsInline` is what stops iOS taking a tile fullscreen on its own.
              <video
                src={showcaseUrl(item.asset)}
                poster={item.poster ? showcaseUrl(item.poster) : undefined}
                muted
                loop
                playsInline
                preload="metadata"
              />
            ) : (
              <img src={showcaseUrl(item.asset)} alt={item.title} loading="lazy" />
            )}
            <span className="showcase-card-body">
              <span className="showcase-card-title">{item.title}</span>
              <span className="showcase-card-meta">
                <span className="tool-name">{item.model}</span>
                {item.author && <span className="showcase-author">{item.author}</span>}
              </span>
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <ShowcaseDetail item={selected} onClose={() => setOpen(null)} onUsePrompt={onUsePrompt} />
      )}
    </>
  )
}

function ShowcaseDetail({
  item,
  onClose,
  onUsePrompt,
}: {
  item: ShowcaseItem
  onClose: () => void
  onUsePrompt: (prompt: string, mode: 'image' | 'video') => void
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!item.prompt) return
    try {
      await navigator.clipboard.writeText(item.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard access is refused outright in some contexts (an insecure origin, a denied
      // permission). The prompt is fully selectable on screen, so failing quietly leaves a way
      // to get it — an error dialog would not.
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
              <span className="tool-name">{item.model}</span>
              {/* Attribution, kept because these are other people's work. Franklin credits every
                  handle and the upstream collection; dropping either to save a line would be
                  taking credit for writing that is not ours. */}
              {item.author && <span className="showcase-author">{item.author}</span>}
              {item.credit && (
                <a href={item.credit} target="_blank" rel="noopener noreferrer">
                  prompt source
                  <ExternalLinkIcon size={11} aria-hidden="true" />
                </a>
              )}
            </p>
          </div>
          <button className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="showcase-detail-media">
          {item.kind === 'video' ? (
            <video
              src={showcaseUrl(item.asset)}
              poster={item.poster ? showcaseUrl(item.poster) : undefined}
              controls
              loop
              playsInline
              preload="metadata"
            />
          ) : (
            <img src={showcaseUrl(item.asset)} alt={item.title} />
          )}
        </div>

        {item.prompt ? (
          <>
            <div className="showcase-prompt-head">
              <span>Prompt</span>
              <div className="showcase-prompt-actions">
                <button className="ghost-btn" onClick={copy}>
                  {copied ? (
                    <CheckIcon size={13} aria-hidden="true" />
                  ) : (
                    <CopyIcon size={13} aria-hidden="true" />
                  )}
                  {copied ? 'Copied' : 'Copy prompt'}
                </button>
                {/* The point of the whole gallery. Copying is a step towards running it; this is
                    running it, in the mode the prompt was written for. */}
                <button
                  className="approve"
                  onClick={() => {
                    onUsePrompt(item.prompt as string, showcaseMode(item))
                    onClose()
                  }}
                >
                  <SparklesIcon size={13} aria-hidden="true" />
                  Make your own
                </button>
              </div>
            </div>
            <pre className="showcase-prompt">{item.prompt}</pre>
            {/* Said before the price dialog rather than after. These prompts contain
                `{argument name="…" default="…"}` markers where the original author expected an
                edit, and running one unchanged spends real money on their example. */}
            {item.prompt.includes('{argument') && (
              <p className="showcase-note">
                The <code>{'{argument …}'}</code> parts are meant to be changed — a headline, a
                brand, a name. Edit them in the message box before running, or you will pay to
                reproduce the example exactly.
              </p>
            )}
          </>
        ) : (
          <p className="showcase-note">
            No single prompt for this one — it was assembled from a sequence of shots rather than
            written in one go.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Everything the user has generated and paid for.
 *
 * The empty state does real work here. A gallery that has never been used looks identical to one
 * that lost its index, so it says which is which — and it says the index is per-browser, because
 * with no account that is a real limitation someone will otherwise discover by losing a list.
 */
function MinePane({
  items,
  onRemove,
}: {
  items: GalleryItem[]
  onRemove: (id: string) => void
}) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <span className="eyebrow">Your creations</span>
        <h1>Nothing here yet</h1>
        <p>
          Images, video, music and speech you generate are stored permanently and collected here.
          Use the buttons under the message box to make something — or start from one of the
          prompts in the other tab.
        </p>
        <p className="empty-fine">
          The list is kept in this browser, since there is no account to attach it to. The files
          themselves live on the CDN and stay put.
        </p>
      </div>
    )
  }

  const total = galleryTotalUsd(items)

  return (
    <>
      <div className="gallery-head">
        <h2>
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </h2>
        {/* The sum of real charges. On a page that spends money per click, the total already
            spent is more useful than a count. */}
        <span className="price">${total.toFixed(6)} spent</span>
      </div>

      <div className="gallery-grid">
        {items.map((item) => (
          <figure key={item.id} className="gallery-card">
            {item.kind === 'image' ? (
              <img src={item.url} alt={item.prompt} loading="lazy" />
            ) : item.kind === 'video' ? (
              <video src={item.url} controls preload="metadata" />
            ) : (
              <audio src={item.url} controls preload="metadata" />
            )}

            <figcaption>
              <p className="gallery-prompt">{item.prompt}</p>
              <div className="gallery-meta">
                <span className="tool-name">{item.model}</span>
                <span className="price">${item.usd.toFixed(6)}</span>
              </div>
              <div className="gallery-actions">
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
                {/* Says what it does and does not do. Removing the row cannot delete the stored
                    object — this page has no delete credential — and implying otherwise would be
                    a false promise about someone's data. */}
                <button
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove ${item.prompt} from this list`}
                  title="Removes it from this list. The file stays on the CDN."
                >
                  Remove
                </button>
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
    </>
  )
}
