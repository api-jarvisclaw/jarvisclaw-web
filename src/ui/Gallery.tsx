import { galleryTotalUsd, type GalleryItem } from '../lib/gallery'

/**
 * Everything the user has generated and paid for.
 *
 * The empty state does real work here. A gallery that has never been used looks identical to one
 * that lost its index, so it says which is which — and it says the index is per-browser, because
 * with no account that is a real limitation someone will otherwise discover by losing a list.
 */
export function Gallery({
  items,
  onRemove,
}: {
  items: GalleryItem[]
  onRemove: (id: string) => void
}) {
  if (items.length === 0) {
    return (
      <div className="transcript">
        <div className="empty">
          <span className="eyebrow">Gallery</span>
          <h1>Nothing here yet</h1>
          <p>
            Images, video, music and speech you generate are stored permanently and collected
            here. Use the buttons under the message box to make something.
          </p>
          <p className="empty-fine">
            The list is kept in this browser, since there is no account to attach it to. The files
            themselves live on the CDN and stay put.
          </p>
        </div>
      </div>
    )
  }

  const total = galleryTotalUsd(items)

  return (
    <div className="transcript">
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
    </div>
  )
}
