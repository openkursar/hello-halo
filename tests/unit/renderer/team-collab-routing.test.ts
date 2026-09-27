/**
 * Ephemeral-collaboration routing in the team store.
 *
 * The ephemeral workbench shows the collaboration's single room implicitly (it
 * ignores the conversation selection). Saving the team flips the workbench to
 * selection-driven routing — so `saveCollab` must land the user IN that room,
 * or the running conversation silently "disappears" into the blank new-task
 * state (the room resolver finds nothing for a null selection).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  saveCollab: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  conversations: vi.fn(),
}))
vi.mock('../../../src/renderer/api', () => ({
  api: {
    teamSaveCollab: calls.saveCollab,
    teamList: calls.list,
    teamGetDetail: calls.detail,
    teamListConversations: calls.conversations,
  },
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s } }))

import { useTeamStore } from '../../../src/renderer/stores/team.store'

const collabRoom = {
  epochId: 'room-1',
  teamId: 't1',
  kind: 'collab' as const,
  label: 'Research crew',
  readonly: false,
  startedAt: 1,
  lastActivityAt: 1,
}

describe('saveCollab routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.saveCollab.mockResolvedValue({ success: true, data: { id: 't1' } })
    calls.list.mockResolvedValue({ success: true, data: [] })
    calls.detail.mockResolvedValue({ success: false })
    calls.conversations.mockResolvedValue({ success: true, data: [collabRoom] })
    useTeamStore.setState({
      currentTeamId: 't1',
      detail: null,
      conversations: [],
      selectedConversationId: null,
    })
  })

  it('keeps the user in the collaboration room after saving', async () => {
    const ok = await useTeamStore.getState().saveCollab('t1')
    expect(ok).toBe(true)
    expect(useTeamStore.getState().selectedConversationId).toBe('room-1')
  })

  it('never steals an explicit selection', async () => {
    calls.conversations.mockResolvedValue({
      success: true,
      data: [collabRoom, { ...collabRoom, epochId: 'other-task', kind: 'native' as const }],
    })
    useTeamStore.setState({ selectedConversationId: 'other-task' })
    await useTeamStore.getState().saveCollab('t1')
    expect(useTeamStore.getState().selectedConversationId).toBe('other-task')
  })

  it('does not touch the selection when a different team is open', async () => {
    useTeamStore.setState({ currentTeamId: 't2', selectedConversationId: null })
    await useTeamStore.getState().saveCollab('t1')
    expect(useTeamStore.getState().selectedConversationId).toBeNull()
    expect(calls.detail).not.toHaveBeenCalled()
  })
})
