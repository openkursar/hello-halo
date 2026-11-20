/**
 * Where a teammate's message (or another conversation's) is drawn.
 *
 * A team's message always reads as conversation, never a card of its own: one
 * that opened a reply is named on its sender line, one that no reply follows is
 * that same line on its own, and one read while a reply was written is drawn
 * among that reply's work — or after the reply as the same line when it did no
 * work — and never as a thought process of its own.
 *
 * No DOM here: rows are searched as element trees, cards rendered to markup.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useMemo: (compute: () => unknown) => compute(),
}))
vi.mock('../../../src/renderer/i18n', () => ({
  getCurrentLanguage: () => 'en-US',
  useTranslation: () => ({
    t: (text: string, values?: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values?.[key] ?? ''),
  }),
}))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: { openTeam: () => {} } }))
vi.mock('../../../src/renderer/components/chat/MessageItem', () => ({ MessageItem: function MessageItem() { return null } }))
vi.mock('../../../src/renderer/components/chat/CollapsedThoughtProcess', () => ({
  CollapsedThoughtProcess: function CollapsedThoughtProcess() { return null },
  LazyCollapsedThoughtProcess: function LazyCollapsedThoughtProcess() { return null },
}))
vi.mock('../../../src/renderer/components/chat/InjectionAnnotation', () => ({ InjectionAnnotation: () => null }))
vi.mock('../../../src/renderer/components/chat/ArrivalCard', () => ({
  ArrivalCard: function ArrivalCard() { return null },
  TrailingArrivals: function TrailingArrivals() { return null },
}))
vi.mock('../../../src/renderer/components/chat/cross-conversation', () => ({
  CrossConversationMessage: () => null,
  CrossConversationNotice: () => null,
  isCrossConversationMessage: (message: { role: string; source?: string }) => message.role === 'system' && message.source === 'cross-conversation',
  isCrossConversationNotice: () => false,
}))

import { MessageRow } from '../../../src/renderer/components/chat/MessageRow'
import { TrailingArrivals } from '../../../src/renderer/components/chat/ArrivalCard'
import { CollapsedThoughtProcess, LazyCollapsedThoughtProcess } from '../../../src/renderer/components/chat/CollapsedThoughtProcess'
import { TeamMemberMessage } from '../../../src/renderer/components/chat/team-collab/TeamMemberMessage'
import { ReplyOpeners } from '../../../src/renderer/components/chat/team-collab/ReplyOpeners'
import type { Message, Thought } from '../../../src/renderer/types'

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }

function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}

type RowProps = { message: Message; arrivals?: Message[]; openers?: Message[]; senderName?: string }
function row(props: RowProps): unknown {
  return (MessageRow as unknown as { type: (props: RowProps) => unknown }).type(props)
}

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 13, 10, 0, seconds)).toISOString()
const team = (fields: Partial<Message> = {}): Message => ({
  id: 'team-1', role: 'system', source: 'team-message', content: 'Report: tests pass\n\nDetails follow', timestamp: at(5),
  metadata: { teamId: 'team', teamName: 'Crew', fromMemberName: 'Reviewer', inputMode: 'turn' }, ...fields,
})
const tool = (id: string, seconds: number): Thought => ({ id, type: 'tool_use', content: '', timestamp: at(seconds), toolName: 'Read' })

describe('a teammate message in the transcript', () => {
  it('that no reply follows is the received line on its own — never a card or a thought process', () => {
    for (const message of [team(), team({ metadata: { teamId: 'team', teamName: 'Crew' } })]) {
      const tree = nodes(row({ message, senderName: 'Halo' }))
      const line = tree.find(node => node.type === ReplyOpeners)
      expect(line?.props?.openers).toEqual([message])
      expect(line?.props?.senderName).toBe('Halo')
      expect(tree.some(node => node.type === TeamMemberMessage)).toBe(false)
      expect(tree.some(node => node.type === CollapsedThoughtProcess || node.type === LazyCollapsedThoughtProcess)).toBe(false)
    }
    const run = [team(), team({ id: 'team-2' })]
    expect(nodes(row({ message: run[0], openers: run })).find(node => node.type === ReplyOpeners)?.props?.openers).toEqual(run)
  })

  it('read while a reply was written joins that reply’s work at the time it arrived', () => {
    const reply: Message = { id: 'reply', role: 'assistant', content: 'Done', timestamp: at(30), thoughts: [tool('a', 1), tool('b', 20)] }
    const arrival = team({ id: 'live', timestamp: at(10), metadata: { teamId: 'team', teamName: 'Crew', inputMode: 'live', inputReplyId: 'reply' } })
    const process = nodes(row({ message: reply, arrivals: [arrival] })).find(node => node.type === CollapsedThoughtProcess)
    expect((process?.props?.thoughts as Thought[]).map(thought => thought.id)).toEqual(['a', 'arrival:live', 'b'])

    const stored: Message = { ...reply, thoughts: null, thoughtsSummary: { count: 2, types: {}, duration: 19 } }
    const lazy = nodes(row({ message: stored, arrivals: [arrival] })).find(node => node.type === LazyCollapsedThoughtProcess)
    expect(lazy?.props?.arrivals).toEqual([arrival])
  })

  it('that opened a reply’s turn is named on that reply’s sender line, collapsed', () => {
    const reply: Message = { id: 'reply', role: 'assistant', content: 'On it', timestamp: at(30) }
    const opener = team()
    const tree = nodes(row({ message: reply, openers: [opener], senderName: 'Halo' }))
    const line = tree.find(node => node.type === ReplyOpeners)
    expect(line?.props?.openers).toEqual([opener])
    expect(tree.some(node => node.type === TeamMemberMessage)).toBe(false)

    const html = renderToStaticMarkup(createElement(ReplyOpeners, { senderName: 'Halo', openers: [opener, team({ id: 'team-2', metadata: { teamId: 'team', teamName: 'Crew', fromMemberName: 'Scout' } })] }))
    expect(html).toContain('Halo')
    expect(html).toContain('Received reports from Reviewer and 1 more')
    expect(html).not.toContain('Details follow')
  })

  it('that opened a reply’s turn opens on the sender line for a jump to it, where search and references can find it', () => {
    const opener = team()
    const html = renderToStaticMarkup(createElement(ReplyOpeners, { senderName: 'Halo', openers: [opener], reveal: { messageId: opener.id } }))
    expect(html).toContain(`data-message-id="${opener.id}"`)
    expect(html).toContain('Details follow')
  })

  it('received by a reply that did no work is drawn after it', () => {
    const reply: Message = { id: 'reply', role: 'assistant', content: 'Sure', timestamp: at(30) }
    const arrival = team({ id: 'live', metadata: { teamId: 'team', teamName: 'Crew', inputMode: 'live', inputReplyId: 'reply' } })
    const tree = nodes(row({ message: reply, arrivals: [arrival], senderName: 'Halo' }))
    expect(tree.some(node => node.type === CollapsedThoughtProcess)).toBe(false)
    const after = tree.find(node => node.type === TrailingArrivals)
    expect(after?.props).toMatchObject({ arrivals: [arrival], senderName: 'Halo' })
  })
})

describe('arrivals drawn after a reply', () => {
  it('read one team’s messages as one received line, while another conversation’s keeps its card', async () => {
    const actual = await vi.importActual<typeof import('../../../src/renderer/components/chat/ArrivalCard')>('../../../src/renderer/components/chat/ArrivalCard')
    const other: Message = { id: 'other', role: 'system', source: 'cross-conversation', content: 'Hi', timestamp: at(8) }
    const tree = nodes(actual.TrailingArrivals({ arrivals: [team(), team({ id: 'team-2', metadata: { teamId: 'team', teamName: 'Crew', fromMemberName: 'Scout' } }), other], senderName: 'Halo' }))
    const lines = tree.filter(node => node.type === ReplyOpeners)
    expect(lines.map(node => (node.props?.openers as Message[]).map(message => message.id))).toEqual([['team-1', 'team-2']])
    expect(lines[0].props?.senderName).toBe('Halo')
    expect(tree.filter(node => node.type === TeamMemberMessage)).toEqual([])
  })
})

describe('a team message in a reply’s work', () => {
  it('stays a quiet collapsed row', () => {
    const html = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team() }))
    expect(html).not.toContain('Details follow')
    expect(html).toContain('Report: tests pass')
    expect(html).toContain('aria-expanded="false"')
  })

  it('is a plain line inside a reply’s work: who sent it and what about, no box, no age', () => {
    const html = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team({ timestamp: at(0) }), inProcess: true }))
    expect(html).toContain('>Reviewer<')
    expect(html).toContain('>Report: tests pass<')
    expect(html).not.toMatch(/border|rounded-lg|ago/)
  })

  it('names a notice the runtime wrote for the coordinating AI as team progress, keeping its text for when it is opened', () => {
    const notice = team({
      content: '[System] Collaboration turn-end report. These are execution facts.\n\n- Reviewer — stopped with no error reported.',
      metadata: { teamId: 'team', teamName: 'Crew', fromMemberName: null, teamTriggerKind: 'member_stopped' } as Message['metadata'],
    })
    const html = renderToStaticMarkup(createElement(TeamMemberMessage, { message: notice, inProcess: true }))
    expect(html).toContain('Team progress')
    expect(html).not.toContain('[System]')
    expect(html).toContain('title="Crew"')
  })

  it('summarizes a record by its stored summary when the content starts with what the member read', () => {
    const html = renderToStaticMarkup(createElement(TeamMemberMessage, {
      message: team({ content: '[Team message from Reviewer]\n\nTests pass', metadata: { teamId: 'team', teamName: 'Crew', summary: 'Tests pass' } }),
    }))
    expect(html).toContain('Tests pass')
    expect(html).not.toContain('[Team message from Reviewer]')
  })
})
