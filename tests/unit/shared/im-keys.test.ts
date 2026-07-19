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
  isImSessionKey,
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

  it('isImSessionKey requires exactly 5 colon-separated segments', () => {
    // group chat ids that themselves contain no colon
    expect(isImSessionKey('app-chat:a:feishu:group:room')).toBe(true)
    // too few segments
    expect(isImSessionKey('app-chat:a:feishu:group')).toBe(false)
  })
})
