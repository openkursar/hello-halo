import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonTeam: vi.fn() }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: ({ name, size }: any) => createElement('span', { 'data-avatar': name, 'data-size': size }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: (select: any) => select({ spaceStates: new Map(), getSession: () => ({ isGenerating: false }) }) }))
vi.mock('../../../src/renderer/stores/team-chat-pins.store', () => ({ useTeamChatPinsStore: (select: any) => select({ togglePin: () => {} }) }))
vi.mock('../../../src/renderer/utils/team-conversation-navigation', () => ({ openTeamConversation: () => true }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ navigateToConversation: () => {} }))
vi.mock('../../../src/renderer/stores/team.store', () => ({ useTeamStore: (select: any) => select({ renameConversation: () => {}, openConversation: () => {} }), useMemberPresence: () => ({ reachability: 'online', ownerName: null, isRemote: false }) }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select({ apps: [{ id: 'member', spaceId: 'space' }] }) }))
vi.mock('../../../src/renderer/stores/team-view-prefs.store', () => ({ useTeamViewPrefsStore: (select: any) => select({ setDefaultMember: () => {} }) }))
vi.mock('../../../src/renderer/components/team/workbench/useTaskDecisions', () => ({ useTaskDecisions: () => ({ entries: [] }) }))
vi.mock('../../../src/renderer/components/team/workbench/members', () => ({ ownedTaskMembers: (detail: any) => detail.roster }))
vi.mock('../../../src/renderer/components/team/workbench/TaskMemberSelector', () => ({ TaskMemberSelector: () => null }))
vi.mock('../../../src/renderer/components/team/workbench/TaskConversation', () => ({ TaskConversation: () => null }))
vi.mock('../../../src/renderer/components/team/workbench/ExecutionStatus', () => ({ ExecutionStatus: () => null }))
vi.mock('../../../src/renderer/components/team/TeamSessionChat', () => ({ TeamSessionChat: (props: any) => createElement('div', { 'data-picker': props.toolbarSlot ? 'toolbar' : props.composerAdjacentSlot ? 'composer' : 'none' }, props.emptyContent ?? props.emptyTitle, props.emptyHint) }))

vi.mock('../../../src/renderer/components/references', () => ({ ConversationReferenceScope: ({ children }: any) => children }))
import { TeamConversationRow } from '../../../src/renderer/components/chat/TeamConversationRow'
import { TaskRoom } from '../../../src/renderer/components/team/workbench/TaskRoom'

const detail: any = { team: { id: 'team' }, roster: [{ appId: 'member', memberName: 'Member' }], pendingEscalations: [], tasks: [], findings: [], activities: [] }
const task: any = { teamId: 'team', epochId: 'epoch', label: 'Discussion', kind: 'native' }
const room = (homepageConversation: boolean, selectedTask: any = null) => renderToStaticMarkup(createElement(TaskRoom, {
  homepageConversation, detail, task: selectedTask, selectedAppId: 'member', tasks: [], boardState: { board: null, activities: [], failed: false, retry: () => {} } as any,
  onSelectMember: () => {}, onCreated: () => {}, onActivity: () => {}, onTask: () => {}, onExecution: () => {},
}))
const row = (value: any, compact = false) => renderToStaticMarkup(createElement(TeamConversationRow, {
  row: { avatar: { names: [], overflow: 0 }, ...value }, compact, spaceId: 'space', onToggle: () => {}, onRefresh: () => {},
}))

