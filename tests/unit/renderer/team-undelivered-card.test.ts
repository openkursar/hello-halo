/**
 * What a person reads about a team message that did not arrive: who it was for,
 * what that member's computer is doing now and what can be done — never the
 * system's generic English line, and never "a reply" from a member that never
 * received anything.
 */

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => createElement('div', { className: 'markdown' }, content),
}))

import { TaskActivityTimeline } from '../../../src/renderer/components/team/workbench/TaskActivityTimeline'
import { UndeliveredNote } from '../../../src/renderer/components/team/workbench/UndeliveredNote'
import type { RosterMember, TeamActivity, TeamDetail } from '../../../src/shared/apps/team-types'

const member = (appId: string, memberName: string, patch: Partial<RosterMember> = {}): RosterMember =>
  ({ appId, memberName, role: '', isLead: false, spaceId: null, status: 'idle', sameMachine: true, presence: 'online', ...patch })

const design = member('design', 'Solution Design', { sameMachine: false, owner: 'Jane', presence: 'online' })
const requirements = member('requirements', 'Requirements')
const detail = { roster: [design, requirements] } as unknown as TeamDetail

const fate: TeamActivity = {
  id: 'fate', teamId: 'team', epochId: 'task', kind: 'reply', actorAppId: 'design', targetAppId: 'requirements',
  subject: 'The message was not delivered (the member is offline or unreachable). Reassign …', body: null, refId: null,
  correlationId: 'c-1', status: 'undelivered', createdAt: 1000,
}

function card(activities: TeamActivity[], roster = detail.roster, taskCompleted = false): string {
  return renderToStaticMarkup(createElement(TaskActivityTimeline, {
    messages: [], activities, detail: { roster } as unknown as TeamDetail, showEmpty: false, openArtifact: () => {}, taskCompleted,
  }))
}

describe('a team message that did not arrive', () => {
  it('reads as the message it was, sender to recipient, with actions and expandable delivery evidence', () => {
    const html = card([fate])
    expect(html.indexOf('Requirements')).toBeLessThan(html.indexOf('Solution Design'))
    expect(html).toContain('>Message<')
    expect(html).not.toContain('>Reply<')
    expect(html).toContain('Not delivered')
    expect(html).toContain('Solution Design did not receive this message. Send it again, or assign the work to another member.')
    expect(html).toContain('Details')
    expect(html).toContain('offline or unreachable')
  })

  it('says whose computer is offline, and when it can be sent again', () => {
    const html = card([fate], [{ ...design, presence: 'offline' }, requirements])
    expect(html).toContain('Solution Design did not receive this message. Jane’s computer is offline right now; once it is back online, send it again, or assign the work to another member.')
  })

  it('keeps what was sent when the record is the message itself', () => {
    const html = card([{ ...fate, kind: 'message', actorAppId: 'requirements', targetAppId: 'design', subject: 'Start the design', body: 'Start the design for the new release' }])
    expect(html).toContain('Start the design for the new release')
    expect(html).toContain('Solution Design did not receive this message.')
  })

  it('asks for nothing once the task is closed', () => {
    const html = card([fate], detail.roster, true)
    expect(html).toContain('Solution Design did not receive this message.<')
    expect(html).not.toContain('sent again')
  })
})

describe('UndeliveredNote', () => {
  const render = (recipient: RosterMember | undefined) => renderToStaticMarkup(createElement(UndeliveredNote, { recipient }))

  it('offers sending again or another member for a member on this computer', () => {
    expect(render(requirements)).toContain('Requirements did not receive this message. Send it again, or assign the work to another member.')
  })

  it('stays truthful about a member no longer in the team', () => {
    expect(render(undefined)).toContain('This message was not delivered.')
  })
})
