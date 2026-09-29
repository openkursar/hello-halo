/**
 * The composer's @ conversation pool: a space's own conversations and its
 * digital-human chats, merged, self-excluded and ordered by activity.
 */

import { describe, it, expect } from 'vitest'
import { buildConversationMentionCandidates } from '../../../src/renderer/components/chat/cross-conversation/mention-candidates'
import { formatConversationReference } from '../../../src/shared/conversation-reference'
import { buildLocalSessionKey, getAppChatConversationId } from '../../../src/shared/apps/im-keys'
import type { TaskStatus } from '../../../src/renderer/types'

const T0 = Date.UTC(2026, 0, 1)
const t = (text: string) => text

const conversation = (id: string, title: string, minutes: number, preview = '') =>
  ({ id, title, preview, updatedAt: new Date(T0 + minutes * 60_000).toISOString() }) as any

const chatRow = (over: Record<string, unknown>) =>
  ({
    id: getAppChatConversationId('app-1'),
    appId: 'app-1',
    appSpaceId: 'space-1',
    digitalHumanName: 'Analyst',
    isDefault: true,
    displayName: 'Analyst',
    updatedAt: T0,
    messageCount: 1,
    starred: false,
    status: 'active',
    uninstalled: false,
    ...over,
  }) as any

const build = (over: Partial<Parameters<typeof buildConversationMentionCandidates>[0]> = {}) =>
  buildConversationMentionCandidates({
    conversations: [],
    digitalHumanChats: [],
    activeConversationId: null,
    statuses: new Map<string, TaskStatus>(),
    isCollabEnabled: () => true,
    t,
    ...over,
  })

describe('buildConversationMentionCandidates', () => {
  it('offers space conversations and digital-human chats from one pool, most recent first', () => {
    const local = buildLocalSessionKey('app-1', 'sess-1')
    const result = build({
      conversations: [conversation('c1', 'Old plan', 1, 'draft'), conversation('c2', 'New plan', 30)],
      digitalHumanChats: [
        chatRow({ updatedAt: T0 + 20 * 60_000, lastMessage: 'churn is 4%' }),
        chatRow({ id: local, isDefault: false, customName: 'Q3 numbers', displayName: '', updatedAt: T0 + 10 * 60_000 }),
      ],
    })

    expect(result.map(c => c.id)).toEqual(['c2', getAppChatConversationId('app-1'), local, 'c1'])
    expect(result[1]).toMatchObject({ title: 'Analyst', summary: 'churn is 4%', digitalHuman: 'Analyst' })
    expect(result[2]).toMatchObject({ title: 'Analyst: Q3 numbers', digitalHuman: 'Analyst' })
    expect(result[0].digitalHuman).toBeUndefined()
    expect(result[1].updatedAt).toBe(new Date(T0 + 20 * 60_000).toISOString())
  })

  it('names an unnamed local chat by its first message, or "New chat" when it has none', () => {
    const a = buildLocalSessionKey('app-1', 'a')
    const b = buildLocalSessionKey('app-1', 'b')
    const result = build({
      digitalHumanChats: [
        chatRow({ id: a, isDefault: false, displayName: ' ', lastMessage: 'x'.repeat(80) }),
        chatRow({ id: b, isDefault: false, displayName: '' }),
      ],
    })
    expect(result.find(c => c.id === a)!.title).toBe(`Analyst: ${'x'.repeat(50)}`)
    expect(result.find(c => c.id === b)!.title).toBe('Analyst: New chat')
  })

  it('puts running conversations first, whichever kind they are', () => {
    const key = getAppChatConversationId('app-1')
    const result = build({
      conversations: [conversation('c1', 'Busy plan', 1), conversation('c2', 'Fresh plan', 50)],
      digitalHumanChats: [chatRow({ updatedAt: T0 + 10 * 60_000 })],
      statuses: new Map<string, TaskStatus>([[key, 'generating'], ['c1', 'waiting']]),
    })
    expect(result.map(c => [c.id, c.status])).toEqual([[key, 'generating'], ['c1', 'waiting'], ['c2', 'idle']])
  })

  it('leaves out the conversation the composer belongs to, space chat or digital-human chat alike', () => {
    const key = getAppChatConversationId('app-1')
    const conversations = [conversation('c1', 'Plan', 1)]
    const digitalHumanChats = [chatRow({})]

    expect(build({ conversations, digitalHumanChats, activeConversationId: 'c1' }).map(c => c.id)).toEqual([key])
    expect(build({ conversations, digitalHumanChats, activeConversationId: key }).map(c => c.id)).toEqual(['c1'])
  })

  it('leaves out the chats of a digital human that has been removed', () => {
    expect(build({ digitalHumanChats: [chatRow({ uninstalled: true, status: 'uninstalled' })] })).toEqual([])
  })

  it('inserts a reference whose handle is the hash of the chat key, the one the backend resolves', () => {
    const [candidate] = build({ digitalHumanChats: [chatRow({})] })
    expect(formatConversationReference(candidate.title, candidate.id)).toMatch(/^\[#Analyst\]\(conv:[0-9a-f]{8}\)$/)
    expect(formatConversationReference(candidate.title, candidate.id)).not.toContain('appchat')
  })

  it('still shows a chat whose digital human has collaboration off, marked and after every reachable one', () => {
    const key = getAppChatConversationId('app-1')
    const other = buildLocalSessionKey('app-2', 's')
    const result = build({
      conversations: [conversation('c1', 'Old plan', 1)],
      digitalHumanChats: [
        chatRow({ updatedAt: T0 + 99 * 60_000 }),
        chatRow({ id: other, appId: 'app-2', isDefault: false, digitalHumanName: 'Writer', customName: 'Draft', updatedAt: T0 }),
      ],
      statuses: new Map<string, TaskStatus>([[key, 'generating']]),
      isCollabEnabled: (appId) => appId !== 'app-1',
    })
    expect(result.map(c => [c.id, !!c.unavailable])).toEqual([['c1', false], [other, false], [key, true]])
  })
})
