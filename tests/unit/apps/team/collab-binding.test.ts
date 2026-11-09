import { describe, it, expect, vi } from 'vitest'
import { collabReportOwnership, releaseCollaboration, releaseCollaborationsOfApp } from '../../../../src/main/apps/team/collab-binding'
import { buildLocalSessionKey, getAppChatConversationId } from '../../../../src/shared/apps/im-keys'

const dhChat = buildLocalSessionKey('app-1', 'chat-a')
const otherDhChat = buildLocalSessionKey('app-2', 'chat-a')
const spaceChat = 'conversation-1'

function fakeStore(teams: Array<{ id: string; coordinatorConversationId: string | null; ephemeral: boolean }>) {
  return {
    getTeamById: (id: string) => teams.find(team => team.id === id) ?? null,
    getCollabTeamByConversation: (conversationId: string) => teams.find(team => team.coordinatorConversationId === conversationId) ?? null,
    setCoordinatorConversation: vi.fn((id: string, conversationId: string | null) => {
      const team = teams.find(item => item.id === id)
      if (team) team.coordinatorConversationId = conversationId
    }),
    listTeamsBySpace: () => teams,
  } as never as Parameters<typeof releaseCollaborationsOfApp>[0] & Parameters<typeof collabReportOwnership>[0]
}

describe('collabReportOwnership', () => {
  it('checks a space report against both its source binding and captured execution fence', () => {
    let current = true
    const check = collabReportOwnership(fakeStore([{ id: 't', coordinatorConversationId: spaceChat, ephemeral: true }]), 't', spaceChat, () => current)
    expect(check()).toBe(true)
    current = false
    expect(check()).toBe(false)
  })

  it('owns a digital human\u2019s chat only while the collaboration is bound to that very chat', () => {
    const teams = [{ id: 't', coordinatorConversationId: dhChat as string | null, ephemeral: true }]
    const owned = collabReportOwnership(fakeStore(teams), 't', dhChat)!
    expect(owned()).toBe(true)
    teams[0].coordinatorConversationId = getAppChatConversationId('app-1')
    expect(owned()).toBe(false)
    teams[0].coordinatorConversationId = null
    expect(owned()).toBe(false)
    expect(collabReportOwnership(fakeStore(teams), 'missing', dhChat)!()).toBe(false)
  })
})

describe('releasing a collaboration with its conversation', () => {
  it('dissolves an ephemeral collaboration and only unbinds a saved one', () => {
    const teams = [
      { id: 'ephemeral', coordinatorConversationId: dhChat as string | null, ephemeral: true },
      { id: 'saved', coordinatorConversationId: spaceChat as string | null, ephemeral: false },
    ]
    const store = fakeStore(teams)
    const service = { dissolveTeam: vi.fn(async (_teamId: string) => {}) }
    releaseCollaboration(store, service as never, dhChat)
    releaseCollaboration(store, service as never, spaceChat)
    releaseCollaboration(store, service as never, 'no-collaboration')
    expect(service.dissolveTeam.mock.calls).toEqual([['ephemeral']])
    expect(store.setCoordinatorConversation).toHaveBeenCalledWith('saved', null)
  })

  it('on uninstall releases only collaborations coordinated from that digital human\u2019s chats', () => {
    const teams = [
      { id: 'mine-default', coordinatorConversationId: getAppChatConversationId('app-1') as string | null, ephemeral: true },
      { id: 'mine-local', coordinatorConversationId: dhChat as string | null, ephemeral: true },
      { id: 'other-dh', coordinatorConversationId: otherDhChat as string | null, ephemeral: true },
      { id: 'space', coordinatorConversationId: spaceChat as string | null, ephemeral: true },
    ]
    const service = { dissolveTeam: vi.fn(async (_teamId: string) => {}) }
    releaseCollaborationsOfApp(fakeStore(teams), service as never, { id: 'app-1', spaceId: 'space-1' })
    expect(service.dissolveTeam.mock.calls.map(([id]) => id).sort()).toEqual(['mine-default', 'mine-local'])
    releaseCollaborationsOfApp(fakeStore(teams), service as never, { id: 'app-1', spaceId: null })
    expect(service.dissolveTeam).toHaveBeenCalledTimes(2)
  })
})
