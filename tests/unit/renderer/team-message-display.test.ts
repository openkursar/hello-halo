/**
 * Where a teammate's message (or another conversation's) is drawn.
 *
 * One that started the AI's work, or that no reply claims (older history, a
 * remote record), is a line of its own: it opens itself for a few seconds when
 * fresh. One read while a reply was being written is drawn among that reply's
 * work — or after the reply as its own card when the reply did no work — and
 * never as a thought process of its own.
 *
 * No DOM here: rows are searched as element trees, lines rendered to markup.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useMemo: (compute: () => unknown) => compute(),
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values?.[key] ?? ''),
  }),
  getCurrentLanguage: () => 'de',
}))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: { openTeam: () => {} } }))
vi.mock('../../../src/renderer/components/chat/MessageItem', () => ({ MessageItem: function MessageItem() { return null } }))
vi.mock('../../../src/renderer/components/chat/CollapsedThoughtProcess', () => ({
  CollapsedThoughtProcess: function CollapsedThoughtProcess() { return null },
  LazyCollapsedThoughtProcess: function LazyCollapsedThoughtProcess() { return null },
}))
vi.mock('../../../src/renderer/components/chat/InjectionAnnotation', () => ({ InjectionAnnotation: () => null }))
vi.mock('../../../src/renderer/components/chat/ArrivalCard', () => ({ ArrivalCard: function ArrivalCard() { return null } }))
vi.mock('../../../src/renderer/components/chat/cross-conversation', () => ({
  CrossConversationMessage: () => null,
  CrossConversationNotice: () => null,
  isCrossConversationMessage: (message: { role: string; source?: string }) => message.role === 'system' && message.source === 'cross-conversation',
  isCrossConversationNotice: () => false,
}))

import { MessageRow } from '../../../src/renderer/components/chat/MessageRow'
import { ArrivalCard } from '../../../src/renderer/components/chat/ArrivalCard'
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
  it('that started the work, or that no reply claims, is the team line itself — never a thought process', () => {
    for (const message of [team(), team({ metadata: { teamId: 'team', teamName: 'Crew' } })]) {
      const tree = nodes(row({ message }))
      const line = tree.find(node => node.type === TeamMemberMessage)
      expect(line?.props?.message).toBe(message)
      expect(line?.props?.inProcess).toBeUndefined()
      expect(tree.some(node => node.type === CollapsedThoughtProcess || node.type === LazyCollapsedThoughtProcess)).toBe(false)
    }
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

  it('received by a reply that did no work is drawn after it as its own card', () => {
    const reply: Message = { id: 'reply', role: 'assistant', content: 'Sure', timestamp: at(30) }
    const arrival = team({ id: 'live', metadata: { teamId: 'team', teamName: 'Crew', inputMode: 'live', inputReplyId: 'reply' } })
    const tree = nodes(row({ message: reply, arrivals: [arrival] }))
    expect(tree.some(node => node.type === CollapsedThoughtProcess)).toBe(false)
    const cards = tree.filter(node => node.type === ArrivalCard)
    expect(cards.map(node => [node.props?.message, node.props?.inProcess])).toEqual([[arrival, undefined]])
  })

  it('received during a reply is not redrawn with each streamed word, and draws its own kind’s line', async () => {
    const { ArrivalCard: Card } = await vi.importActual<typeof import('../../../src/renderer/components/chat/ArrivalCard')>('../../../src/renderer/components/chat/ArrivalCard')
    expect((Card as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
    const arrival = team({ timestamp: at(0) })
    expect(renderToStaticMarkup(createElement(Card, { message: arrival, inProcess: true })))
      .toBe(renderToStaticMarkup(createElement(TeamMemberMessage, { message: arrival, inProcess: true })))
  })
})

describe('the team line', () => {
  it('opens itself while fresh, with its icon highlighted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(at(6)))
    try {
      const html = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team() }))
      expect(html).toMatch(/<svg[^>]*lucide-users[^>]*text-primary/)
      expect(html).toContain('Details follow')
      expect(html).toContain('From team')
      expect(html).toContain('title="Open team view"')
      expect(html).toContain('Crew')
      expect(html).toContain('Reviewer')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says when it arrived in the app’s language: the time alone today, the month and day before', () => {
    const time = { hour: '2-digit', minute: '2-digit' } as const
    const sent = new Date(at(0))
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(at(60)))
      const today = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team({ timestamp: at(0) }), inProcess: true }))
      expect(today.toLowerCase()).toContain(`<time datetime="${sent.toISOString().toLowerCase()}"`)
      expect(today).toContain(`>${sent.toLocaleTimeString('de', time)}</time>`)
      expect(sent.toLocaleTimeString('de', time)).not.toBe(sent.toLocaleTimeString('en-US', time))

      vi.setSystemTime(new Date(sent.getTime() + 3 * 86_400_000))
      const earlier = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team({ timestamp: at(0) }) }))
      expect(earlier).toContain(`>${sent.toLocaleDateString('de', { month: '2-digit', day: '2-digit' })} ${sent.toLocaleTimeString('de', time)}</time>`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still draws a record whose time cannot be read, without a time', () => {
    const html = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team({ timestamp: 'not a time' }) }))
    expect(html).toContain('>Reviewer<')
    expect(html).not.toContain('<time')
  })

  it('stays a quiet collapsed row inside a reply’s work, even when fresh', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(at(6)))
    try {
      const html = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team(), inProcess: true }))
      expect(html).not.toContain('Details follow')
      expect(html).toContain('Report: tests pass')
      expect(html).toContain('aria-expanded="false"')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a plain line with no box, saying who sent it, what about and when', () => {
    const html = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team({ timestamp: at(0) }), inProcess: true }))
    expect(html).toContain('>Reviewer<')
    expect(html).toContain('>Report: tests pass<')
    expect(html).toContain('<time')
    expect(html).not.toMatch(/border|rounded-lg/)
  })

  it('is the same unboxed line when it stands alone, collapsed once settled', () => {
    const html = renderToStaticMarkup(createElement(TeamMemberMessage, { message: team({ timestamp: at(0) }) }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('<time')
    expect(html).not.toMatch(/border|rounded-lg|bg-muted|text-primary/)
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
      inProcess: true,
    }))
    expect(html).toContain('Tests pass')
    expect(html).not.toContain('[Team message from Reviewer]')
  })
})
