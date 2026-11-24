import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BlackboardTask, TeamConversation, TeamDetail, TeamPendingEscalation } from '../../../src/shared/apps/team-types'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, vars?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars?.[key])) }),
}))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({
  AutomationAvatar: ({ name }: { name: string }) => createElement('span', { 'data-avatar': name }),
}))
vi.mock('../../../src/renderer/components/apps/EscalationCard', () => ({ EscalationCard: () => createElement('div', { 'data-escalation': true }) }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => content }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonModelSettings: vi.fn() }))
import { TeamTaskOverview } from '../../../src/renderer/components/team/TeamTaskOverview'
import type { TaskOverview } from '../../../src/renderer/components/team/detail/TaskBody'
import type { TaskOutput } from '../../../src/renderer/components/team/workbench/task-record'
import type { TaskActivityData } from '../../../src/renderer/components/team/workbench/useTaskActivity'

const subtask = (id: string, status: BlackboardTask['status']) => ({ id, title: `task ${id}`, status, assigneeAppId: 'a', createdByAppId: 'lead', createdAt: 1, updatedAt: 2 } as BlackboardTask)
const output = (name: string): TaskOutput => ({ entry: { name, path: `/out/${name}`, ref: name, epochId: 'e' }, at: null })

function render({ tasks, outputs = [], status = 'ready', finished = true, task = {}, roster = [], open = {}, finals = new Map(), decisions = [], onTalkTo = vi.fn() }: {
  tasks: BlackboardTask[]; outputs?: TaskOutput[]; status?: 'loading' | 'ready' | 'failed'; finished?: boolean; task?: Partial<TeamConversation>; roster?: unknown[]; open?: Record<string, boolean>
  finals?: Map<string, string>; decisions?: TeamPendingEscalation[]; onTalkTo?: (appId: string) => void
}) {
  const data = {
    tasks, activities: [], pending: decisions, participants: [], busy: [], loaded: true, failed: false, retry: vi.fn(),
    reports: { reports: [], finals, unavailable: [], loading: false },
    artifacts: { status, list: outputs.map(row => row.entry), openEntry: vi.fn(), has: () => false, open: vi.fn() },
  } as unknown as TaskActivityData
  const overview: TaskOverview = {
    progress: { members: [], counts: { done: 0, in_progress: 0, blocked: 0, pending: 0, rejected: 0 }, total: tasks.length, finished },
    stateKey: finished ? 'done' : 'running',
    lastActs: new Map(),
    outputs,
  }
  return renderToStaticMarkup(createElement(TeamTaskOverview, {
    detail: { team: { id: 't', name: 'Team', leadAppId: 'lead' }, roster } as unknown as TeamDetail,
    task: { epochId: 'e', label: 'Work', startedAt: 1, kind: 'run', ...task } as TeamConversation,
    taskSpaceId: 's', data, overview, held: { decisions, answeringId: null, setAnswering: vi.fn() }, open, setOpen: vi.fn(),
    onTalkTo, onOpenExchange: vi.fn(), onGo: vi.fn(),
  }))
}

