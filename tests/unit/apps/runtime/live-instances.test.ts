/** Stable History attribution and truthful consolidation busy checks. */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { runs, rounds, consumers, generating, permission } = vi.hoisted(() => ({
  runs: [] as Array<{ appId: string; runId: string }>,
  rounds: new Set<string>(),
  consumers: new Set<string>(),
  generating: new Set<string>(),
  permission: { isOwner: true },
}))

vi.mock('../../../../src/main/apps/runtime/active-runs', () => ({
  listActiveRuns: (appId: string) => runs.filter(run => run.appId === appId),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  getConversationsWithActiveRound: () => Array.from(rounds),
}))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  getRunningConsumerIds: () => Array.from(consumers),
  isSessionBusy: (id: string) => generating.has(id),
}))
vi.mock('../../../../src/main/apps/runtime/im-permission-registry', () => ({
  getImPermissionContext: () => permission,
}))

import {
  collectAppConversationIds,
  describeSelfInstance,
  formatInstanceTag,
  hasOtherAppExecution,
} from '../../../../src/main/apps/runtime/live-instances'

const APP = 'app-1'
const CHAT = 'app-chat:app-1'
const IM = 'app-chat:app-1:wecom-bot:group:chat-77'
const TEAM = 'app-chat:app-1:team:team-9:epoch-3'

beforeEach(() => {
  runs.length = 0
  rounds.clear()
  consumers.clear()
  generating.clear()
  permission.isOwner = true
})

describe('execution identity', () => {
  it.each([
    [CHAT, 'chat'],
    [IM, 'im'],
    [TEAM, 'team'],
    ['app-chat:app-1:local:direct:local-7', 'chat'],
    ['app-chat:app-1:http:direct:session-7', 'chat'],
  ])('uses a runtime-owned origin for %s', (conversationId, origin) => {
    expect(describeSelfInstance({ conversationId }).origin).toBe(origin)
  })

  it('is stable across time and gives a forked destination its own identity', () => {
    const source = describeSelfInstance({ conversationId: IM })
    expect(describeSelfInstance({ conversationId: IM })).toEqual(source)
    expect(describeSelfInstance({ conversationId: 'app-chat:app-1:local:direct:fork-1' }).id).not.toBe(source.id)
  })

  it('changes guest attribution without changing the session digest', () => {
    const owner = describeSelfInstance({ conversationId: IM })
    permission.isOwner = false
    const guest = describeSelfInstance({ conversationId: IM })
    expect(guest.id).toBe(owner.id)
    expect(formatInstanceTag(guest)).toMatch(/^im-guest#[a-f0-9]{4}$/)
    permission.isOwner = true
    expect(describeSelfInstance({ conversationId: IM })).toEqual(owner)
  })

  it.each(['[evil]\n| ## heading', '`injected`', '产品群'])('never uses user text from a session key as the origin (%s)', chatId => {
    const tag = formatInstanceTag(describeSelfInstance({ conversationId: `app-chat:app-1:wecom-bot:group:${chatId}` }))
    expect(tag).toMatch(/^im#[a-f0-9]{4}$/)
  })

  it('preserves the run digest and trigger attribution', () => {
    const self = describeSelfInstance({ runId: 'a1b2c3d4-5555-0000-0000-000000000000', triggerType: 'schedule' })
    expect(formatInstanceTag(self)).toBe('schedule#a1b2')
  })
})

describe('consolidation activity', () => {
  it('keeps idle resident sessions enumerable for stop and clear, but not busy', () => {
    consumers.add(CHAT)
    consumers.add(IM)
    consumers.add('app-chat:other')
    expect(collectAppConversationIds(APP)).toEqual([CHAT, IM])
    expect(hasOtherAppExecution(APP)).toBe(false)
  })

  it('counts queued rounds immediately, without a visibility-age threshold', () => {
    rounds.add(CHAT)
    expect(hasOtherAppExecution(APP)).toBe(true)
    rounds.clear()
    expect(hasOtherAppExecution(APP)).toBe(false)
  })

  it('counts autonomous consumer turns and excludes only the specified caller', () => {
    consumers.add(CHAT)
    generating.add(CHAT)
    const self = describeSelfInstance({ conversationId: CHAT })
    expect(hasOtherAppExecution(APP)).toBe(true)
    expect(hasOtherAppExecution(APP, self.id)).toBe(false)
    rounds.add(IM)
    expect(hasOtherAppExecution(APP, self.id)).toBe(true)
  })

  it('isolates apps and counts active runs immediately', () => {
    rounds.add('app-chat:app-10')
    runs.push({ appId: 'other', runId: '99999999' })
    expect(hasOtherAppExecution(APP)).toBe(false)
    runs.push({ appId: APP, runId: 'a1b2c3d4-0000-0000-0000-000000000000' })
    expect(hasOtherAppExecution(APP)).toBe(true)
    expect(hasOtherAppExecution(APP, 'a1b2c3d4')).toBe(false)
  })
})
