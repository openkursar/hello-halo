/**
 * Unit tests for apps/runtime/live-instances — who else is executing this
 * digital human right now.
 *
 * The contract the rest of the change leans on: the list is derived (a
 * conversation that is no longer running cannot appear, whatever start time was
 * recorded for it), a caller never sees itself, an origin taken from a user
 * -controlled IM group name cannot break out of the markdown heading it lands
 * in, and a turn too young to be worth mentioning is withheld.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { runs, rounds, consumers, imSessions } = vi.hoisted(() => ({
  runs: [] as any[],
  rounds: new Set<string>(),
  consumers: new Set<string>(),
  imSessions: new Map<string, any>(),
}))

vi.mock('../../../../src/main/apps/runtime/active-runs', () => ({
  listActiveRuns: (appId: string) => runs.filter((r) => r.appId === appId),
}))

vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  getConversationsWithActiveRound: () => Array.from(rounds),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  getRunningConsumerIds: () => Array.from(consumers),
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({
    findSession: (_appId: string, channel: string, chatId: string) =>
      imSessions.get(`${channel}:${chatId}`),
  }),
}))

vi.mock('../../../../src/main/apps/runtime/team', () => ({
  getActiveTeamRuntime: () => ({
    getTeamName: () => 'Ops',
  }),
}))

import {
  describeSelfInstance,
  formatInstanceTag,
  listLiveInstances,
  noteInstanceTurnEnded,
  noteInstanceTurnStarted,
} from '../../../../src/main/apps/runtime/live-instances'

const APP = 'app-1'
const CHAT = 'app-chat:app-1'
const IM = 'app-chat:app-1:wecom-bot:group:chat-77'
const TEAM = 'app-chat:app-1:team:team-9:epoch-3'

/** Old enough to clear the visibility floor. */
function startedLongAgo(conversationId: string): void {
  noteInstanceTurnStarted(conversationId)
  vi.setSystemTime(Date.now() + 60_000)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-01T15:00:00'))
  runs.length = 0
  rounds.clear()
  consumers.clear()
  imSessions.clear()
  for (const id of [CHAT, IM, TEAM]) noteInstanceTurnEnded(id)
})

describe('live instances', () => {
  it('names each surface the way a person would', () => {
    imSessions.set('wecom-bot:chat-77', { displayName: '产品群', chatId: 'chat-77' })
    runs.push({ runId: 'a1b2c3d4-0000-0000-0000-000000000000', appId: APP, triggerType: 'schedule', startedAt: Date.now() })
    for (const id of [CHAT, IM, TEAM]) {
      consumers.add(id)
      startedLongAgo(id)
    }

    const byKind = Object.fromEntries(listLiveInstances(APP).map((i) => [i.kind, i.origin]))
    expect(byKind).toEqual({
      run: 'schedule',
      chat: 'chat',
      im: '产品群',
      team: 'team:Ops',
    })
  })

  it('drops a conversation that stopped running, even with a start time on file', () => {
    consumers.add(CHAT)
    startedLongAgo(CHAT)
    expect(listLiveInstances(APP)).toHaveLength(1)

    consumers.delete(CHAT)
    expect(listLiveInstances(APP)).toEqual([])
  })

  it('never lists the caller', () => {
    consumers.add(CHAT)
    consumers.add(IM)
    startedLongAgo(CHAT)
    startedLongAgo(IM)

    const self = describeSelfInstance(APP, { conversationId: CHAT })
    const others = listLiveInstances(APP, self.id)
    expect(others.map((i) => i.id)).not.toContain(self.id)
    expect(others).toHaveLength(1)
  })

  it('withholds a turn that only just began', () => {
    consumers.add(CHAT)
    noteInstanceTurnStarted(CHAT)
    expect(listLiveInstances(APP)).toEqual([])

    vi.setSystemTime(Date.now() + 6_000)
    expect(listLiveInstances(APP)).toHaveLength(1)
  })

  it('strips the characters an IM group name could use to break out of a heading', () => {
    const tag = formatInstanceTag({
      id: 'deadbeef',
      kind: 'im',
      origin: '[evil]\n| ## heading | injected text that runs on and on',
      startedAt: 0,
    })
    expect(tag).toBe('evil ## heading injected#dead')
    expect(tag).not.toMatch(/[[\]|\r\n]/)
  })

  it('gives a run the tag its logs use', () => {
    const self = describeSelfInstance(APP, {
      runId: 'a1b2c3d4-5555-0000-0000-000000000000',
      triggerType: 'schedule',
      startedAt: Date.now(),
    })
    expect(formatInstanceTag(self)).toBe('schedule#a1b2')
  })
})
