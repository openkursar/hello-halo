/**
 * A message a digital human pushed to an IM chat on its own — a notify_bot
 * message, a run's result, a question for the owner — reads, in the chat's
 * record, as sent proactively, not as the answer to the message before it.
 *
 * No DOM here: the returned element tree is searched for what the user would see.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/components/chat/MessageItem', () => ({ MessageItem: function MessageItem() { return null } }))
vi.mock('../../../src/renderer/components/chat/CollapsedThoughtProcess', () => ({
  CollapsedThoughtProcess: () => null,
  LazyCollapsedThoughtProcess: () => null,
}))
vi.mock('../../../src/renderer/components/chat/InjectionAnnotation', () => ({ InjectionAnnotation: () => null }))
vi.mock('../../../src/renderer/components/chat/cross-conversation', () => ({
  CrossConversationMessage: () => null,
  CrossConversationNotice: () => null,
  isCrossConversationMessage: () => false,
  isCrossConversationNotice: () => false,
}))
vi.mock('../../../src/renderer/components/chat/team-collab', () => ({ TeamMemberMessage: () => null, isTeamMessage: () => false }))

import { MessageRow } from '../../../src/renderer/components/chat/MessageRow'
import { PushedMessageLabel } from '../../../src/renderer/components/chat/PushedMessageLabel'
import type { Message } from '../../../src/renderer/types'

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }

function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}

function text(tree: unknown): string[] {
  return nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter((child): child is string => typeof child === 'string')
}

/** MessageRow is memoized; its render function holds no hooks. */
function row(message: Message): unknown {
  return (MessageRow as unknown as { type: (props: { message: Message }) => unknown }).type({ message })
}

const at = '2026-10-07T10:00:00.000Z'

describe('a message pushed to the chat', () => {
  it('carries a line saying the digital human sent it on its own, and as what', () => {
    const tree = row({ id: 'session-msg-4', role: 'assistant', source: 'push', content: 'Nightly report: 3 failures', timestamp: at, metadata: { pushVia: 'result' } })

    const labels = nodes(tree).filter(node => node.type === PushedMessageLabel)
    expect(labels.map(node => node.props?.via)).toEqual(['result'])
  })

  it('says what kind of push it was', () => {
    expect(text(PushedMessageLabel({ via: 'message' }))).toEqual(['Sent proactively'])
    expect(text(PushedMessageLabel({ via: 'result' }))).toEqual(['Sent proactively · result of a run'])
    expect(text(PushedMessageLabel({ via: 'question' }))).toEqual(['Sent proactively · question for the owner'])
    expect(text(PushedMessageLabel({}))).toEqual(['Sent proactively'])
  })

  it('leaves the chat\'s own replies unlabeled', () => {
    const tree = row({ id: 'session-msg-3', role: 'assistant', content: 'Yes.', timestamp: at })

    expect(nodes(tree).some(node => node.type === PushedMessageLabel)).toBe(false)
  })
})
