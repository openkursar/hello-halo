/**
 * `resolveHttpConversationId` is what stops an HTTP caller from addressing a
 * digital human's IM conversations. It predates the self-API, which inherits
 * it by reusing the same handlers — so these cases exist to make the guarantee
 * explicit and to fail loudly if someone relaxes it to make a self-API call
 * more convenient. Same tier as the two token-isolation cases.
 */

import { describe, it, expect } from 'vitest'
import { resolveHttpConversationId } from '../../../src/shared/apps/im-keys'

const APP = 'app-1'

describe('resolveHttpConversationId', () => {
  it('falls back to the app\'s own chat when nothing is named', () => {
    const res = resolveHttpConversationId(APP, undefined)
    expect(res.ok).toBe(true)
  })

  it('refuses to address a real IM conversation over HTTP', () => {
    for (const channel of ['wecom', 'weixin', 'feishu', 'dingtalk']) {
      const res = resolveHttpConversationId(APP, `app-chat:${APP}:${channel}:direct:someone`)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/only address the "http" or "local" channel/)
    }
  })

  it('accepts the two channels that are addressable', () => {
    for (const channel of ['http', 'local']) {
      expect(resolveHttpConversationId(APP, `app-chat:${APP}:${channel}:direct:abc_1`).ok).toBe(true)
    }
  })

  it('refuses a chatId that could escape the file it is written into', () => {
    for (const chatId of ['../../etc/passwd', 'a/b', 'a\\b', 'a b', 'a'.repeat(129)]) {
      const res = resolveHttpConversationId(APP, `app-chat:${APP}:http:direct:${chatId}`)
      expect(res.ok).toBe(false)
    }
  })

  it('refuses a conversation belonging to a different app', () => {
    const res = resolveHttpConversationId(APP, 'app-chat:other-app:http:direct:abc')
    expect(res.ok).toBe(false)
  })
})
