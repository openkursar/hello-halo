import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/i18n', async (importOriginal) => ({
  ...await importOriginal<object>(),
  useTranslation: () => ({ t: (text: string, values: Record<string, unknown> = {}) => text.replace(/\{\{(\w+)\}\}/g, (_match, key) => String(values[key])) }),
}))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/components/apps/EscalationCard', () => ({ EscalationCard: () => null }))
vi.mock('../../../src/renderer/components/chat/MessageRow', () => ({ MessageRow: ({ message }: any) => createElement('p', { 'data-row': message.role }, message.content) }))

import { TaskConversation } from '../../../src/renderer/components/team/workbench/TaskConversation'

const detail: any = { team: { id: 'team' }, roster: [{ appId: 'lead', memberName: 'Lead' }, { appId: 'writer', memberName: 'Writer' }] }
const activity = (id: string, actorAppId: string, targetAppId: string, at: number) =>
  ({ id, teamId: 'team', epochId: 'epoch', kind: 'message', actorAppId, targetAppId, subject: `${id} text`, createdAt: at }) as any

describe('homepage collaboration without a reply to carry it', () => {
  it('reads as the member’s received and sent lines, in order, never a segment card', () => {
    const html = renderToStaticMarkup(createElement(TaskConversation, {
      messages: [{ id: 'ask', role: 'user', content: 'Any tasks?', timestamp: new Date(5000).toISOString() } as any],
      activities: [activity('report', 'writer', 'lead', 1000), activity('ask-writer', 'lead', 'writer', 2000), activity('ask-again', 'lead', 'writer', 3000)],
      epochId: 'epoch', appId: 'lead', detail, showEmpty: false, onActivity: () => {}, homepageConversation: true,
    }))
    expect(html).not.toContain('collaboration messages')
    expect(html).toContain('Received a message from Writer')
    expect(html).toContain('Sent a message to Writer')
    expect(html.indexOf('Received a message from Writer')).toBeLessThan(html.indexOf('Sent a message to Writer'))
    expect(html.indexOf('Sent a message to Writer')).toBeLessThan(html.indexOf('Any tasks?'))
  })
})
