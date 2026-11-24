import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Message, Thought } from '../../../src/renderer/types'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (value: string) => value }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: (select: (state: unknown) => unknown) => select({ loadMessageThoughts: async () => [], currentSpaceId: 'space' }),
  selectActiveConversationId: () => 'conversation',
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: (state: unknown) => unknown) => select({ currentSpace: null }) }))
vi.mock('../../../src/renderer/components/references', () => ({
  useConversationReferenceScope: () => null, useTextReferences: () => {},
  MessageReferenceChips: () => null, MessageTaskCard: () => null,
}))
vi.mock('../../../src/renderer/components/chat/CollapsedThoughtProcess', () => ({
  CollapsedThoughtProcess: () => createElement('div', { 'data-process': 'inline' }, 'Thought process'),
  LazyCollapsedThoughtProcess: () => createElement('div', { 'data-process': 'lazy' }, 'Thought process'),
}))
vi.mock('../../../src/renderer/components/chat/InjectionAnnotation', () => ({ InjectionAnnotation: () => null }))
vi.mock('../../../src/renderer/components/chat/ArrivalCard', () => ({ ArrivalCard: () => null }))
vi.mock('../../../src/renderer/components/chat/transcript', () => ({ mergeArrivalThoughts: () => [], toArrivalThought: () => null }))
vi.mock('../../../src/renderer/components/chat/cross-conversation', () => ({
  CrossConversationMessage: () => null, CrossConversationNotice: () => null,
  isCrossConversationMessage: () => false, isCrossConversationNotice: () => false,
}))
vi.mock('../../../src/renderer/components/chat/team-collab', () => ({ TeamMemberMessage: () => null, isTeamMessage: () => false }))
vi.mock('../../../src/renderer/components/tool/BrowserTaskCard', () => ({ BrowserTaskCard: () => null, isBrowserTool: () => false }))
vi.mock('../../../src/renderer/components/tool/TerminalTaskCard', () => ({ TerminalTaskCard: () => null, isTerminalTool: () => false }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => createElement('span', null, content) }))
vi.mock('../../../src/renderer/components/diff', () => ({ FileChangesFooter: () => null }))
vi.mock('../../../src/renderer/components/chat/ImageAttachmentPreview', () => ({ MessageImages: () => null }))
vi.mock('../../../src/renderer/components/chat/TokenUsageIndicator', () => ({ TokenUsageIndicator: () => null }))
vi.mock('../../../src/renderer/components/chat/SourceChips', () => ({ SourceChips: () => null }))
vi.mock('../../../src/renderer/components/goal', () => ({ GoalSetBadge: () => null }))

import { MessageRow } from '../../../src/renderer/components/chat/MessageRow'

const timestamp = '2026-01-01T00:00:00.000Z'
function processFields(name: 'inline' | 'lazy', type: 'error' | 'thinking' | 'tool_use'): Pick<Message, 'thoughts' | 'thoughtsSummary'> {
  const thought: Thought = { id: 'process', type, content: 'Recorded process', timestamp, ...(type === 'tool_use' ? { toolName: 'Read' } : {}) }
  return name === 'inline' ? { thoughts: [thought] } : { thoughts: null, thoughtsSummary: { count: 1, types: { [type]: 1 }, duration: 0 } }
}

describe('persisted assistant errors beside thought history', () => {
  for (const name of ['inline', 'lazy'] as const) {
    it(`shows the existing error block with ${name} thoughts and no reply text`, () => {
      const message: Message = { id: 'failed-reply', role: 'assistant', content: '', error: '401: Synthetic provider rejection', timestamp, ...processFields(name, 'error') }
      const html = renderToStaticMarkup(createElement(MessageRow, { message }))
      expect(html).toContain(`data-process="${name}"`)
      expect(html).toContain('data-message-id="failed-reply"')
      expect(html).toContain('401: Synthetic provider rejection')
      expect(html.match(/Something went wrong/g)).toHaveLength(1)
      expect(html).not.toContain('message-assistant')
    })

    for (const type of ['tool_use', 'thinking'] as const) {
      it(`keeps ${name} ${type}-only output free of an empty message bubble`, () => {
        const message: Message = { id: 'process-only', role: 'assistant', content: '', timestamp, ...processFields(name, type) }
        const html = renderToStaticMarkup(createElement(MessageRow, { message }))
        expect(html).toContain(`data-process="${name}"`)
        expect(html).not.toContain('data-message-id="process-only"')
        expect(html).not.toContain('message-assistant')
        expect(html).not.toContain('Something went wrong')
      })
    }
  }
})
