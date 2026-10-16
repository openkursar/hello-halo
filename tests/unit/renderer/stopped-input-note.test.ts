/**
 * A person's input that a Stop voided before the AI read it stays where it was
 * sent, with a small note that it was not handled — as a message bubble, or as
 * a line added to a running reply.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ loadMessageThoughts: () => {}, currentSpaceId: null }),
  selectActiveConversationId: () => null,
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (selector: (state: unknown) => unknown) => selector({ currentSpace: null }) }))
vi.mock('../../../src/renderer/components/references', () => ({
  MessageReferenceChips: () => null,
  MessageTaskCard: () => null,
  useConversationReferenceScope: () => null,
  useTextReferences: () => {},
}))
vi.mock('../../../src/renderer/components/chat/UserMessageText', () => ({ UserMessageText: ({ text }: { text: string }) => createElement('span', {}, text) }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }))
vi.mock('../../../src/renderer/components/tool/BrowserTaskCard', () => ({ BrowserTaskCard: () => null, isBrowserTool: () => false }))
vi.mock('../../../src/renderer/components/tool/TerminalTaskCard', () => ({ TerminalTaskCard: () => null, isTerminalTool: () => false }))
vi.mock('../../../src/renderer/components/diff', () => ({ FileChangesFooter: () => null }))
vi.mock('../../../src/renderer/components/goal', () => ({ GoalSetBadge: () => null }))
vi.mock('../../../src/renderer/components/chat/SourceChips', () => ({ SourceChips: () => null }))
vi.mock('../../../src/renderer/components/chat/ImageAttachmentPreview', () => ({ MessageImages: () => null }))
vi.mock('../../../src/renderer/components/chat/TokenUsageIndicator', () => ({ TokenUsageIndicator: () => null }))
vi.mock('../../../src/renderer/components/icons/ToolIcons', () => ({ getToolIcon: () => null }))

import { MessageItem } from '../../../src/renderer/components/chat/MessageItem'
import { InjectionAnnotation } from '../../../src/renderer/components/chat/InjectionAnnotation'
import type { Message } from '../../../src/renderer/types'

const sent: Message = { id: 'm1', role: 'user', content: 'also check the logs', timestamp: '2026-10-13T10:00:00.000Z' }
const stopped: Message = { ...sent, metadata: { inputOutcome: 'stopped' } }

describe('a person’s input voided by Stop', () => {
  it('keeps its bubble, with the note under it', () => {
    const html = renderToStaticMarkup(createElement(MessageItem, { message: stopped }))
    expect(html).toContain('also check the logs')
    expect(html).toContain('Stopped, not handled')
    expect(html.indexOf('Stopped, not handled')).toBeGreaterThan(html.indexOf('also check the logs'))
    expect(html).toContain('text-muted-foreground')
  })

  it('leaves every other bubble exactly as it was', () => {
    const html = renderToStaticMarkup(createElement(MessageItem, { message: sent }))
    expect(html).not.toContain('Stopped, not handled')
    expect(html).toContain('max-w-[85%]')
  })

  it('marks only the voided line of a running reply’s additions', () => {
    const html = renderToStaticMarkup(createElement(InjectionAnnotation, {
      messages: [{ ...sent, id: 'read', source: 'injection', content: 'first' }, { ...stopped, id: 'void', source: 'injection', content: 'second' }],
    }))
    expect(html.match(/Stopped, not handled/g)).toHaveLength(1)
    expect(html.indexOf('Stopped, not handled')).toBeGreaterThan(html.indexOf('second'))
  })
})
