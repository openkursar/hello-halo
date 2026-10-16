import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/hooks/useCanvasLifecycle', () => ({
  useCanvasActions: () => ({ openChanges: vi.fn() }),
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values?.[key] ?? key)),
    i18n: { language: 'en' },
  }),
}))

import { FileChangesFooter } from '../../../src/renderer/components/diff/FileChangesFooter'

const summary = {
  edited: [{ file: 'a.ts', added: 85, removed: 51 }],
  created: [], totalFiles: 1, totalAdded: 85, totalRemoved: 51,
}
const read = (name: string) => readFileSync(resolve('src/renderer/components/chat', name), 'utf8')

describe('reply changes entry', () => {
  it('keeps the summary but disables navigation without a reply target', () => {
    const html = renderToStaticMarkup(React.createElement(FileChangesFooter, { fileChangesSummary: summary }))
    expect(html).toContain('Changed 1 files')
    expect(html).toContain('+85')
    expect(html).toContain('−51')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('View changes')
  })

  it('preserves the space reply entry', () => {
    const html = renderToStaticMarkup(React.createElement(FileChangesFooter, {
      fileChangesSummary: summary,
      reply: { spaceId: 'space', conversationId: 'conversation', messageId: 'reply', timestamp: '2026-10-10T11:32:00Z' },
    }))
    expect(html).toContain('View changes')
    expect(html).not.toContain('disabled=""')
  })

  it('requires explicit surface opt-in even when the space store has an active conversation', () => {
    expect(read('MessageItem.tsx')).toContain('allowViewChanges = false')
    expect(read('MessageItem.tsx')).toContain('allowViewChanges && currentSpaceId && currentConversationId')
    expect(read('MessageRow.tsx')).toContain('allowViewChanges = false')
    expect(read('MessageRow.tsx').match(/allowViewChanges=\{allowViewChanges\}/g)).toHaveLength(3)
    expect(read('MessageList.tsx')).toContain('allowViewChanges = false')
    expect(read('MessageList.tsx')).toContain('allowViewChanges={allowViewChanges}')
    expect(read('MessageList.tsx')).toContain('hideTerminalOpen, allowViewChanges, rowKeys')
    expect(read('ChatView.tsx')).toMatch(/<MessageList[\s\S]*?\n\s+allowViewChanges\n/)
  })
})
