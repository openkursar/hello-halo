import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TeamConversation, TeamDetail } from '../../../src/shared/apps/team-types'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, vars?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars?.[key])) }),
}))
import { TaskRow, taskTitle } from '../../../src/renderer/components/team/detail/task-ui'

const t = ((text: string) => text) as never
const detail = { team: { id: 't', name: 'Crew' }, roster: [], activities: [], pendingEscalations: [] } as unknown as TeamDetail
const task = (extra: Partial<TeamConversation> = {}) => ({
  epochId: 'e', teamId: 't', kind: 'chat', label: 'Plan launch', readonly: false, startedAt: 1, lastActivityAt: Date.now(), ...extra,
} as TeamConversation)
const row = (extra: Partial<TeamConversation>) => renderToStaticMarkup(createElement(TaskRow, { detail, task: task(extra), onOpen: vi.fn() }))

describe('task row', () => {
  it('names a run by its summary, else by the team goal and its start, never by the team name again', () => {
    const first = taskTitle(detail, task({ kind: 'run', label: 'Crew', startedAt: new Date(2026, 10, 16, 9, 0).getTime() }), t)
    const second = taskTitle(detail, task({ kind: 'run', label: 'Crew', startedAt: new Date(2026, 10, 17, 22, 0).getTime() }), t)
    expect(first).toMatch(/^Work toward the team goal · .+/)
    expect(first).not.toBe(second)
    expect(taskTitle(detail, task({ kind: 'run', label: 'Crew', summary: 'Shipped the brief' }), t)).toBe('Shipped the brief')
    expect(taskTitle(detail, task({ kind: 'run', label: 'Weekly report' }), t)).toBe('Weekly report')
  })

  it('counts finished work by its outputs, subtasks only when it left none, and leaves the finished state to the dot', () => {
    const html = row({ completed: true, artifactCount: 3, subtasks: { done: 2, open: 0 } })
    expect(html).toContain('3 outputs')
    expect(html).not.toContain('2/2 subtasks')
    expect(row({ completed: true, subtasks: { done: 2, open: 0 } })).toContain('2/2 subtasks')
    expect(row({ active: true, artifactCount: 1, subtasks: { done: 1, open: 1 } })).toMatch(/1 outputs · 1\/2 subtasks/)
    expect(html).toContain('<span class="sr-only">Completed · </span>')
    expect(html.match(/Completed/g)).toHaveLength(1)
  })

  it('keeps the time in a column of its own beside the line on wider screens', () => {
    expect(row({ completed: true, artifactCount: 3 })).toMatch(/<span class="hidden [^"]*sm:block">just now<\/span><\/button>$/)
  })

  it('leads with a check once done, a spinner while running and a dot otherwise', () => {
    expect(row({ completed: true })).toContain('<path d="M3 8.5l3 3 7-7"')
    expect(row({ active: true })).toContain('animate-spin')
    const idle = row({})
    expect(idle).not.toContain('animate-spin')
    expect(idle).not.toContain('<svg')
  })

  it('does not repeat a summary that already titles the row', () => {
    const html = row({ kind: 'run', label: 'Crew', completed: true, summary: 'Shipped the brief' })
    expect(html.match(/Shipped the brief/g)).toHaveLength(1)
    expect(html).not.toContain('Run manually')
    expect(row({ kind: 'run', label: 'Crew', triggerType: 'schedule' })).toContain('Run on schedule')
  })
})
