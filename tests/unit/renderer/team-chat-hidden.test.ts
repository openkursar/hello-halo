import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
import { reconcileHidden, useTeamChatHiddenStore } from '../../../src/renderer/stores/team-chat-hidden.store'
import { teamTaskHoverCard } from '../../../src/renderer/components/chat/conversation-row-format'

const t = (text: string, options?: Record<string, unknown>) => options ? text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(options[key])) : text

describe('removed team tasks', () => {
  beforeEach(() => useTeamChatHiddenStore.setState({ hidden: {} }))

  it('stays removed through ordinary activity and a question that was already waiting', () => {
    const hidden = { k: { waiting: true } }
    expect(reconcileHidden(hidden, new Map([['k', true]]))).toBe(hidden)
    expect(reconcileHidden({ k: { waiting: false } }, new Map([['k', false]]))).toEqual({ k: { waiting: false } })
  })

  it('comes back when a new question awaits the user, only after the earlier one was answered', () => {
    const answered = reconcileHidden({ k: { waiting: true } }, new Map([['k', false]]))
    expect(answered).toEqual({ k: { waiting: false } })
    expect(reconcileHidden(answered, new Map([['k', true]]))).toEqual({})
  })

  it('ignores tasks the list does not currently carry', () => {
    const hidden = { k: { waiting: false } }
    expect(reconcileHidden(hidden, new Map())).toBe(hidden)
  })

  it('hides and restores per space, and restore of an unknown key changes nothing', () => {
    const { hide, restore } = useTeamChatHiddenStore.getState()
    hide('s', 'k', true)
    expect(useTeamChatHiddenStore.getState().hidden).toEqual({ s: { k: { waiting: true } } })
    const before = useTeamChatHiddenStore.getState().hidden
    restore('s', 'other'); restore('x', 'k')
    expect(useTeamChatHiddenStore.getState().hidden).toBe(before)
    restore('s', 'k')
    expect(useTeamChatHiddenStore.getState().hidden).toEqual({ s: {} })
  })
})

describe('team task hover card', () => {
  const task: any = { teamName: 'Crew', label: 'Plan', lastActivityAt: Date.now() }
  it('names the team and shows provenance only for tasks others started', () => {
    expect(teamTaskHoverCard(task, t)).toMatchObject({ label: 'Plan', owner: 'Crew', note: undefined })
    expect(teamTaskHoverCard({ ...task, startedBy: 'Ann' }, t).note).toBe('Started by Ann')
  })
  it('falls back to the new-conversation label', () => {
    expect(teamTaskHoverCard({ ...task, label: '' }, t).label).toBe('New team conversation')
  })
})
