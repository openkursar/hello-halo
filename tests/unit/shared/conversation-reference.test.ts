/**
 * The handle a `[#Title](conv:<ref>)` reference carries. The composer (renderer)
 * writes it and the resolver (main) matches it, so both sides must derive the
 * very same handle from the same conversation id.
 */

import { describe, it, expect } from 'vitest'
import { createHash, randomUUID } from 'crypto'
import {
  CHAT_TITLE_PREVIEW_CHARS,
  digitalHumanChatTitle,
  formatConversationReference,
  isShortConversationId,
  normalizeConversationTarget,
  shortConversationId,
} from '../../../src/shared/conversation-reference'
import { buildLocalSessionKey, getAppChatConversationId } from '../../../src/shared/apps/im-keys'

const sha1Prefix = (value: string): string => createHash('sha1').update(value).digest('hex').slice(0, 8)

describe('shortConversationId', () => {
  it('keeps the first eight hex digits of a space conversation uuid', () => {
    expect(shortConversationId('3a5d77ea-1c2b-4f7e-9d10-0123456789ab')).toBe('3a5d77ea')
  })

  it('digests a digital-human conversation key with SHA-1 (first eight hex digits)', () => {
    const keys = [
      getAppChatConversationId('app-1'),
      getAppChatConversationId('a-much-longer-app-id-that-exceeds-any-prefix'),
      buildLocalSessionKey('app-1', randomUUID()),
      buildLocalSessionKey('app-2', 'ünïcode-session'),
    ]
    for (const key of keys) expect(shortConversationId(key)).toBe(sha1Prefix(key))
  })

  it('agrees with node crypto across message lengths that cross SHA-1 block boundaries', () => {
    for (const length of [0, 1, 54, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
      const key = `app-chat:${'x'.repeat(length)}`
      expect(shortConversationId(key)).toBe(sha1Prefix(key))
    }
  })

  it('gives different digital-human conversations different handles', () => {
    expect(shortConversationId(getAppChatConversationId('app-1'))).not.toBe(shortConversationId(getAppChatConversationId('app-2')))
  })

  it('always yields a handle the resolver treats as a short id', () => {
    expect(isShortConversationId(shortConversationId(buildLocalSessionKey('app-1', 'abc')))).toBe(true)
    expect(isShortConversationId(shortConversationId(randomUUID()))).toBe(true)
  })
})

describe('reference text', () => {
  it('formats and normalizes a digital-human reference like any other', () => {
    const key = buildLocalSessionKey('app-1', 'sess-1')
    const text = formatConversationReference('Research helper', key)
    expect(text).toBe(`[#Research helper](conv:${sha1Prefix(key)})`)
    expect(normalizeConversationTarget(`conv:${sha1Prefix(key)}`)).toBe(sha1Prefix(key))
  })
})

describe('digitalHumanChatTitle', () => {
  const chat = { name: 'Analyst', isDefault: false }

  it('is the digital human\'s name for its default session', () => {
    expect(digitalHumanChatTitle({ ...chat, isDefault: true, customName: 'ignored', lastMessage: 'ignored' }, 'New chat')).toBe('Analyst')
  })

  it('prefers a custom name, then a display name, then the first message, then the stand-in', () => {
    expect(digitalHumanChatTitle({ ...chat, customName: 'Q3', displayName: 'D', lastMessage: 'M' }, 'New chat')).toBe('Analyst: Q3')
    expect(digitalHumanChatTitle({ ...chat, displayName: ' D ', lastMessage: 'M' }, 'New chat')).toBe('Analyst: D')
    expect(digitalHumanChatTitle({ ...chat, displayName: '  ', lastMessage: 'M' }, 'New chat')).toBe('Analyst: M')
    expect(digitalHumanChatTitle({ ...chat, displayName: '' }, 'Neuer Chat')).toBe('Analyst: Neuer Chat')
  })

  it('cuts a long first message to the preview length', () => {
    const title = digitalHumanChatTitle({ ...chat, lastMessage: 'x'.repeat(CHAT_TITLE_PREVIEW_CHARS + 30) }, 'New chat')
    expect(title).toBe(`Analyst: ${'x'.repeat(CHAT_TITLE_PREVIEW_CHARS)}`)
  })
})
