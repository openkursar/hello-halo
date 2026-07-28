/**
 * Unit tests for the conversation-id key builders in shared/apps/im-keys.ts.
 *
 * These keys are the single source of truth for session isolation + event
 * routing across the renderer chat store, runtime, and IM channels. The critical
 * invariant is that the two app-chat key families never collide:
 *   - "app-chat:{appId}"                          native digital-human chat
 *   - "app-chat:{appId}:{channel}:{type}:{chatId}" IM session
 */

import { describe, it, expect } from 'vitest'
import {
  getAppChatConversationId,
  buildImSessionKey,
  buildLocalSessionKey,
  isImSessionKey,
  isLocalSessionKey,
  parseAppChatKey,
  resolveHttpConversationId,
} from '../../../src/shared/apps/im-keys'

describe('im-keys: family isolation (no cross-collision)', () => {
  it('an IM key is distinct from a native app-chat key', () => {
    const imKey = buildImSessionKey('app1', 'wecom-bot', 'direct', 'user-1')
    expect(imKey).toBe('app-chat:app1:wecom-bot:direct:user-1')
    expect(isImSessionKey(imKey)).toBe(true)
  })

  it('a native app-chat key is not an IM key', () => {
    const chatKey = getAppChatConversationId('app1')
    expect(chatKey).toBe('app-chat:app1')
    expect(isImSessionKey(chatKey)).toBe(false)
  })

  it('matches a 5-segment key with a known IM channel', () => {
    // group chat ids that themselves contain no colon
    expect(isImSessionKey('app-chat:a:feishu-bot:group:room')).toBe(true)
    // too few segments
    expect(isImSessionKey('app-chat:a:feishu-bot:group')).toBe(false)
  })

  it('classifies by channel value, not key shape: HTTP keys are NOT IM sessions', () => {
    // Same 5-segment shape as an IM key, but the http channel is not pushable.
    const httpKey = buildImSessionKey('app1', 'http', 'direct', 'user-42')
    expect(httpKey).toBe('app-chat:app1:http:direct:user-42')
    expect(isImSessionKey(httpKey)).toBe(false)
  })

  it('treats unknown channels as non-IM (conservative)', () => {
    expect(isImSessionKey('app-chat:app1:sms:direct:user-1')).toBe(false)
  })
})

describe('parseAppChatKey', () => {
  it('parses a channel-qualified key into its components', () => {
    expect(parseAppChatKey('app-chat:app1:wecom-bot:group:room-7')).toEqual({
      appId: 'app1',
      channel: 'wecom-bot',
      chatType: 'group',
      chatId: 'room-7',
    })
  })

  it('returns null for the native (2-segment) key', () => {
    expect(parseAppChatKey('app-chat:app1')).toBeNull()
  })

  it('returns null for non-app-chat or malformed keys', () => {
    expect(parseAppChatKey('conversation:123')).toBeNull()
    expect(parseAppChatKey('app-chat:app1:wecom-bot:group')).toBeNull()
    // invalid chatType segment
    expect(parseAppChatKey('app-chat:app1:wecom-bot:channel:room')).toBeNull()
  })
})

describe('resolveHttpConversationId (HTTP trust boundary)', () => {
  it('falls back to the native default for empty / non-string input', () => {
    expect(resolveHttpConversationId('app1', undefined)).toEqual({ ok: true, conversationId: 'app-chat:app1' })
    expect(resolveHttpConversationId('app1', '')).toEqual({ ok: true, conversationId: 'app-chat:app1' })
    expect(resolveHttpConversationId('app1', 123)).toEqual({ ok: true, conversationId: 'app-chat:app1' })
  })

  it('accepts the native default key as-is', () => {
    expect(resolveHttpConversationId('app1', 'app-chat:app1')).toEqual({ ok: true, conversationId: 'app-chat:app1' })
  })

  it('accepts a well-formed HTTP key', () => {
    const key = 'app-chat:app1:http:direct:user-42'
    expect(resolveHttpConversationId('app1', key)).toEqual({ ok: true, conversationId: key })
  })

  it('rejects a key for a different app', () => {
    const res = resolveHttpConversationId('app1', 'app-chat:app2:http:direct:user-1')
    expect(res.ok).toBe(false)
  })

  it('rejects IM-channel keys (HTTP must not address IM sessions)', () => {
    const res = resolveHttpConversationId('app1', 'app-chat:app1:wecom-bot:direct:user-1')
    expect(res.ok).toBe(false)
  })

  it('rejects chatIds with path-traversal / unsafe characters', () => {
    expect(resolveHttpConversationId('app1', 'app-chat:app1:http:direct:../../etc').ok).toBe(false)
    expect(resolveHttpConversationId('app1', 'app-chat:app1:http:direct:a/b').ok).toBe(false)
    // ':' in chatId breaks the 5-segment parse → rejected
    expect(resolveHttpConversationId('app1', 'app-chat:app1:http:direct:a:b').ok).toBe(false)
  })

  it('rejects overly long chatIds', () => {
    const longId = 'x'.repeat(129)
    expect(resolveHttpConversationId('app1', `app-chat:app1:http:direct:${longId}`).ok).toBe(false)
  })

  it('accepts a native local key (client multi-sessions are authenticated, non-IM)', () => {
    const key = buildLocalSessionKey('app1', 'a1b2c3d4')
    expect(key).toBe('app-chat:app1:local:direct:a1b2c3d4')
    expect(resolveHttpConversationId('app1', key)).toEqual({ ok: true, conversationId: key })
  })
})

describe('im-keys: native local sessions', () => {
  it('builds a 5-segment local key on the "local" channel', () => {
    expect(buildLocalSessionKey('app1', 'uuid-9')).toBe('app-chat:app1:local:direct:uuid-9')
  })

  it('recognizes a local key and distinguishes it from IM/native', () => {
    const localKey = buildLocalSessionKey('app1', 'uuid-9')
    expect(isLocalSessionKey(localKey)).toBe(true)
    // A local key is not an IM (pushable) session
    expect(isImSessionKey(localKey)).toBe(false)
    // The native default and IM keys are not local
    expect(isLocalSessionKey(getAppChatConversationId('app1'))).toBe(false)
    expect(isLocalSessionKey(buildImSessionKey('app1', 'wecom-bot', 'direct', 'u1'))).toBe(false)
  })

  it('parses a local key with the "local" channel and direct type', () => {
    expect(parseAppChatKey('app-chat:app1:local:direct:uuid-9')).toEqual({
      appId: 'app1',
      channel: 'local',
      chatType: 'direct',
      chatId: 'uuid-9',
    })
  })
})
