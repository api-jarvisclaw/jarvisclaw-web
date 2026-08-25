import {
  BookOpenIcon,
  LayoutGridIcon,
  PlusIcon,
  SearchIcon,
  StoreIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { relativeAge, search, type Conversation } from '../lib/conversations'

/**
 * The left rail: new chat, search, navigation, and the conversation list.
 *
 * The list is the reason this exists. Without it every reload threw the session away, and
 * a console you cannot come back to is a demo rather than a product.
 */
export type RailView = 'chat' | 'marketplace' | 'gallery'

/**
 * True when a conversation holds a paid generation that has not produced its media yet.
 *
 * Exported for its own test. This is the only indication anywhere on the page that money is out
 * and a result is still coming, once the user has moved to another chat — and moving away during
 * a four-minute video is the normal thing to do.
 *
 * A turn with a url or b64 is finished even if the job field survived, so both are checked: the
 * marker has to disappear when the media lands, or it becomes a permanent decoration that says
 * nothing.
 */
export function hasPendingMedia(conv: Conversation): boolean {
  return conv.turns.some(
    (t) => t.kind === 'media' && t.job !== undefined && !t.url && !t.b64 && !t.failed,
  )
}

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
        <PlusIcon className="rail-glyph" size={16} aria-hidden="true" />
        New chat
      </button>

      <button
        className="rail-item"
        onClick={() => setSearching((s) => !s)}
        aria-expanded={searching}
      >
        <SearchIcon className="rail-glyph" size={16} aria-hidden="true" />
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
        <StoreIcon className="rail-glyph" size={16} aria-hidden="true" />
        Marketplace
      </button>

      <button
        className={view === 'gallery' ? 'rail-item rail-item-active' : 'rail-item'}
        onClick={() => onView('gallery')}
      >
        <LayoutGridIcon className="rail-glyph" size={16} aria-hidden="true" />
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
        <TerminalIcon className="rail-glyph" size={16} aria-hidden="true" />
        Install CLI
      </a>

      <a
        className="rail-item"
        href="https://docs.jarvisclaw.ai"
        target="_blank"
        rel="noopener noreferrer"
      >
        <BookOpenIcon className="rail-glyph" size={16} aria-hidden="true" />
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
                {/* A dot when this conversation is still waiting on paid media.
                    A generation takes minutes and its transcript may not be the one on screen,
                    so without a marker in the list there is nothing anywhere on the page saying
                    money is out and a result is coming. */}
                {hasPendingMedia(c) && (
                  <span
                    className="rail-row-pending"
                    title="A generation is still running in this chat"
                    aria-label="generating"
                  />
                )}
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
                <XIcon size={14} aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </div>
    </nav>
  )
}
