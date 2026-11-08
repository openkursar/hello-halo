/**
 * A `conv:` link in rendered Markdown is always Halo's own: it renders as an
 * in-app reference (no href the system could follow), whatever id it carries.
 * Other links keep their href and open outside.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({
  default: { t: (text: string) => text },
  useTranslation: () => ({ t: (text: string) => text, i18n: { language: 'en' } }),
}))
vi.mock('../../../src/renderer/api', () => ({ api: { isRemoteMode: () => false } }))
const openConversationReference = vi.fn()
vi.mock('../../../src/renderer/components/chat/cross-conversation/open-conversation-reference', () => ({
  openConversationReference: (...args: unknown[]) => openConversationReference(...args),
}))
const renderedTargets: unknown[] = []
vi.mock('../../../src/renderer/components/chat/cross-conversation', async () => {
  const { ConversationReferenceLink } = await import('../../../src/renderer/components/chat/cross-conversation/ConversationReferenceLink')
  return {
    ConversationReferenceLink: (props: Parameters<typeof ConversationReferenceLink>[0]) => {
      renderedTargets.push(props.target)
      return ConversationReferenceLink(props)
    },
  }
})
vi.mock('../../../src/renderer/components/references', () => {
  const passThrough = () => () => undefined
  return {
    fileLinkHandlers: () => ({}),
    rehypeFileMentions: passThrough,
    rehypeLocalFileLinks: passThrough,
    rehypeRestoreFileLinks: passThrough,
    useFileLinkOptions: () => undefined,
    useFileMentionLinks: () => undefined,
    notifyRevealOutcome: vi.fn(),
    openCommentCardAtComposer: vi.fn(),
    openCommentCardAtTopOf: vi.fn(),
    referenceExtension: () => [],
    revealInEditor: vi.fn(),
    revealInElement: vi.fn(),
    useTextReferences: () => ({}),
  }
})
vi.mock('../../../src/renderer/hooks/useCanvasLifecycle', () => ({ useCanvasActions: () => ({}) }))
vi.mock('../../../src/renderer/components/canvas/viewers/CodeMirrorEditor', () => ({ CodeMirrorEditor: () => null }))

import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer'

const FULL_ID = '12345678-1234-4234-8234-123456789abc'

function seenTargets(content: string): unknown[] {
  renderedTargets.length = 0
  render(content)
  return [...renderedTargets]
}

function render(content: string): string {
  return renderToStaticMarkup(createElement(MarkdownRenderer, { content }))
}

describe('conversation references in chat Markdown', () => {
  for (const href of ['conv:12345678', `conv:${FULL_ID}`, `conv:${FULL_ID.toUpperCase()}`, 'conv:not-an-id', `conv:${FULL_ID}?x=1`]) {
    it(`opens ${href} inside Halo`, () => {
      const html = render(`[Open A](${href})`)
      expect(html).toContain('role="link"')
      expect(html).toContain('Open A')
      expect(html).not.toMatch(/href="conv:/i)
      expect(html).not.toContain('target="_blank"')
    })
  }

  it('hands a digital-human chat key over unchanged', () => {
    const key = 'app-chat:analyst:local:direct:7f1e2d3c-1111-4222-8333-444455556666'
    const element = renderToStaticMarkup(createElement(MarkdownRenderer, { content: `[Chat](conv:${key})` }))
    expect(element).toContain('role="link"')
    expect(element).not.toMatch(/href="conv:/i)
    expect(seenTargets(`[Chat](conv:${key})`)).toEqual([{ kind: 'full', id: key }])
  })

  it('leaves web links opening outside', () => {
    const html = render('[Web](https://example.com/a)')
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('target="_blank"')
  })
})

describe('conversation references in the Markdown preview', () => {
  it('opens short and full ids inside Halo, like chat', async () => {
    const { MarkdownViewer } = await import('../../../src/renderer/components/canvas/viewers/MarkdownViewer')
    const content = `[Short](conv:12345678) [Full](conv:${FULL_ID}) [Bad](conv:nope) [Web](https://example.com/a)`
    const tab = { id: 't1', type: 'markdown', title: 'a.md', path: '/repo/a.md', content } as never
    const html = renderToStaticMarkup(createElement(MarkdownViewer, { tab }))
    expect(html.match(/role="link"/g)).toHaveLength(3)
    expect(html).not.toMatch(/href="conv:/i)
    expect(html).toContain('href="https://example.com/a"')
  })
})
