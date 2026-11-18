import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import type { RosterMember } from '../../../src/shared/apps/team-types'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({
  AutomationAvatar: ({ name }: { name: string }) => createElement('span', { 'data-avatar': name }),
}))
import { LockedComposer } from '../../../src/renderer/components/team/LockedComposer'
import { TaskMemberSelector } from '../../../src/renderer/components/team/workbench/TaskMemberSelector'
import { orderTaskMembers, railCapacity, railFit, railMembers, rememberRecent } from '../../../src/renderer/components/team/workbench/member-rail'
import type { TaskProgress } from '../../../src/renderer/components/team/workbench/progress'

const member = (appId: string, isLead = false) => ({ appId, memberName: appId, isLead } as RosterMember)
const roster = [member('remote'), member('own-b'), member('actual-lead', true), member('own-a'), member('coordinator')]
const render = (members = roster, selectedAppId: string | null = 'own-b', extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(TaskMemberSelector, {
  roster: members, selectedAppId, ownedAppIds: ['actual-lead', 'own-a', 'own-b'], onSelect: vi.fn(), ...extra,
}))
const big = Array.from({ length: 30 }, (_, index) => member(`m${index}`, index === 0))
const pick = (options: Partial<Parameters<typeof railMembers>[1]>) => railMembers(big, {
  selectedAppId: null, ownedAppIds: [], waiting: new Set(), working: new Set(), recent: [], capacity: 5, ...options,
})

