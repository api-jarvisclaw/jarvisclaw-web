import {
  AlertTriangleIcon,
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  SparklesIcon,
} from 'lucide-react'
import { lazy, Suspense, useMemo, useState } from 'react'

import {
  galleryTotalUsd,
  RETENTION_NOTE,
  retentionIsAtRisk,
  retentionOf,
  type GalleryItem,
} from '../lib/gallery'
import { LIBRARY_COUNT } from '../lib/library-count'
import { SEEDANCE_COUNT } from '../lib/seedance-count'
import { SHOWCASE, showcaseMode, showcaseUrl, type ShowcaseItem } from '../lib/showcase'
import { Scrim } from './Scrim'
import { useT } from './LocaleContext'

/**
 * The Seedance pane is lazy, and it is the only lazy thing in this app.
 *
 * Its data is 286 KB of prompt text — several of those prompts run past ten thousand words of
 * shot-by-shot direction, which is the point of having them. Statically imported it lands in the
 * main bundle, so every visitor downloads a video-prompt library before the chat box appears,
 * including the majority who never open the gallery at all.
 *
 * The count is imported separately from a tiny module so the tab can show it without pulling the
 * payload. Reading `SEEDANCE.length` here would defeat the whole split — the import would be
 * static again and the chunk would be merged back in, silently, with the code still looking
 * lazy.
 */
const SeedancePane = lazy(() =>
  import('./SeedancePane').then((m) => ({ default: m.SeedancePane })),
)

/**
 * Lazy for the same reason as the pane above: `library.ts` is 152 KB of prompt text, and most
 * visitors never open the gallery. `LIBRARY_COUNT` comes from its own module so this tab can show
 * a number without the import going static again and pulling the payload into the main bundle.
 */
const LibraryPane = lazy(() =>
  import('./LibraryPane').then((m) => ({ default: m.LibraryPane })),
)

export type GalleryTab = 'showcase' | 'seedance' | 'library' | 'mine'

/**
 * Three galleries behind three tabs, because they are three different things.
 *
 *   Prompt gallery — 32 curated examples with the prompt that made each one, there to be read,
 *                    copied and re-run. Nobody paid for these here.
 *   Video prompts  — 105 published Seedance 2.0 prompts with their result frames. Reference
 *                    material for the hardest thing to write in this product.
 *   Your creations — media this user generated and was charged for.
 *
 * Merging them was the tempting shortcut and would have been wrong: someone else's example
 * sitting next to your own $0.40 video, with nothing saying which is which, makes the one number
 * that matters — what you have spent — unreadable.
 *
 * Seedance is its own tab rather than more rows in the prompt gallery for a concrete reason:
 * 100 of its 105 entries have a still and no servable clip, so the pane renders them differently.
 * Mixing them in would mean either threading that distinction through the showcase type or
 * putting a play button over a frame that cannot move.
 *
 * The prompt gallery is first because of who is looking. An empty "your creations" tab is the
 * default state of every new visitor, and landing on an empty page is what makes someone leave.
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
  const t = useT()
  return (
    <div className="transcript">
      <div className="gallery-tabs" role="tablist" aria-label="Gallery">
        <button
          role="tab"
          aria-selected={tab === 'showcase'}
          className={tab === 'showcase' ? 'gallery-tab gallery-tab-active' : 'gallery-tab'}
          onClick={() => onTab('showcase')}
        >
          {t('Prompt gallery')}
          <span className="gallery-tab-count">{SHOWCASE.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'seedance'}
          className={tab === 'seedance' ? 'gallery-tab gallery-tab-active' : 'gallery-tab'}
          onClick={() => onTab('seedance')}
        >
          {t('Video prompts')}
          <span className="gallery-tab-count">{SEEDANCE_COUNT}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'library'}
          className={tab === 'library' ? 'gallery-tab gallery-tab-active' : 'gallery-tab'}
          onClick={() => onTab('library')}
        >
          {t('Prompt library')}
          <span className="gallery-tab-count">{LIBRARY_COUNT}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'mine'}
          className={tab === 'mine' ? 'gallery-tab gallery-tab-active' : 'gallery-tab'}
          onClick={() => onTab('mine')}
        >
          {t('Your creations')}
          {/* No count when empty. A grey "0" beside a tab reads as a broken counter, and it is
              the one thing a first-time visitor would see. */}
          {items.length > 0 && <span className="gallery-tab-count">{items.length}</span>}
        </button>
      </div>

      {tab === 'showcase' ? (
        <ShowcasePane onUsePrompt={onUsePrompt} />
      ) : tab === 'seedance' ? (
        // The fallback is a real sentence rather than a spinner: this chunk is ~90 KB gzipped and
        // on a slow connection the wait is long enough that an unlabelled spinner reads as a
        // hang. Saying what is loading is the difference between waiting and giving up.
        <Suspense fallback={<p className="gallery-sub">Loading {SEEDANCE_COUNT} video prompts…</p>}>
          <SeedancePane onUsePrompt={onUsePrompt} />
        </Suspense>
      ) : tab === 'library' ? (
        <Suspense fallback={<p className="gallery-sub">Loading {LIBRARY_COUNT} prompts…</p>}>
          <LibraryPane onUsePrompt={onUsePrompt} />
        </Suspense>
      ) : (
        <MinePane items={items} onRemove={onRemove} />
      )}
    </div>
  )
}

