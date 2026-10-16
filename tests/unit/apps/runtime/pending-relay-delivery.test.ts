import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImSessionRecord } from '../../../../src/shared/types/im-channel'
import type { RelayEvent, RelayPushEvent } from '../../../../src/main/apps/runtime/pending-relays'

const env = vi.hoisted(() => ({
  busy: true,
  live: true,
  identity: 'owner' as string | undefined,
  enabled: true,
  owner: true,
  authorizationRevision: {} as object,
  sessionRevision: {} as object,
  entries: [] as RelayEvent[],
  send: vi.fn((_key: string, _text: string) => true),
  commit: vi.fn(),
  actions: vi.fn(async (_events: RelayEvent[], _authorized: () => boolean) => new Map<string, string>()),
  changes: new Set<(key: string) => void>(),
  events: new Set<(event: any) => void>(),
}))
const KEY = 'app-chat:person:wecom-bot:direct:boss'
const destination: ImSessionRecord = {
  appId: 'person', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
  instanceId: 'bot', displayName: 'Owner', source: 'im', proactive: true, lastActiveAt: 1, contactId: 'boss',
}

vi.mock('../../../../src/main/services/agent', () => ({
  hasLiveTurn: () => env.live, sendIntoLiveTurn: env.send,
  onAgentEvent: (listener: (event: any) => void) => { env.events.add(listener); return { dispose: () => env.events.delete(listener) } },
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: () => env.busy,
  getAppChatTurnIdentity: () => env.identity,
  onAppChatConversationChange: (listener: (key: string) => void) => { env.changes.add(listener); return () => env.changes.delete(listener) },
}))
vi.mock('../../../../src/main/services/space.service', () => ({ getSpace: () => ({ path: '/space' }) }))
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => ({ getApp: () => ({ spaceId: 'space' }) }) }))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => ({ getAuthorizationRevision: () => env.authorizationRevision, getInstanceConfig: () => ({
    id: 'bot', enabled: env.enabled, appId: 'person', permissionEnabled: true, owners: env.owner ? ['boss'] : [],
  }) }),
}))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({ getSessionRevision: () => env.sessionRevision, findSession: () => ({
    appId: 'person', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
    instanceId: 'bot', source: 'im', contactId: 'boss', proactive: true,
  }) }),
}))
vi.mock('../../../../src/main/apps/runtime/relay-actions', () => ({ prepareRelayActions: env.actions }))
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({ resolveTranscriptPath: () => '/space/history.jsonl' }))
vi.mock('../../../../src/main/apps/runtime/pending-relays', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getPendingRelayStore: () => ({
    peek: () => [...env.entries],
    commit: (key: string, ids: string[]) => {
      env.commit(key, ids)
      env.entries = env.entries.filter(event => !ids.includes(event.id))
    },
  }),
}))

import { offerPendingRelaysToLiveTurn, shutdownPendingRelayDelivery } from '../../../../src/main/apps/runtime/pending-relay-delivery'

function relay(id: string, action = false): RelayPushEvent {
  return {
    kind: 'push', id, at: 1, source: { key: 'app-run:sender:run', appId: 'sender', runId: 'run' },
    sourceOwner: true, message: `message ${id}`,
    ...(action ? { action: { kind: 'answer-question' as const, appId: 'sender', entryId: id } } : {}),
  }
}

beforeEach(() => {
  env.busy = true
  env.live = true
  env.identity = 'owner'
  env.enabled = true
  env.owner = true
  env.authorizationRevision = {}
  env.sessionRevision = {}
  env.entries = []
  env.send.mockReset().mockReturnValue(true)
  env.commit.mockClear()
  env.actions.mockReset().mockResolvedValue(new Map())
  env.changes.clear()
  env.events.clear()
})

