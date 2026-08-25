import { describe, expect, it } from 'vitest'

import type { Conversation } from '../lib/conversations'
import type { Turn } from './Transcript'
import { hasPendingMedia } from './ChatList'

/**
 * The dot in the conversation list, which is the only sign anywhere on the page that money is out
 * and a result is still coming once the user has opened a different chat. Moving away during a
 * four-minute video is the normal thing to do, so this marker is what stops a paid job becoming
 * invisible.
 *
 * The failure to guard against is not a missing dot but a PERMANENT one: a marker that never
 * clears is a decoration, and after the first time it lies the user stops reading it.
 */

function conv(turns: Turn[]): Conversation {
  return { id: 'c1', title: 't', updatedAt: 1, turns, history: [] }
}

const JOB = { id: 'j1', pollUrl: '/v1/videos/generations/j1' }

function media(over: Partial<Extract<Turn, { kind: 'media' }>> = {}): Turn {
  return {
    kind: 'media',
    id: 'm1',
    media: 'video',
    prompt: 'a cat',
    model: 'bytedance/seedance-2.0-mini',
    spentUsd: 0.4,
    ...over,
  }
}

describe('hasPendingMedia', () => {
  it('marks a conversation whose generation is still running', () => {
    expect(hasPendingMedia(conv([media({ job: JOB })]))).toBe(true)
  })

  it('clears once the media arrives, even if the job field survived', () => {
    // Both are checked because the two are set by different code paths. A turn that has its url
    // is finished whatever else is on it, and a dot that outlives the result is a dot nobody
    // believes the next time.
    expect(hasPendingMedia(conv([media({ job: JOB, url: 'https://cdn/v.mp4' })]))).toBe(false)
    expect(hasPendingMedia(conv([media({ job: JOB, b64: 'QUJD' })]))).toBe(false)
  })

  it('clears when the generation failed', () => {
    // A failure is settled. Showing "still running" for something the provider rejected would
    // have the user waiting for media that is never coming.
    expect(
      hasPendingMedia(
        conv([media({ job: JOB, failed: { message: 'rejected by a filter', retryable: false } })]),
      ),
    ).toBe(false)
  })

  it('stays true while the client has given up but the job has not', () => {
    // `timedOut` means this page stopped polling, not that the job stopped. The gateway allows
    // itself 900s upstream and keeps the result for 24h, so the media is very likely still
    // coming and the conversation must keep saying so.
    expect(hasPendingMedia(conv([media({ job: JOB, timedOut: true })]))).toBe(true)
  })

  it('ignores conversations with no media at all', () => {
    expect(hasPendingMedia(conv([{ kind: 'user', text: 'hello' }]))).toBe(false)
    expect(hasPendingMedia(conv([]))).toBe(false)
  })

  it('finds a pending turn that is not the last one', () => {
    // The composer is free during a wait, so more turns land after the media one. Checking only
    // the tail would lose the dot the moment the user typed anything.
    expect(
      hasPendingMedia(
        conv([media({ job: JOB }), { kind: 'user', text: 'meanwhile…' }, { kind: 'agent', text: 'ok', reasoning: '', steps: [] }]),
      ),
    ).toBe(true)
  })
})