describe('team task overview', () => {
  it('heads the page with the task, the team as its context', () => {
    const html = render({ tasks: [] })
    expect(html.indexOf('Team')).toBeLessThan(html.indexOf('<h2'))
    expect(html).toMatch(/<h2[^>]*>Work<\/h2>/)
  })
  it('keeps the outputs after the subtasks, running or finished', () => {
    for (const finished of [true, false]) {
      const html = render({ tasks: [subtask('1', 'done')], outputs: [output('report.md')], finished })
      expect(html.indexOf('aria-label="Outputs"')).toBeGreaterThan(html.indexOf('aria-label="Subtasks"'))
    }
  })
  it('answers a waiting question in place instead of leaving for the chat', () => {
    const decision = { entryId: 'q1', appId: 'a', memberName: 'Ann', question: 'Which region?', epochId: 'e', entry: { ts: 1 } } as unknown as TeamPendingEscalation
    const html = render({ tasks: [subtask('1', 'in_progress')], finished: false, decisions: [decision] })
    expect(html).toContain('Which region?')
    expect(html).toContain('>Reply</button>')
    expect(html).not.toContain('Go to reply')
  })
  it('shows who is on the work as the team scene, for team work only', () => {
    expect(render({ tasks: [subtask('1', 'in_progress')], finished: false, roster: [{ appId: 'a', memberName: 'Ann' }] })).toContain('aria-label="Team scene"')
    expect(render({ tasks: [], task: { kind: undefined } })).not.toContain('aria-label="Team scene"')
  })
  it('drops the brief when a finished task has nothing beyond its status line', () => {
    const html = render({ tasks: [subtask('1', 'done'), subtask('2', 'done')] })
    expect(html).not.toContain('data-tone')
    expect(html).not.toContain('aria-label="Outputs"')
    expect(render({ tasks: [subtask('1', 'done')], task: { finishedAt: 5, summary: 'Shipped' } })).toContain('>Shipped</p>')
  })
  it('signs the closing summary with the lead, and only that', () => {
    const roster = [{ appId: 'lead', memberName: 'Lin', isLead: true }]
    const brief = (html: string) => html.match(/<section data-tone.*?<\/section>/)?.[0] ?? ''
    const summary = brief(render({ tasks: [subtask('1', 'done')], task: { finishedAt: 5, summary: 'Shipped' }, roster }))
    expect(summary).toContain('data-avatar="Lin"')
    expect(summary).toContain('Lin’s summary')
    const tally = brief(render({ tasks: [subtask('1', 'done'), subtask('2', 'rejected')], roster }))
    expect(tally).toContain('Result')
    expect(tally).not.toContain('data-avatar')
  })
  it('falls back to the lead\'s last reply when a settled board was never closed', () => {
    const roster = [{ appId: 'lead', memberName: 'Lin', isLead: true }]
    const finals = new Map([['lead', '## Done\n**All** shipped'], ['a', 'not the lead']])
    const html = render({ tasks: [subtask('1', 'done')], roster, finals })
    expect(html).toContain('Lin’s summary')
    expect(html).toContain('>All shipped</p>')
    expect(html).not.toContain('not the lead')
    const sections = render({ tasks: [subtask('1', 'done')], roster, finals: new Map([['lead', 'Shipped the pricing table.\n\n## Pricing\nx\n\n## Advice\ny']]) })
    expect(sections).toContain('In this summary')
    expect(sections).toContain('<li class="truncate">Pricing</li><li class="truncate">Advice…</li>')
    expect(render({ tasks: [subtask('1', 'done')], roster, finals: new Map([['lead', 'Got it, thanks']]) })).not.toContain('data-tone')
  })
  it('gives work a person ended no result, neither an old closing summary nor the lead\'s last reply', () => {
    const roster = [{ appId: 'lead', memberName: 'Lin', isLead: true }]
    const finals = new Map([['lead', 'Halfway through the pricing table, still checking two vendors.']])
    const ended = { finishedAt: 5, endedManually: true }
    for (const task of [ended, { ...ended, summary: 'Shipped' }]) {
      const html = render({ tasks: [subtask('1', 'done'), subtask('2', 'in_progress')], roster, finals, task })
      expect(html).not.toContain('Lin’s summary')
      expect(html).not.toContain('Halfway through')
      expect(html).not.toContain('>Shipped</p>')
    }
  })
  it('tints a running brief by whether anything needs attention', () => {
    expect(render({ tasks: [subtask('1', 'in_progress')], finished: false })).toContain('data-tone="calm"')
    expect(render({ tasks: [subtask('1', 'blocked')], finished: false })).toContain('data-tone="error"')
  })
  it('puts the face of whoever an error is about before their name, leading to their work in the team', () => {
    const brief = render({ tasks: [subtask('1', 'blocked')], finished: false, roster: [{ appId: 'a', memberName: 'Ann' }] }).match(/<section data-tone="error".*?<\/section>/)?.[0] ?? ''
    expect(brief).toMatch(/<button[^>]*><span data-avatar="Ann"><\/span><b>Ann<\/b><\/button> ran into an error: task 1<\/p>/)
  })
  it('lays the subtasks out as the same timeline the team page shows', () => {
    const html = render({ tasks: [subtask('1', 'done'), subtask('2', 'in_progress')], finished: false, roster: [{ appId: 'a', memberName: 'Ann' }] })
    expect(html).toMatch(/Work process<span[^>]*>Subtasks 1\/2<\/span>/)
    expect(html).toContain('<ol class="pl-3">')
    expect(html).toContain('View Ann’s work')
  })
  it('keeps unknown outputs from reading as none', () => {
    expect(render({ tasks: [subtask('1', 'done')], status: 'loading' })).toContain('Loading outputs…')
    expect(render({ tasks: [subtask('1', 'done')], status: 'failed' })).toContain('Could not load outputs.')
  })
})
