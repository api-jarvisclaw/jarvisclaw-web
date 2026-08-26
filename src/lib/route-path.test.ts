import { describe, expect, it } from 'vitest'

import { CONSOLE_PATH, LANDING_PATH, pageFor } from './route-path'

/**
 * Which page a URL names.
 *
 * Small enough to look not worth testing, and it decides what a visitor sees on a shared link. The
 * failure that matters is a path resolving to the console when it should be the landing page or
 * vice versa — both look like the app ignoring the address bar.
 */
describe('pageFor', () => {
  it('sends the root to the landing page', () => {
    expect(pageFor('/')).toBe('landing')
  })

  it('sends /chat to the console, with or without the trailing slash', () => {
    // Both, because a link typed by hand or produced by a tool that normalises URLs will have one
    // or the other, and landing on marketing copy from `/chat/` would look broken.
    expect(pageFor('/chat')).toBe('console')
    expect(pageFor('/chat/')).toBe('console')
  })

  it('falls back to the landing page for anything unknown', () => {
    // The Worker serves index.html for every unknown path, so a typo already arrives here. Showing
    // the landing page is the useful answer; a blank screen is not.
    expect(pageFor('/nonsense')).toBe('landing')
    expect(pageFor('/chatt')).toBe('landing')
    expect(pageFor('/en/chat')).toBe('landing')
  })

  it('does not match the console by prefix', () => {
    // `/chat-export` must not open the console. An allowlist rather than a startsWith is what
    // prevents a future real route being swallowed by this one.
    expect(pageFor('/chat-export')).toBe('landing')
    expect(pageFor('/chatroom')).toBe('landing')
  })

  it('exports the paths it matches, so callers cannot drift from it', () => {
    // navigate(CONSOLE_PATH) has to land on a path pageFor agrees is the console. Hardcoding '/chat'
    // at the call site would silently break the moment this file changed.
    expect(pageFor(CONSOLE_PATH)).toBe('console')
    expect(pageFor(LANDING_PATH)).toBe('landing')
  })
})