describe('homepage team conversation presentation', () => {
  it('uses the same four-member grid for headers and pins, and only a status mark in the folded list', () => {
    const avatarNames = ['Lead', 'Writer', 'Analyst', 'Researcher']
    const avatar = { names: avatarNames, overflow: 0 }
    const values = [
      row({ type: 'team-header', teamId: 'team', name: 'Crew', collapsed: false, avatar }),
      row({ type: 'team-item', task: { ...task, teamName: 'Crew' }, standalone: true, avatar }),
    ]
    expect(row({ type: 'team-item', task: { ...task, teamName: 'Crew' }, avatar }, true)).not.toContain('data-avatar=')
    for (const html of values) {
      expect(html.match(/data-avatar=/g)).toHaveLength(4)
      for (const name of avatarNames) expect(html).toContain(`data-avatar="${name}"`)
      expect(html.indexOf('data-avatar="Lead"')).toBeLessThan(html.indexOf('data-avatar="Writer"'))
      expect(html.match(/data-size="12"/g)).toHaveLength(4)
      // Each face is ringed in the page background so overlapping faces stay apart.
      expect(html.match(/box-shadow:0 0 0 1px hsl\(var\(--background\)\)/g)).toHaveLength(4)
      expect(html).toContain('left:0;top:0;width:12px;height:12px;z-index:0')
      expect(html).toContain('left:6px;top:0;width:12px;height:12px;z-index:1')
      expect(html).toContain('left:0;top:6px;width:12px;height:12px;z-index:2')
      expect(html).toContain('left:6px;top:6px;width:12px;height:12px;z-index:3')
      expect(html).toContain('width:18px;height:18px')
      expect(html).not.toContain('bg-muted')
      expect(html).not.toContain('ring-inset')
      expect(html).not.toContain('lucide-users')
    }
  })
  it.each([2, 3])('centers %i members without creating empty avatar cells', count => {
    const html = row({ type: 'team-header', teamId: 'team', name: 'Crew', collapsed: false, avatar: { names: ['Lead', 'Writer', 'Analyst'].slice(0, count), overflow: 0 } })
    expect(html.match(/data-avatar=/g)).toHaveLength(count)
    expect(html).toContain('width:18px;height:18px')
    expect(html.match(/data-size="12"/g)).toHaveLength(count)
    if (count === 3) expect(html).toContain('left:3px;top:6px;width:12px;height:12px;z-index:2')
    else {
      // Two faces sit on one row: the group is one face tall, with nothing below.
      expect(html).toContain('width:18px;height:12px')
      expect(html).not.toContain('top:6px')
    }
  })
  it.each([[2, '+2'], [99, '+99'], [100, '…'], [5000, '…']])('veils the fourth face with the count for %i members beyond the first three', (overflow, label) => {
    const names = ['Lead', 'Writer', 'Analyst', 'Researcher']
    const html = row({ type: 'team-header', teamId: 'team', name: 'Crew', collapsed: false, avatar: { names, overflow } })
    expect(html.match(/data-avatar=/g)).toHaveLength(4)
    expect(html.match(/box-shadow:0 0 0 1px/g)).toHaveLength(4)
    expect(html.match(/bg-foreground\/30/g)).toHaveLength(1)
    expect(html.indexOf('data-avatar="Researcher"')).toBeLessThan(html.indexOf('bg-foreground/30'))
    expect(html).toContain(`>${label}</span>`)
    expect(html).not.toContain('bg-border')
  })
  it('keeps the count in a slot of its own when remote members leave fewer than four local faces', () => {
    const html = row({ type: 'team-header', teamId: 'team', name: 'Crew', collapsed: false, avatar: { names: ['Lead'], overflow: 3 } })
    expect(html.match(/data-avatar=/g)).toHaveLength(1)
    expect(html).toContain('>+3</span>')
    expect(html).toContain('bg-border')
    expect(html).not.toContain('bg-foreground/30')
    expect(html).toContain('width:18px;height:12px')
  })
  it('uses one member face or the team initial without introducing an extra control', () => {
    const header = { type: 'team-header', teamId: 'team', name: 'Crew', collapsed: false }
    const single = row({ ...header, avatar: { names: ['Lead'], overflow: 0 } })
    expect(single.match(/data-avatar=/g)).toHaveLength(1)
    expect(single).not.toContain('relative isolate')
    expect(single).toContain('h-[18px] w-[18px]')
    const fallback = row(header)
    expect(fallback).toContain('>C</span>')
    expect(fallback).not.toContain('data-avatar=')
    expect(fallback.match(/<button/g)).toHaveLength(4)
    expect(fallback).toContain('aria-label="View {{name}}"')
  })
  it('uses a simple draft while preserving workbench onboarding', () => {
    expect(room(true)).toContain('No messages yet')
    expect(room(true)).not.toContain('Start a new task')
    expect(room(false)).toContain('Start a new task')
  })
  it('labels the homepage room and activity as a conversation only', () => {
    const home = room(true, task)
    expect(home).toContain('aria-label="Conversation"')
    expect(home).not.toContain('Rename conversation')
    expect(home).toContain('data-picker="composer"')
    const workbench = room(false, task)
    expect(workbench).toContain('aria-label="Rename task"')
    expect(workbench).toContain('Task activity')
    expect(workbench).toContain('data-picker="toolbar"')
  })
  it('labels the team plus and omits the archive action from conversation rows', () => {
    expect(row({ type: 'team-header', teamId: 'team', name: 'Crew', collapsed: false })).toContain('aria-label="New team conversation"')
    const html = row({ type: 'team-item', key: 'team:epoch', task, starred: false })
    expect(html).not.toContain('Complete task')
    expect(html).toContain('aria-label="More"')
    expect(html).toContain('aria-label="Pin"')
    expect(html).not.toContain('title="Rename"')
    expect(html).toContain('pl-9')
    const working = row({ type: 'team-item', key: 'team:epoch', task: { ...task, active: true }, starred: false })
    expect(working).toContain('pl-9')
    expect(working).toContain('absolute left-6 top-1/2 -translate-y-1/2')
    expect(html).toContain('group-hover:opacity-100')
    expect(html).toContain('[@media(hover:none)]:opacity-100')
    const header = row({ type: 'team-header', teamId: 'team', name: 'Crew', collapsed: false })
    expect(header).toContain('focus-visible:opacity-100')
    expect(header).toContain('[@media(hover:none)]:opacity-100')
  })
})
