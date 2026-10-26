/**
 * From the space conversation that coordinates it, a collaboration shows as
 * that conversation's single room — before and after it is kept as a team.
 * The Teams page shows a kept team's full workbench.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.stubGlobal('window', { innerWidth: 1600, addEventListener: () => {}, removeEventListener: () => {} })

const view = vi.hoisted(() => ({
  conversations: [
    { epochId: 'room', kind: 'collab' },
    { epochId: 'standalone', kind: 'native' },
  ],
  conversationsError: null,
  isLoadingConversations: false,
  selectedConversationId: 'standalone' as string | null,
}))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/team.store', () => ({
  useTeamStore: { getState: () => ({}) },
  useTeamView: (select: (v: typeof view) => unknown) => select(view),
  useSelectTeamTask: () => () => {},
}))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({ useAppsPageStore: { getState: () => ({}) } }))
vi.mock('../../../src/renderer/stores/people-view.store', () => ({
  usePeopleViewStore: Object.assign((select: (s: unknown) => unknown) => select({ teamTarget: null }), { setState: () => {} }),
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: (select: (s: unknown) => unknown) => select({ apps: [] }),
}))
vi.mock('../../../src/renderer/stores/team-view-prefs.store', () => ({
  useDefaultChatTarget: () => null,
  useTeamViewPrefsStore: Object.assign((select: (s: unknown) => unknown) => select({ setTaskGroup: () => {}, setDefaultMember: () => {} }), { getState: () => ({}) }),
}))
vi.mock('../../../src/renderer/components/ui/Popover', () => ({ Popover: () => null, PopoverTrigger: () => null, PopoverContent: () => null }))
vi.mock('../../../src/renderer/components/team/SettingsTab', () => ({ SettingsTab: () => null }))
vi.mock('../../../src/renderer/components/team/TeamInviteDialog', () => ({ TeamInviteDialog: () => null }))
vi.mock('../../../src/renderer/components/team/workbench/TaskSidebar', async () => {
  const { createElement } = await import('react')
  return { TaskSidebar: () => createElement('nav', { 'data-task-sidebar': true }) }
})
vi.mock('../../../src/renderer/components/team/workbench/TaskRoom', async () => {
  const { createElement } = await import('react')
  return { TaskRoom: (props: { task: { epochId: string } | null }) => createElement('main', { 'data-room': props.task?.epochId ?? 'new' }) }
})
vi.mock('../../../src/renderer/components/team/workbench/MemberRail', async () => {
  const { createElement } = await import('react')
  return { MemberRail: () => createElement('aside', { 'data-member-rail': true }) }
})
vi.mock('../../../src/renderer/components/team/workbench/TeamActivityDrawer', () => ({ TeamActivityDrawer: () => null }))
vi.mock('../../../src/renderer/components/team/workbench/WorkbenchDrawer', () => ({ WorkbenchDrawer: () => null }))
vi.mock('../../../src/renderer/components/team/workbench/useTaskBoard', () => ({ useTaskBoard: () => null }))
vi.mock('../../../src/renderer/components/team/workbench/model', () => ({
  taskGroup: () => 'mine',
  visibleTasks: (tasks: unknown[]) => tasks,
}))

const { TeamView } = await import('../../../src/renderer/components/team/TeamView')

const detail = (team: { ephemeral?: boolean; coordinatorConversationId?: string | null; savedTeamId?: string }) => ({
  team: { id: 'team', name: 'Crew', goal: '', hostNodeId: null, ...team },
  members: [], roster: [], pendingEscalations: [],
}) as never

const render = (team: Parameters<typeof detail>[0], spaceEntry: boolean) =>
  renderToStaticMarkup(createElement(TeamView, { detail: detail(team), spaceEntry }))

describe('team view opened from a space conversation', () => {
  it('shows a temporary collaboration as its single room', () => {
    const html = render({ ephemeral: true, coordinatorConversationId: 'conv' }, true)
    expect(html).toContain('data-room="room"')
    expect(html).not.toContain('data-task-sidebar')
    expect(html).toContain('Keep this team')
    expect(html).not.toContain('Team settings')
  })

  it('keeps showing a kept collaboration as its single room, without team settings', () => {
    const html = render({ ephemeral: true, coordinatorConversationId: 'conv', savedTeamId: 'saved' }, true)
    expect(html).toContain('data-room="room"')
    expect(html).not.toContain('data-task-sidebar')
    expect(html).not.toContain('Keep this team')
    expect(html).toContain('Open saved team')
    expect(html).not.toContain('Team settings')
    expect(html).toContain('data-member-rail')
  })

  it('shows a team that no space conversation coordinates as the full workbench', () => {
    const html = render({ ephemeral: false, coordinatorConversationId: null }, true)
    expect(html).toContain('data-room="standalone"')
    expect(html).toContain('data-task-sidebar')
    expect(html).toContain('Team settings')
  })

  it('shows a kept collaboration as the full workbench on the Teams page', () => {
    const html = render({ ephemeral: false, coordinatorConversationId: 'conv' }, false)
    expect(html).toContain('data-room="standalone"')
    expect(html).toContain('data-task-sidebar')
    expect(html).toContain('Team settings')
  })
})
