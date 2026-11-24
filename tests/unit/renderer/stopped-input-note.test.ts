/**
 * A person's input that a Stop voided before the AI read it stays where it was
 * sent, with a small note that it was not handled — as a message bubble, or as
 * a line added to a running reply.
 */

import * as React from 'react'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>()
  return { ...actual, useState: vi.fn(actual.useState) }
})

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ loadMessageThoughts: () => {}, currentSpaceId: null }),
  selectActiveConversationId: () => null,
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (selector: (state: unknown) => unknown) => selector({ currentSpace: null }) }))
vi.mock('../../../src/renderer/components/references', () => ({
  MessageReferenceChips: ({ references, className }: { references: unknown[]; className?: string }) => references.length
    ? createElement('div', { className, 'data-reference-chips': true }, 'selection chip')
    : null,
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
vi.mock('../../../src/renderer/components/chat/ImageViewer', () => ({ ImageViewer: () => null }))
vi.mock('../../../src/renderer/components/chat/TokenUsageIndicator', () => ({ TokenUsageIndicator: () => null }))
vi.mock('../../../src/renderer/components/icons/ToolIcons', () => ({ getToolIcon: () => null }))

import { MessageItem } from '../../../src/renderer/components/chat/MessageItem'
import { InjectionAnnotation } from '../../../src/renderer/components/chat/InjectionAnnotation'
import { QueuedMessagesPanel } from '../../../src/renderer/components/chat/QueuedMessagesPanel'
import { MessageImages } from '../../../src/renderer/components/chat/ImageAttachmentPreview'
import { ImageViewer } from '../../../src/renderer/components/chat/ImageViewer'
import type { Message } from '../../../src/renderer/types'

const sent: Message = { id: 'm1', role: 'user', content: 'also check the logs', timestamp: '2026-10-13T10:00:00.000Z' }
const stopped: Message = { ...sent, metadata: { inputOutcome: 'stopped' } }

describe('supplement image chips', () => {
  const images: NonNullable<Message['images']> = [
    { id: 'first', type: 'image', name: 'first.png', mediaType: 'image/png', data: 'AAAA' },
    { id: 'second', type: 'image', name: 'second.png', mediaType: 'image/png', data: '', url: 'halo-file://fixture/second.png' },
  ]

  it('places named image chips before the text without loading inline previews', () => {
    const html = renderToStaticMarkup(createElement(InjectionAnnotation, {
      messages: [{ ...sent, source: 'injection', images }],
    }))
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2)
    expect(html.indexOf('second.png')).toBeLessThan(html.indexOf('also check the logs'))
    expect(html).toContain('max-w-[min(240px,100%)]')
    expect(html).toContain('truncate')
    expect(html).toContain('[&amp;_.text-foreground]:text-inherit')
    expect(html).toContain('[&amp;_.text-muted-foreground]:text-inherit')
    expect(html).not.toContain('<img')
  })

  it('opens the clicked image in the existing viewer and closes it again', () => {
    const state: unknown[] = [false, 0]
    let cursor = 0
    const spy = vi.spyOn(React, 'useState').mockImplementation((() => {
      const slot = cursor++
      return [state[slot], (value: unknown) => { state[slot] = value }]
    }) as typeof React.useState)
    const render = () => { cursor = 0; return MessageImages({ images, presentation: 'chips' })! }
    try {
      const tree = render()
      const chips = tree.props.children[0] as ReactElement<{ onClick: () => void }>[]
      chips[1].props.onClick()
      const viewer = render().props.children[1] as ReactElement<{ images: typeof images; initialIndex: number; onClose: () => void }>
      expect(viewer.type).toBe(ImageViewer)
      expect(viewer.props.images).toBe(images)
      expect(viewer.props.initialIndex).toBe(1)
      viewer.props.onClose()
      expect(render().props.children[1]).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('leaves normal message images as previews', () => {
    const html = renderToStaticMarkup(createElement(MessageImages, { images: [images[0]] }))
    expect(html).toContain('<img')
    expect(html).not.toContain('aria-haspopup="dialog"')
  })
})

describe('pending supplement images', () => {
  it.each(['', 'look at this'])('renders images with summary %j without a false References label', summary => {
    const html = renderToStaticMarkup(createElement(QueuedMessagesPanel, {
      messages: [{ summary, images: [{ id: 'pending-image', type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' }] }],
    }))
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('Attached image')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('References')
    if (summary) expect(html).toContain(summary)
    expect(html).toContain('min-w-0 flex-1')
    expect(html).toContain('[&amp;_.text-foreground]:text-inherit')
    expect(html).toContain('[&amp;_.text-muted-foreground]:text-inherit')
  })

  it('keeps text, named references and the unnamed-reference fallback', () => {
    const html = renderToStaticMarkup(createElement(QueuedMessagesPanel, {
      messages: [{ summary: 'plain text' }, { summary: 'notes.ts' }, { summary: '' }],
    }))
    expect(html).toContain('plain text')
    expect(html).toContain('notes.ts')
    expect(html).toContain('References')
    expect(html).not.toContain('aria-haspopup="dialog"')
    expect(renderToStaticMarkup(createElement(QueuedMessagesPanel, { messages: [] }))).toBe('')
  })
})

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

  it('places reference chips before the supplement text in a wrapping row, with the stopped note below', () => {
    const html = renderToStaticMarkup(createElement(InjectionAnnotation, {
      messages: [{
        ...stopped,
        source: 'injection',
        metadata: {
          ...stopped.metadata,
          references: [{ id: 'selection', source: { kind: 'terminal', title: 'Output' }, quote: 'selected output' }],
        },
      }],
    }))
    expect(html).toContain('flex min-w-0 flex-wrap items-center gap-1.5')
    expect(html).toContain('data-reference-chips="true"')
    expect(html).toContain('[&amp;_.text-foreground]:text-inherit')
    expect(html).toContain('[&amp;_.text-muted-foreground]:text-inherit')
    expect(html.indexOf('selection chip')).toBeLessThan(html.indexOf('also check the logs'))
    expect(html.indexOf('Stopped, not handled')).toBeGreaterThan(html.indexOf('also check the logs'))
    expect(html).toContain('min-w-0 whitespace-pre-wrap')
  })

  it('renders persisted image-only additions as compact image chips with the stopped outcome', () => {
    const html = renderToStaticMarkup(createElement(InjectionAnnotation, {
      messages: [{ ...stopped, content: '', source: 'injection', images: [{ id: 'image-1', type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' }] }],
    }))
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('Attached image')
    expect(html).not.toContain('<img')
    expect(html).toContain('flex min-w-0 flex-1 flex-col')
    expect(html).toContain('Stopped, not handled')
  })

  it('marks only the voided line of a running reply’s additions', () => {
    const html = renderToStaticMarkup(createElement(InjectionAnnotation, {
      messages: [{ ...sent, id: 'read', source: 'injection', content: 'first' }, { ...stopped, id: 'void', source: 'injection', content: 'second' }],
    }))
    expect(html.match(/Stopped, not handled/g)).toHaveLength(1)
    expect(html.indexOf('Stopped, not handled')).toBeGreaterThan(html.indexOf('second'))
  })
})
