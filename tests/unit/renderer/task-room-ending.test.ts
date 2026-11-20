/**
 * In a team task room, a reply stopped a moment ago is spoken for once: by the
 * room's interruption notice while it is on screen, by the reply's own note
 * otherwise — as in an ordinary conversation.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../src/renderer/types'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (value: string) => value }), getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/components/chat/MessageRow', () => ({
  MessageRow: ({ message, endingShownBelow }: { message: Message; endingShownBelow?: boolean }) =>
    createElement('article', { 'data-id': message.id, 'data-ending-below': String(!!endingShownBelow) }),
}))
vi.mock('../../../src/renderer/components/apps/EscalationCard', () => ({ EscalationCard: () => null }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/components/chat/InjectionAnnotation', () => ({ InjectionAnnotation: () => null }))
vi.mock('../../../src/renderer/components/chat/team-collab', () => ({ DispatchLine: () => null, OpenersLine: () => null }))

import { TaskConversation } from '../../../src/renderer/components/team/workbench/TaskConversation'

const at = (n: number) => new Date(Date.UTC(2026, 10, 19, 9, 0, n)).toISOString()
const messages: Message[] = [
  { id: 'ask', role: 'user', content: 'Draft the plan', timestamp: at(1) },
  { id: 'reply', role: 'assistant', content: 'Half of the pl', timestamp: at(2), metadata: { ending: 'stopped' } },
]
const room = (endingShownBelow?: string) => renderToStaticMarkup(createElement(TaskConversation, {
  messages, activities: [], epochId: 'epoch', appId: 'member', detail: { team: { id: 'team', name: 'Crew' }, members: [], roster: [] } as never,
  showEmpty: false, onActivity: () => {}, endingShownBelow,
}))

describe('a stopped reply in a task room', () => {
  it('leaves its ending to the room’s notice while that is shown', () => {
    expect(room('reply')).toContain('data-id="reply" data-ending-below="true"')
  })

  it('states its ending itself otherwise', () => {
    expect(room()).toContain('data-id="reply" data-ending-below="false"')
  })
})