describe('task member navigation', () => {
  it('orders actual lead, owned members, then others, preserving roster order within each group', () => {
    expect(orderTaskMembers(roster, ['own-a', 'own-b']).map(row => row.appId)).toEqual(['actual-lead', 'own-b', 'own-a', 'remote', 'coordinator'])
    expect(roster[0].appId).toBe('remote')
  })
  it('fits the rail to its width within fixed bounds', () => {
    expect(railCapacity(0)).toBe(1)
    expect(railCapacity(380)).toBe(4)
    expect(railCapacity(2000)).toBe(8)
  })
  it('keeps the status whole: the progress bar gives way before any avatar folds', () => {
    expect(railFit(700, 170, 5)).toEqual({ capacity: 7, bar: true })
    expect(railFit(700, 170, 12)).toEqual({ capacity: 8, bar: false })
    expect(railFit(250, 180, 5)).toEqual({ capacity: 1, bar: false })
  })
  it('shows every member when one more would only replace the overflow chip', () => {
    expect(pick({ capacity: 29 }).hidden).toEqual([])
    expect(pick({ capacity: 28 }).hidden).toHaveLength(2)
  })
  it('pins the current member and owned members waiting for the user, keeping team order', () => {
    const { shown, hidden } = pick({ selectedAppId: 'm20', ownedAppIds: ['m25', 'm12'], waiting: new Set(['m25', 'm3']), recent: ['m7'] })
    expect(shown.map(row => row.appId)).toEqual(['m0', 'm7', 'm12', 'm20', 'm25'])
    expect(hidden).toHaveLength(25)
    expect(hidden.some(row => row.appId === 'm3')).toBe(true)
  })
  it('remembers recently selected members, most recent first', () => {
    expect(rememberRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(rememberRecent(['a', 'b', 'c', 'd', 'e', 'f'], 'g')).toEqual(['g', 'a', 'b', 'c', 'd', 'e'])
  })
  it('renders every member as a pressable rail item, separating read-only members', () => {
    const html = render()
    expect(html).toContain('role="group" aria-label="Team members"')
    expect(html.match(/data-rail-item=""/g)).toHaveLength(5)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-pressed="true" aria-label="own-b · You can message it"/)
    expect(html).toContain('aria-label="actual-lead · Team lead · You can message it"')
    expect(html).toContain('aria-label="remote · Read-only"')
    expect(html.match(/aria-hidden="true" class="avatar-lock-badge"/g)).toHaveLength(2)
    expect(html).not.toMatch(/member-rail-more[^>]*>(?:<span>)?\+/)
  })
  it('locks each read-only avatar itself, a read-only lead and selected member included', () => {
    const items = render(roster, 'remote', { ownedAppIds: ['own-a', 'own-b'] }).split('data-rail-item=""').slice(1)
    const locked = (name: string) => items.find(item => item.includes(`data-avatar="${name}"`))!.includes('avatar-lock-badge')
    expect(['actual-lead', 'own-b', 'own-a', 'remote', 'coordinator'].map(locked)).toEqual([true, false, false, true, true])
  })
  it('ends the rail with the members toggle, and sets the status beside it to open team progress', () => {
    const quiet = render()
    expect(quiet.match(/aria-haspopup="dialog"/g)).toHaveLength(1)
    expect(quiet).toContain('aria-label="All {{count}} members"')
    expect(quiet).not.toContain('View team progress')
    const progress: TaskProgress = {
      members: [{ appId: 'own-a', state: 'waiting', decisionId: 'd1', question: 'Ship?' }, { appId: 'remote', state: 'failed', activityId: 'lost', senderAppId: 'actual-lead' }, { appId: 'own-b', state: 'working' }],
      counts: { done: 2, in_progress: 1, blocked: 0, pending: 2, rejected: 0 }, total: 5, finished: false,
    }
    const conversation = { progress, leadAppId: 'actual-lead', outputCount: 0, onAnswer: vi.fn() }
    const html = render(roster, 'own-b', { waitingAppIds: new Set(['own-a']), progress: conversation, onActivity: vi.fn() })
    expect(html).toContain('{{count}} waiting for you')
    expect(html).toContain('text-halo-warning')
    expect(html).toContain('2/5')
    expect(html).toContain('data-state="failed"')
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(1)
    const rail = html.slice(html.indexOf('aria-label="Team members"'), html.indexOf('{{count}} waiting for you'))
    expect(rail).toContain('member-rail-more')
    expect(rail.indexOf('member-rail-more')).toBeGreaterThan(rail.lastIndexOf('data-rail-item'))
    expect(html).toMatch(/<button type="button" aria-label="[^"]*· View team progress"/)
    expect(render(roster, 'own-b', { progress: conversation })).not.toContain('View team progress')
  })
  it('marks waiting and working only for owned members of this conversation', () => {
    const html = render(roster, 'own-b', { waitingAppIds: new Set(['own-a', 'remote']), workingAppIds: new Set(['actual-lead']) })
    expect(html).toContain('data-state="waiting"')
    expect(html).toContain('aria-label="own-a · Waiting for you · You can message it"')
    expect(html).toContain('aria-label="remote · Read-only"')
    expect(html).toContain('aria-label="actual-lead · Team lead · Working… · You can message it"')
  })
  it('floats the ask over the waiting member’s own avatar only when it can be answered here', () => {
    const waitingAppIds = new Set(['own-a'])
    const html = render(roster, 'own-b', { waitingAppIds, onAnswer: vi.fn() })
    expect(html.match(/member-rail-ask/g)).toHaveLength(1)
    expect(html).toMatch(/data-avatar="own-a"(?:(?!<\/button>).)*member-rail-ask/)
    expect(render(roster, 'own-b', { waitingAppIds })).not.toContain('member-rail-ask')
    expect(render(roster, 'own-a', { waitingAppIds, onAnswer: vi.fn() })).not.toContain('member-rail-ask')
  })
  it('names a lead whose role is "Team Lead" only once', () => {
    const lead = { ...member('boss', true), role: 'Team Lead' } as RosterMember
    const html = render([lead, ...roster], 'own-b', { ownedAppIds: ['boss', 'own-b'] })
    expect(html).toContain('aria-label="boss · Team lead · You can message it"')
  })
  it('cards a member with its role, duty, state here and who may message it, read-only members included', () => {
    const writer = { ...member('writer'), role: 'Copywriter', duty: 'Drafts the launch copy', owner: 'Alice', presence: 'offline' } as RosterMember
    const html = render([...roster, writer], 'own-b', { workingAppIds: new Set(['writer']) })
    const card = html.split('data-card=""').map(part => part.split('</button>')[0]).find(part => part.includes('data-avatar="writer"'))!
    expect(card).toContain('Copywriter')
    expect(card).toContain('Drafts the launch copy')
    expect(card).toContain('Working…')
    expect(card).toContain('{{owner}}’s digital human · Read-only')
    expect(card).toContain('{{owner}} is offline')
    expect(card).toContain('data-avatar="writer"')
    expect(html).not.toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*data-card/)
  })
  it('collapses large teams behind an overflow chip that flags hidden members waiting for the user', () => {
    const html = renderToStaticMarkup(createElement(TaskMemberSelector, {
      roster: big, selectedAppId: 'm1', ownedAppIds: big.map(row => row.appId), waitingAppIds: new Set(['m29']), onSelect: vi.fn(),
    }))
    expect(html.match(/data-rail-item=""/g)).toHaveLength(8)
    expect(html).toContain('+22')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('data-avatar="m29"')
    expect(html).not.toContain('bg-halo-warning [box-shadow')
    expect(render([], null)).toBe('')
  })
  it('marks a temporary team, with no member current while the conversation that leads it is shown', () => {
    const html = render(roster, null, { temporary: true, ownedAppIds: roster.map(row => row.appId) })
    expect(html.indexOf('Temporary team')).toBeLessThan(html.indexOf('aria-label="Team members"'))
    expect(html).not.toContain('aria-pressed="true"')
    expect(render(roster, 'own-a', { temporary: true, ownedAppIds: roster.map(row => row.appId) })).toMatch(/aria-pressed="true" aria-label="own-a"/)
    expect(html).not.toContain('Read-only')
    expect(render()).not.toContain('Temporary team')
    const chat = readFileSync(new URL('../../../src/renderer/components/chat/ChatView.tsx', import.meta.url), 'utf8')
    expect(chat.indexOf('<TeamCollabBar')).toBeLessThan(chat.lastIndexOf('{inputArea}'))
    const bar = readFileSync(new URL('../../../src/renderer/components/team/TeamCollabBar.tsx', import.meta.url), 'utf8')
    expect(bar).toContain('detailForTask(teamDetail, task, boardState.board)')
    expect(bar).not.toContain('onOpenTeam')
    const canvas = readFileSync(new URL('../../../src/renderer/components/team/TeamTaskProgress.tsx', import.meta.url), 'utf8')
    expect(canvas).toContain('detailForTask(teamDetail, task, boardState.board)')
    const overview = readFileSync(new URL('../../../src/renderer/components/team/TeamTaskOverview.tsx', import.meta.url), 'utf8')
    expect(overview).toContain("t('Keep this team')")
  })
  it('mounts navigation independently of input availability without moving reminders or changing draft identity', () => {
    const chat = readFileSync(new URL('../../../src/renderer/components/team/TeamSessionChat.tsx', import.meta.url), 'utf8')
    expect(chat.indexOf('{composerAdjacentSlot &&')).toBeLessThan(chat.indexOf('readonly ? <LockedComposer'))
    expect(chat.indexOf('{aboveInput}')).toBeGreaterThan(chat.indexOf("reachability === 'offline' ?"))
    expect(chat).toContain('key={inputIdentity.current.key}')
    const room = readFileSync(new URL('../../../src/renderer/components/team/workbench/TaskRoom.tsx', import.meta.url), 'utf8')
    expect(room).toContain('composerAdjacentSlot={homepageConversation ? picker : undefined}')
    expect(room).toContain('toolbarSlot={homepageConversation ? undefined : picker}')
    expect(room).toContain('<div className="mx-auto max-w-chat">{picker}</div>')
  })
  it('keeps conversation status on the member row, outside the composer, with no separate menu', () => {
    const room = readFileSync(new URL('../../../src/renderer/components/team/workbench/TaskRoom.tsx', import.meta.url), 'utf8')
    const bar = room.slice(room.indexOf('const picker = homepageConversation ?'), room.indexOf(': workbenchPicker'))
    expect(bar).toContain('<TaskMemberSelector')
    expect(bar).toContain('onActivity={task ? onActivity : undefined}')
    expect(bar.match(/<[A-Z]\w*/g)).toEqual(['<TaskMemberSelector'])
    expect(readFileSync(new URL('../../../src/renderer/components/team/TeamSessionChat.tsx', import.meta.url), 'utf8')).not.toContain('sendSlot=')
    expect(render()).toMatch(/^<div class="flex min-w-0 items-center gap-2">/)
  })
  it('keeps a locked composer in place with the reason written inside, and a stop control while a teammate works', () => {
    const locked = renderToStaticMarkup(createElement(LockedComposer, { reason: 'Only Taylor can send messages.', roomy: true }))
    expect(locked).toContain('Only Taylor can send messages.')
    expect(locked).toContain('role="status"')
    expect(locked).toContain('aria-disabled="true"')
    expect(locked).toContain('max-w-chat')
    expect(locked).not.toContain('<button')
    expect(renderToStaticMarkup(createElement(LockedComposer, { reason: 'x', roomy: false, onStop: vi.fn() }))).toContain('Stop generation')  })
  it('lets replies of a local member open their file changes in the canvas, but not a remote member\'s', () => {
    const chat = readFileSync(new URL('../../../src/renderer/components/team/TeamSessionChat.tsx', import.meta.url), 'utf8')
    expect(chat).toContain('!isRemote && spaceId && epochId ? { spaceId, conversationId } : null')
    expect(chat).toContain('<ChangesScopeContext.Provider value={changesScope}>')
    const item = readFileSync(new URL('../../../src/renderer/components/chat/MessageItem.tsx', import.meta.url), 'utf8')
    expect(item).toContain('providedScope ?? (allowViewChanges')
  })
  it('draws a member\'s received reports on its reply instead of as a card of their own', () => {
    const room = readFileSync(new URL('../../../src/renderer/components/team/workbench/TaskConversation.tsx', import.meta.url), 'utf8')
    expect(room).toContain('openersLine={openersLine}')
    expect(room).toContain('<OpenersLine')
  })
  it('names the selected member in the homepage placeholder and aligns the stream with the composer width', () => {
    const room = readFileSync(new URL('../../../src/renderer/components/team/workbench/TaskRoom.tsx', import.meta.url), 'utf8')
    expect(room).toContain("placeholder={homepageConversation ? t('Message {{name}}…', { name: member.memberName }) : undefined}")
    const chat = readFileSync(new URL('../../../src/renderer/components/team/TeamSessionChat.tsx', import.meta.url), 'utf8')
    expect(chat).toContain("composerAdjacentSlot ? 'max-w-[calc(var(--chat-reading-width)+3rem)] animate-member-swap px-6' : 'max-w-3xl px-4'")
  })
})
