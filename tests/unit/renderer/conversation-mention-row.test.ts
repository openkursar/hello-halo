/**
 * A conversation candidate in the composer's @ menu: a digital-human chat whose
 * collaboration is off stays visible, greyed and labelled, instead of vanishing.
 */

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/components/pulse', () => ({ TaskStatusDot: () => null }))
vi.mock('../../../src/renderer/utils/format-time', () => ({ formatTimeAgo: () => '1m ago' }))

import { ConversationMentionRow } from '../../../src/renderer/components/chat/cross-conversation/ConversationMentionRow'

const candidate = {
  id: 'app-chat:app-1',
  title: 'Analyst',
  summary: '',
  updatedAt: new Date(0).toISOString(),
  status: 'idle' as const,
  digitalHuman: 'Analyst',
}

describe('ConversationMentionRow', () => {
  it('greys out and labels a chat whose digital human has collaboration off', () => {
    const html = renderToStaticMarkup(createElement(ConversationMentionRow, { candidate: { ...candidate, unavailable: true } }))
    expect(html).toContain('Collab not enabled')
    expect(html).toContain('opacity-50')
  })

  it('shows a reachable chat plainly', () => {
    const html = renderToStaticMarkup(createElement(ConversationMentionRow, { candidate }))
    expect(html).not.toContain('Collab not enabled')
    expect(html).not.toContain('opacity-50')
  })
})
