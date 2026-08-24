import { useMemo, useState } from 'react'

import { relativeAge, search, type Conversation } from '../lib/conversations'

/**
 * The left rail: new chat, search, navigation, and the conversation list.
 *
 * The list is the reason this exists. Without it every reload threw the session away, and
 * a console you cannot come back to is a demo rather than a product.
 */
export type RailView = 'chat' | 'marketplace' | 'gallery'

export function ChatList({
  conversations,
  activeId,
  view,
  galleryCount,
  onNew,
  onOpen,
  onDelete,
  onView,
}: {
  conversations: Conversation[]
  activeId: string | null
  view: RailView
  galleryCount: number
  onNew: () => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onView: (v: RailView) => void
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)

  const shown = useMemo(() => search(conversations, query), [conversations, query])

  return (
    <nav className="rail">
      <div className="rail-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="rail-brand-name">JarvisClaw</span>
      </div>

      <button className="rail-item rail-item-strong" onClick={onNew}>
        <span className="rail-glyph" aria-hidden="true">
          +
        </span>
        New chat
      </button>

      <button
        className="rail-item"
        onClick={() => setSearching((s) => !s)}
        aria-expanded={searching}
      >
        <span className="rail-glyph" aria-hidden="true">
          ⌕
        </span>
        Search chats
      </button>

      {searching && (
        <input
          className="rail-search"
          type="search"
          value={query}
          placeholder="search your chats"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      <button
        className={view === 'marketplace' ? 'rail-item rail-item-active' : 'rail-item'}
        onClick={() => onView('marketplace')}
      >
        <span className="rail-glyph" aria-hidden="true">
          ▤
        </span>
        Marketplace
      </button>

      <button
        className={view === 'gallery' ? 'rail-item rail-item-active' : 'rail-item'}
        onClick={() => onView('gallery')}
      >
        <span className="rail-glyph" aria-hidden="true">
          ▩
        </span>
        Gallery
        {/* Counted in the rail because the gallery is the only view whose contents cost money
            to produce — knowing something is in there is worth a glance. */}
        {galleryCount > 0 && <span className="rail-count">{galleryCount}</span>}
      </button>

      {/* An external link, not a route: the CLI lives on npm and the docs are their own
          site. Rendered as a real anchor so it behaves like one. */}
      <a
        className="rail-item"
        href="https://www.npmjs.com/package/jarvisclaw"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="rail-glyph" aria-hidden="true">
          ❯_
        </span>
        Install CLI
      </a>

      <a
        className="rail-item"
        href="https://docs.jarvisclaw.ai"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="rail-glyph" aria-hidden="true">
          ◈
        </span>
        Docs
      </a>

      <div className="rail-list">
        {conversations.length === 0 ? (
          <p className="rail-empty">No conversations yet.</p>
        ) : shown.length === 0 ? (
          <p className="rail-empty">Nothing matches “{query}”.</p>
        ) : (
          shown.map((c) => (
            <div
              key={c.id}
              className={c.id === activeId && view === 'chat' ? 'rail-row rail-row-active' : 'rail-row'}
            >
              <button className="rail-row-open" onClick={() => onOpen(c.id)} title={c.title}>
                <span className="rail-row-title">{c.title}</span>
                <span className="rail-row-age">{relativeAge(c.updatedAt)}</span>
              </button>
              {/* Labelled per row: a bare "×" in a list of twenty tells a screen reader
                  nothing about which conversation it would delete. */}
              <button
                className="rail-row-del"
                onClick={() => onDelete(c.id)}
                aria-label={`Delete ${c.title}`}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </nav>
  )
}
