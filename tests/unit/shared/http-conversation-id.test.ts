/**
 * The shape checks on what an HTTP caller names a digital human's conversation
 * by. `resolveHttpConversationId` stops the chat routes from sending into a
 * digital human's IM conversations; `resolveHttpImChat` holds the im-chat
 * routes (read, stop, clear an IM session) to a channel that is an IM channel
 * and a chat id that keeps the session key and its transcript file where they
 * belong. Both predate the self-API, which inherits them by reusing the same
 * handlers — so these cases exist to make the guarantee explicit and to fail
 * loudly if someone relaxes it to make a self-API call more convenient. Same
 * tier as the two token-isolation cases.
 */

import { describe, it, expect } from 'vitest'
import { resolveHttpConversationId, resolveHttpImChat } from '../../../src/shared/apps/im-keys'

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
      if (!res.ok) expect(res.error).toMatch(/only address the "http", "local" or "team" channel/)
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

describe('resolveHttpImChat', () => {
  it('accepts every IM channel with chat ids the platforms really use', () => {
    const ids = ['wrkSFfCgAAc7b0cc', 'zhang.san@example', 'o9cq80Abc-d_E@im.wechat', 'oc_5ad11d72b830411d72b836c20', 'cidAbC+dE9==']
    for (const channel of ['wecom-bot', 'feishu-bot', 'dingtalk-bot', 'weixin-ilink-bot']) {
      for (const chatId of ids) {
        expect(resolveHttpImChat(channel, 'group', chatId), `${channel} ${chatId}`).toEqual({ ok: true, channel, chatType: 'group', chatId })
      }
    }
  })

  it('reads a missing chat type as a direct chat, and refuses any other value', () => {
    expect(resolveHttpImChat('wecom-bot', undefined, 'u1')).toMatchObject({ ok: true, chatType: 'direct' })
    expect(resolveHttpImChat('wecom-bot', 'direct', 'u1')).toMatchObject({ ok: true, chatType: 'direct' })
    for (const chatType of ['', 'GROUP', 'channel', 1]) {
      expect(resolveHttpImChat('wecom-bot', chatType, 'u1'), String(chatType)).toEqual({ ok: false, error: 'Invalid chatType: expected "direct" or "group"' })
    }
  })

  it('refuses a channel that is not an IM channel, pointing "http" and "local" sessions at the chat routes', () => {
    for (const channel of ['http', 'local', 'native', 'team', 'wecom', 'WECOM-BOT', '', undefined, ['wecom-bot']]) {
      const res = resolveHttpImChat(channel, 'direct', 'u1')
      expect(res.ok, String(channel)).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/^Invalid channel: expected one of wecom-bot, feishu-bot, dingtalk-bot, weixin-ilink-bot;/)
    }
  })

  it('refuses a chat id that would change the session key or reach out of its transcript folder', () => {
    for (const chatId of ['', 'a:b', 'a/b', 'a\\b', '../x', '..', 'a..b', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007fb', 'x'.repeat(257), 7, undefined]) {
      expect(resolveHttpImChat('feishu-bot', 'direct', chatId), JSON.stringify(chatId)).toEqual({
        ok: false,
        error: 'Invalid chatId: 1-256 characters, without whitespace, ":", "/", "\\" or ".."',
      })
    }
    expect(resolveHttpImChat('feishu-bot', 'direct', 'x'.repeat(256)).ok).toBe(true)
  })
})
