/**
 * What "Add from existing chats" offers a digital human: chats other digital
 * humans' bots know, one per bot chat — never one it already reaches, nor one
 * whose bot was removed.
 */

import { describe, expect, it } from 'vitest'
import { isLinkedTo, pushTargetCandidates } from '../../../src/renderer/components/apps/im-push-targets'
import type { ImChannelInstanceStatus, ImSessionRecord } from '../../../src/shared/types/im-channel'

function session(over: Partial<ImSessionRecord>): ImSessionRecord {
  return {
    appId: 'morning', channel: 'wecom-bot', source: 'im', instanceId: 'bot-1', chatId: 'g1', chatType: 'group',
    displayName: 'Group', proactive: false, lastActiveAt: 1, ...over,
  }
}

const bot = (id: string): ImChannelInstanceStatus =>
  ({ id, type: 'wecom-bot', enabled: true, connected: true, appId: 'morning', appName: 'Morning report' })

const keys = (sessions: ImSessionRecord[]) => sessions.map(s => `${s.appId}/${s.instanceId}:${s.chatId}`)

describe('chats a digital human may add as push targets', () => {
  it('offers other digital humans\' IM chats, most recent first', () => {
    const all = [
      session({ chatId: 'g1', lastActiveAt: 10 }),
      session({ chatId: 'alice', chatType: 'direct', lastActiveAt: 30 }),
      session({ appId: 'evening', instanceId: 'bot-2', chatId: 'g9', lastActiveAt: 20 }),
    ]
    expect(keys(pushTargetCandidates(all, 'weekly', [bot('bot-1'), bot('bot-2')]))).toEqual([
      'morning/bot-1:alice', 'evening/bot-2:g9', 'morning/bot-1:g1',
    ])
  })

  it('leaves out its own chats, non-IM sessions and chats whose bot was removed', () => {
    const all = [
      session({ appId: 'weekly', chatId: 'own' }),
      session({ channel: 'http', source: 'http', instanceId: '', chatId: 'api' }),
      session({ channel: 'local', source: 'local', instanceId: '', chatId: 'thread' }),
      session({ instanceId: 'bot-gone', chatId: 'orphan' }),
      session({ chatId: 'g1' }),
    ]
    expect(keys(pushTargetCandidates(all, 'weekly', [bot('bot-1')]))).toEqual(['morning/bot-1:g1'])
  })

  it('leaves out a bot chat it already reaches, linked or its own, through whichever record', () => {
    const all = [
      session({ chatId: 'linked', pushLinks: [{ appId: 'weekly', autoSync: false }] }),
      // The same bot chat as held by a digital human the bot answered for before.
      session({ appId: 'old-owner', chatId: 'linked' }),
      session({ appId: 'weekly', chatId: 'mine' }),
      session({ chatId: 'mine' }),
      session({ chatId: 'free' }),
    ]
    expect(keys(pushTargetCandidates(all, 'weekly', [bot('bot-1')]))).toEqual(['morning/bot-1:free'])
  })

  it('offers each bot chat once, as the record most recently active', () => {
    const all = [
      session({ appId: 'old-owner', chatId: 'g1', lastActiveAt: 5 }),
      session({ appId: 'morning', chatId: 'g1', lastActiveAt: 50 }),
    ]
    expect(keys(pushTargetCandidates(all, 'weekly', [bot('bot-1')]))).toEqual(['morning/bot-1:g1'])
  })

  it('tells a link of this digital human from one of another, and never counts its own session as linked', () => {
    const linked = session({ pushLinks: [{ appId: 'weekly', autoSync: true }] })
    expect(isLinkedTo(linked, 'weekly')).toBe(true)
    expect(isLinkedTo(linked, 'evening')).toBe(false)
    expect(isLinkedTo(session({ appId: 'weekly', pushLinks: [{ appId: 'weekly', autoSync: true }] }), 'weekly')).toBe(false)
  })
})
