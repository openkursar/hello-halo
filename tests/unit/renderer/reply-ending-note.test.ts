/**
 * A reply that ended before its answer was done says so under itself, after
 * every reload, so its words read as how far the work got. While the chat's
 * own notice after a stop is on screen, that notice speaks for it instead.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Message, Thought } from '../../../src/renderer/types'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (value: string) => value }), getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: (select: (state: unknown) => unknown) => select({ loadMessageThoughts: async () => [], currentSpaceId: 'space' }),
  selectActiveConversationId: () => 'conversation',
  holdOpenThoughts: () => () => {},
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: (state: unknown) => unknown) => select({ currentSpace: null }) }))
vi.mock('../../../src/renderer/components/references', () => ({
  useConversationReferenceScope: () => null, useTextReferences: () => {}, useFileLinkOptions: () => null,
  MessageReferenceChips: () => null, MessageTaskCard: () => null,
}))
vi.mock('../../../src/renderer/components/chat/CollapsedThoughtProcess', () => ({
  CollapsedThoughtProcess: () => createElement('div', { 'data-process': true }),
  LazyCollapsedThoughtProcess: () => createElement('div', { 'data-process': true }),
}))
vi.mock('../../../src/renderer/components/chat/InjectionAnnotation', () => ({ InjectionAnnotation: () => null }))
vi.mock('../../../src/renderer/components/chat/ArrivalCard', () => ({ ArrivalCard: () => null }))
vi.mock('../../../src/renderer/components/chat/transcript', () => ({ mergeArrivalThoughts: () => [], toArrivalThought: () => null }))
vi.mock('../../../src/renderer/components/chat/cross-conversation', () => ({
  CrossConversationMessage: () => null, CrossConversationNotice: () => null,
  isCrossConversationMessage: () => false, isCrossConversationNotice: () => false,
}))
vi.mock('../../../src/renderer/components/chat/team-collab', () => ({ TeamMemberMessage: () => null, isTeamMessage: () => false }))
vi.mock('../../../src/renderer/components/chat/SourceChips', () => ({ SourceChips: () => null }))
vi.mock('../../../src/renderer/components/chat/ImageAttachmentPreview', () => ({ MessageImages: () => null }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => createElement('span', null, content) }))
vi.mock('../../../src/renderer/components/tool/BrowserTaskCard', () => ({ BrowserTaskCard: () => null, isBrowserTool: () => false }))
vi.mock('../../../src/renderer/components/tool/TerminalTaskCard', () => ({ TerminalTaskCard: () => null, isTerminalTool: () => false }))
vi.mock('../../../src/renderer/components/diff', () => ({ FileChangesFooter: () => null }))
vi.mock('../../../src/renderer/components/chat/TokenUsageIndicator', () => ({ TokenUsageIndicator: () => null }))
vi.mock('../../../src/renderer/components/goal', () => ({ GoalSetBadge: () => null }))

import { MessageRow } from '../../../src/renderer/components/chat/MessageRow'

const timestamp = '2026-11-19T00:00:00.000Z'
const work: Thought[] = [{ id: 'tool', type: 'tool_use', toolName: 'Bash', content: '', timestamp }]
const reply = (fields: Partial<Message>): Message => ({ id: 'reply', role: 'assistant', content: '', timestamp, thoughts: work, ...fields })
const render = (message: Message, endingShownBelow = false) => renderToStaticMarkup(createElement(MessageRow, { message, endingShownBelow }))

describe('how a reply ended, under the reply', () => {
  it('reads its words as progress when it was stopped or cut off', () => {
    const stopped = render(reply({ content: 'Checking the edges first.', metadata: { ending: 'stopped' } }))
    expect(stopped).toContain('Checking the edges first.')
    expect(stopped).toContain('Stopped.')
    expect(stopped).toContain('Above is the progress so far.')
    expect(stopped.indexOf('Stopped.')).toBeGreaterThan(stopped.indexOf('Checking the edges first.'))

    expect(render(reply({ content: 'Half', metadata: { ending: 'interrupted' } }))).toContain('Interrupted.')
    const limited = render(reply({ content: 'Part one.', metadata: { ending: 'step-limit' } }))
    expect(limited).toContain('Reached the step limit.')
    expect(limited).toContain('Send a message to continue.')
  })

  it('says how a reply with nothing but its work ended', () => {
    const html = render(reply({ metadata: { ending: 'stopped' } }))
    expect(html).toContain('data-process')
    expect(html).toContain('Stopped.')
    expect(html).not.toContain('Above is the progress so far.')
  })

  it('steps aside while the chat’s notice after a stop is on screen', () => {
    expect(render(reply({ content: 'Checking.', metadata: { ending: 'stopped' } }), true)).not.toContain('Stopped.')
    expect(render(reply({ metadata: { ending: 'stopped' } }), true)).not.toContain('Stopped.')
  })

  it('adds nothing to a reply that finished', () => {
    const html = render(reply({ content: 'Done.' }))
    expect(html).not.toContain('Stopped.')
    expect(html).not.toContain('Interrupted.')
  })
})
