/**
 * A digital human can push to a chat another digital human's bot knows, once
 * the user adds it from its settings. The link lives on that bot's session:
 * it puts the chat in the digital human's notify_bot directory (and, with
 * auto-sync, among its run-result targets) without touching the session's own
 * digital human, and it goes when the session goes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'

const GROUP = { appId: 'morning', channel: 'wecom-bot', chatId: 'wrkGroup1' }

let dir: string
let file: string
let reg: ImSessionRegistry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'im-push-links-'))
  file = join(dir, 'sessions.json')
  reg = new ImSessionRegistry(file)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // The morning digital human's bot knows a group and a person.
  reg.register('morning', 'wecom-bot', 'wrkGroup1', 'group', 'bot-1', { displayName: 'Product weekly' })
  reg.register('morning', 'wecom-bot', 'alice', 'direct', 'bot-1')
})

afterEach(async () => {
  // Writes are fire-and-forget; let them land before the folder goes.
  await new Promise(resolve => setTimeout(resolve, 20))
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const routes = (sessions: Array<{ instanceId: string; chatId: string }>) => sessions.map(s => `${s.instanceId}:${s.chatId}`)

describe('adding another bot\'s chat as a push target', () => {
  it('puts the chat in the digital human\'s directory, as its own digital human holds it', () => {
    expect(reg.getPushableSessions('weekly')).toEqual([])
    expect(reg.setPushLink('weekly', GROUP, { autoSync: false })).toBe(true)

    const pushable = reg.getPushableSessions('weekly')
    expect(routes(pushable)).toEqual(['bot-1:wrkGroup1'])
    expect(pushable[0]).toMatchObject({ appId: 'morning', chatType: 'group', displayName: 'Product weekly' })
    expect(routes(reg.getLinkedSessions('weekly'))).toEqual(['bot-1:wrkGroup1'])
    // The session's own digital human reaches exactly what it did.
    expect(routes(reg.getPushableSessions('morning')).sort()).toEqual(['bot-1:alice', 'bot-1:wrkGroup1'])
    expect(reg.getLinkedSessions('morning')).toEqual([])
  })

  it('auto-syncs run results there only when that link asks for it, apart from the owner\'s own choice', () => {
    reg.setProactive('morning', 'wecom-bot', 'wrkGroup1', true)
    reg.setPushLink('weekly', GROUP, { autoSync: false })
    expect(reg.getProactiveSessions('weekly')).toEqual([])
    expect(routes(reg.getProactiveSessions('morning'))).toEqual(['bot-1:wrkGroup1'])

    reg.setPushLink('weekly', GROUP, { autoSync: true })
    reg.setProactive('morning', 'wecom-bot', 'wrkGroup1', false)
    expect(routes(reg.getProactiveSessions('weekly'))).toEqual(['bot-1:wrkGroup1'])
    expect(reg.getProactiveSessions('morning')).toEqual([])
    // Updating keeps one link per digital human.
    expect(reg.findSession('morning', 'wecom-bot', 'wrkGroup1')?.pushLinks).toEqual([{ appId: 'weekly', autoSync: true }])
  })

  it('refuses a session that does not exist, is not an IM chat, or is the digital human\'s own', () => {
    reg.register('morning', 'http', 'api-user', 'direct', '')
    expect(reg.setPushLink('weekly', { ...GROUP, chatId: 'nobody' }, { autoSync: false })).toBe(false)
    expect(reg.setPushLink('weekly', { appId: 'morning', channel: 'http', chatId: 'api-user' }, { autoSync: false })).toBe(false)
    expect(reg.setPushLink('morning', GROUP, { autoSync: true })).toBe(false)
    expect(reg.findSession('morning', 'wecom-bot', 'wrkGroup1')?.pushLinks).toBeUndefined()
  })

  it('lists a bot chat it also reaches on its own once, as its own', () => {
    // After the bot is moved to the weekly digital human, the same chat registers under it too.
    reg.setPushLink('weekly', GROUP, { autoSync: true })
    reg.register('weekly', 'wecom-bot', 'wrkGroup1', 'group', 'bot-1')
    const pushable = reg.getPushableSessions('weekly')
    expect(pushable).toHaveLength(1)
    expect(pushable[0].appId).toBe('weekly')
    // Its own choice decides auto-sync there.
    expect(reg.getProactiveSessions('weekly')).toEqual([])
  })

  it('keeps the link while the chat keeps talking to its own digital human', () => {
    reg.setPushLink('weekly', GROUP, { autoSync: true })
    reg.register('morning', 'wecom-bot', 'wrkGroup1', 'group', 'bot-1', { lastMessage: 'see you monday' })
    expect(routes(reg.getPushableSessions('weekly'))).toEqual(['bot-1:wrkGroup1'])
  })
})

describe('when the link stops applying', () => {
  it('is removed on request, leaving the session as it was', () => {
    reg.setPushLink('weekly', GROUP, { autoSync: true })
    expect(reg.setPushLink('weekly', GROUP, null)).toBe(true)
    expect(reg.getPushableSessions('weekly')).toEqual([])
    expect(reg.findSession('morning', 'wecom-bot', 'wrkGroup1')?.pushLinks).toBeUndefined()
    expect(routes(reg.getPushableSessions('morning')).sort()).toEqual(['bot-1:alice', 'bot-1:wrkGroup1'])
  })

  it('goes with the session: a removed chat leaves nothing behind, even when it registers again', () => {
    reg.setPushLink('weekly', GROUP, { autoSync: true })
    reg.removeSession('morning', 'wecom-bot', 'wrkGroup1')
    expect(reg.getPushableSessions('weekly')).toEqual([])
    reg.register('morning', 'wecom-bot', 'wrkGroup1', 'group', 'bot-1')
    expect(reg.getLinkedSessions('weekly')).toEqual([])
  })

  it('goes with either digital human when it is removed', () => {
    reg.setPushLink('weekly', GROUP, { autoSync: true })
    reg.setPushLink('evening', GROUP, { autoSync: false })
    reg.removeAllForApp('weekly')
    expect(reg.findSession('morning', 'wecom-bot', 'wrkGroup1')?.pushLinks).toEqual([{ appId: 'evening', autoSync: false }])
    reg.removeAllForApp('morning')
    expect(reg.getPushableSessions('evening')).toEqual([])
  })
})

describe('on disk', () => {
  it('survives a restart', async () => {
    reg.setPushLink('weekly', GROUP, { autoSync: true })
    await vi.waitFor(() => expect(readFileSync(file, 'utf8')).toContain('"pushLinks"'))
    const reloaded = new ImSessionRegistry(file)
    expect(routes(reloaded.getProactiveSessions('weekly'))).toEqual(['bot-1:wrkGroup1'])
  })

  it('reads only well-formed links: one per digital human, never the session\'s own, never on a non-IM session', () => {
    const base = { channel: 'wecom-bot', instanceId: 'bot-1', chatType: 'group', displayName: 'x', proactive: false, lastActiveAt: 1, source: 'im' }
    writeFileSync(file, JSON.stringify([
      {
        ...base, appId: 'morning', chatId: 'g1',
        pushLinks: [{ appId: 'weekly', autoSync: true }, { appId: 'weekly', autoSync: false }, { appId: 'morning', autoSync: true }, { autoSync: true }, null, { appId: 'evening' }],
      },
      { ...base, appId: 'morning', channel: 'http', source: 'http', chatId: 'api', pushLinks: [{ appId: 'weekly', autoSync: true }] },
      { ...base, appId: 'morning', chatId: 'g2', pushLinks: 'not a list' },
    ]))
    const loaded = new ImSessionRegistry(file)
    expect(loaded.findSession('morning', 'wecom-bot', 'g1')?.pushLinks).toEqual([
      { appId: 'weekly', autoSync: false },
      { appId: 'evening', autoSync: false },
    ])
    expect(loaded.findSession('morning', 'http', 'api')?.pushLinks).toBeUndefined()
    expect(loaded.findSession('morning', 'wecom-bot', 'g2')?.pushLinks).toBeUndefined()
    expect(routes(loaded.getPushableSessions('weekly'))).toEqual(['bot-1:g1'])
  })
})