/**
 * One line saying how long this artifact lasts.
 *
 * Per row, because the answer differs per row and the difference matters: an archived file has no
 * expiry, a cached one is gone in about a day, and one still on the provider's host is gone in
 * hours. The page previously claimed "stored permanently" about all three.
 *
 * The at-risk ones get a download link rather than only a warning. Telling someone their file
 * expires tomorrow without offering the one action that saves it is worse than saying nothing —
 * it produces worry instead of a copy. `download` on a cross-origin href does not force a save
 * (the browser navigates instead), so this opens it and says so.
 */
function RetentionLine({ item }: { item: GalleryItem }) {
  const r = retentionOf(item)
  const atRisk = retentionIsAtRisk(r)
  return (
    <p className={atRisk ? 'gallery-retention is-at-risk' : 'gallery-retention'}>
      {atRisk ? (
        <AlertTriangleIcon size={11} aria-hidden="true" />
      ) : (
        <ArchiveIcon size={11} aria-hidden="true" />
      )}
      {RETENTION_NOTE[r]}
    </p>
  )
}

function ShowcasePane({
  onUsePrompt,
}: {
  onUsePrompt: (prompt: string, mode: 'image' | 'video') => void
}) {
  const t = useT()
  const [open, setOpen] = useState<string | null>(null)
  const selected = useMemo(() => SHOWCASE.find((s) => s.slug === open) ?? null, [open])

  return (
    <>
      <div className="gallery-head">
        <div>
          <h2>{t('Real prompts you can copy')}</h2>
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
  const t = useT()
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
    // Portalled out of `.shell` — see Scrim.tsx. Same stacking-context defect as the other three.
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
              <span>{t('Prompt')}</span>
              <div className="showcase-prompt-actions">
                <button className="ghost-btn" onClick={copy}>
                  {copied ? (
                    <CheckIcon size={13} aria-hidden="true" />
                  ) : (
                    <CopyIcon size={13} aria-hidden="true" />
                  )}
                  {copied ? t('Copied') : t('Copy prompt')}
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
    </Scrim>
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
  const t = useT()
  if (items.length === 0) {
    return (
      <div className="empty">
        <span className="eyebrow">{t('Your creations')}</span>
        <h1>{t('Nothing here yet')}</h1>
        <p>
          Images, video, music and speech you generate are collected here, with what each one
          cost. Use the buttons under the message box to make something — or start from one of
          the prompts in the other tabs.
        </p>
        <p className="empty-fine">
          Most files are copied to our CDN and kept with no expiry. A few cannot be — an archive
          can fail, and speech arrives as raw bytes with no URL to copy — so every row says how
          long that one actually lasts. The list itself is kept in this browser, since there is no
          account to attach it to.
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
              {/* How long THIS row survives, per row rather than one blanket claim.
                  The page used to say "stored permanently" about everything, which is true of an
                  archived file and false of one whose archive failed — that URL is the provider's
                  own and expires within hours. Saying it per row is the only version that is
                  accurate, and the at-risk ones get a warning colour and a download link because
                  the note is useless if you cannot act on it. */}
              <RetentionLine item={item} />
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