describe('pending relay delivery into live work', () => {
  it('commits compatible notification context only after native acceptance', async () => {
    env.entries = [relay('notice')]
    env.send.mockImplementation(() => {
      expect(env.commit).not.toHaveBeenCalled()
      return true
    })
    await offerPendingRelaysToLiveTurn(KEY, destination, { id: 'notice', identity: 'owner' })
    expect(env.send).toHaveBeenCalledWith(KEY, expect.stringContaining('message notice'), undefined, { onWithdrawn: expect.any(Function) })
    expect(env.commit).toHaveBeenCalledWith(KEY, ['notice'])
    expect(env.entries).toEqual([])
  })

  it('retains lower-authority notification context during an owner turn', async () => {
    env.entries = [relay('guest')]
    await offerPendingRelaysToLiveTurn(KEY, destination, { id: 'guest', identity: 'guest:restricted' })
    expect(env.send).not.toHaveBeenCalled()
    expect(env.commit).not.toHaveBeenCalled()
    expect(env.entries).toHaveLength(1)
  })

  it('uses the captured source authority instead of a later owner turn on the source', async () => {
    env.entries = [relay('unknown')]
    await offerPendingRelaysToLiveTurn(KEY, destination, { id: 'unknown', identity: undefined })
    expect(env.send).not.toHaveBeenCalled()
    expect(env.entries).toHaveLength(1)
  })

  it('can add a same-policy guest notification without exposing source history', async () => {
    env.identity = 'guest:restricted'
    env.entries = [{ ...relay('guest'), quote: 'private origin', originContact: 'bot:origin' }]
    await offerPendingRelaysToLiveTurn(KEY, destination, { id: 'guest', identity: 'guest:restricted' })
    expect(env.send).toHaveBeenCalledOnce()
    expect(env.send.mock.calls[0][1]).not.toContain('private origin')
    expect(env.send.mock.calls[0][1]).not.toContain('history.jsonl')
    expect(env.commit).toHaveBeenCalledWith(KEY, ['guest'])
  })

  it('does not wake an idle chat or consume its spool', async () => {
    env.busy = false
    env.live = false
    env.entries = [relay('later')]
    await offerPendingRelaysToLiveTurn(KEY, destination, { id: 'later', identity: 'owner' })
    expect(env.send).not.toHaveBeenCalled()
    expect(env.entries).toHaveLength(1)
  })

  it('retains events when the current turn ends before accepting them', async () => {
    env.entries = [relay('race')]
    env.send.mockReturnValue(false)
    await offerPendingRelaysToLiveTurn(KEY, destination, { id: 'race', identity: 'owner' })
    expect(env.commit).not.toHaveBeenCalled()
    expect(env.entries).toHaveLength(1)
  })

  it('waits for startup readiness and hands simultaneous notifications over together', async () => {
    env.live = false
    env.entries = [relay('one')]
    const first = offerPendingRelaysToLiveTurn(KEY, destination, { id: 'one', identity: 'owner' })
    env.entries.push(relay('two'))
    const second = offerPendingRelaysToLiveTurn(KEY, destination, { id: 'two', identity: 'owner' })
    expect(env.send).not.toHaveBeenCalled()
    env.live = true
    for (const listener of env.events) listener({ channel: 'agent:turn-start', conversationId: KEY })
    await Promise.all([first, second])
    expect(env.send).toHaveBeenCalledOnce()
    expect(env.send.mock.calls[0][1]).toMatch(/message one[\s\S]*message two/)
    expect(env.changes.size).toBe(0)
    expect(env.events.size).toBe(0)
  })

  it('rechecks owner authorization after preparing a private question action', async () => {
    env.entries = [relay('question', true)]
    env.actions.mockImplementation(async (_events, authorized) => {
      expect(authorized()).toBe(true)
      env.owner = false
      expect(authorized()).toBe(false)
      throw new Error('Owner access revoked')
    })
    await offerPendingRelaysToLiveTurn(KEY, destination)
    expect(env.send).not.toHaveBeenCalled()
    expect(env.entries).toHaveLength(1)
  })

  it('releases startup waiters on shutdown while preserving the durable message', async () => {
    env.live = false
    env.entries = [relay('startup')]
    const pending = offerPendingRelaysToLiveTurn(KEY, destination, { id: 'startup', identity: 'owner' })
    expect(env.changes.size).toBe(1)
    shutdownPendingRelayDelivery()
    await pending
    expect(env.changes.size).toBe(0)
    expect(env.events.size).toBe(0)
    expect(env.entries).toHaveLength(1)
    expect(env.send).not.toHaveBeenCalled()
  })

  it.each(['authorizationRevision', 'sessionRevision'] as const)('does not revive an action after %s changes back to identical settings', async revision => {
    env.entries = [relay('question', true)]
    env.actions.mockImplementation(async (_events, authorized) => {
      expect(authorized()).toBe(true)
      env[revision] = {}
      expect(authorized()).toBe(false)
      return new Map([['question', 'Bounded answer action']])
    })
    await offerPendingRelaysToLiveTurn(KEY, destination)
    expect(env.send).not.toHaveBeenCalled()
    expect(env.commit).not.toHaveBeenCalled()
    expect(env.entries).toHaveLength(1)
  })

  it('allows a fresh offer after cancelling an older destination preparation', async () => {
    env.live = false
    env.entries = [relay('old')]
    const old = offerPendingRelaysToLiveTurn(KEY, destination, { id: 'old', identity: 'owner' })
    env.sessionRevision = {}
    env.entries = [relay('new')]
    const next = offerPendingRelaysToLiveTurn(KEY, destination, { id: 'new', identity: 'owner' })
    env.live = true
    for (const listener of env.events) listener({ channel: 'agent:turn-start', conversationId: KEY })
    await Promise.all([old, next])
    expect(env.send).toHaveBeenCalledOnce()
    expect(env.send.mock.calls[0][1]).toContain('message new')
    expect(env.send.mock.calls[0][1]).not.toContain('message old')
  })
})
