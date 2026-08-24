import type { ChatMessage } from './gateway'
import type { Turn } from '../ui/Transcript'

/**
 * Conversation list, persisted in localStorage.
 *
 * What is stored: the visible turns and the model's own message history, which is what
 * makes reopening a conversation resume it rather than replay a transcript the model
 * cannot see.
 *
 * What is NOT stored: the API key. It stays in component state for the tab's lifetime.
 * A key persisted here would outlive the session on a shared machine, and a key is enough
 * to mint more keys and read the account.
 *
 * Every access is wrapped: localStorage throws outright in some contexts (private mode
 * with site data blocked, embedded webviews), and a console that cannot save history must
 * still be a console.
 */

const KEY = 'jarvisclaw.conversations.v1'
const MAX_CONVERSATIONS = 50

export interface Conversation {
  id: string
  title: string
  /** Epoch ms. Used for ordering and for the relative age in the list. */
  updatedAt: number
  turns: Turn[]
  history: ChatMessage[]
}

export function newId(): string {
  // crypto.randomUUID is unavailable on some older mobile browsers, and an id collision
  // would silently overwrite someone's conversation.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * A conversation's name, taken from its first human message.
 *
 * Deliberately not model-generated: naming a chat is not worth a paid call, and on the
 * free tier it would be one more thing that can fail before the user sees their own words.
 */
export function deriveTitle(turns: Turn[]): string {
  const first = turns.find((t) => t.kind === 'user')
  const text = first && first.kind === 'user' ? first.text.trim() : ''
  if (text === '') return 'New chat'
  const oneLine = text.replace(/\s+/g, ' ')
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Filtered rather than trusted: this is data a previous version of the app wrote, and
    // one malformed row must not blank the whole list.
    return parsed.filter(isConversation).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function isConversation(v: unknown): v is Conversation {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Partial<Conversation>
  return (
    typeof c.id === 'string' &&
    typeof c.title === 'string' &&
    typeof c.updatedAt === 'number' &&
    Array.isArray(c.turns) &&
    Array.isArray(c.history)
  )
}

export function saveConversations(list: Conversation[]): void {
  try {
    // Trimmed before writing: localStorage is a few MB, and a transcript with tool output
    // is not small. Dropping the oldest is better than a quota error that loses the lot.
    const trimmed = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS)
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch {
    // A full or unavailable store is not worth interrupting a working conversation over.
  }
}

export function upsert(list: Conversation[], conv: Conversation): Conversation[] {
  const next = list.filter((c) => c.id !== conv.id)
  next.unshift(conv)
  return next
}

export function remove(list: Conversation[], id: string): Conversation[] {
  return list.filter((c) => c.id !== id)
}

/** Case-insensitive search over titles and the text of every turn. */
export function search(list: Conversation[], query: string): Conversation[] {
  const q = query.trim().toLowerCase()
  if (q === '') return list
  return list.filter((c) => {
    if (c.title.toLowerCase().includes(q)) return true
    return c.turns.some((t) => 'text' in t && typeof t.text === 'string' && t.text.toLowerCase().includes(q))
  })
}

/** "just now" / "3m" / "2h" / "5d" — short enough for a sidebar row. */
export function relativeAge(ms: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ms) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.round(days / 30)
  return `${months}mo`
}
