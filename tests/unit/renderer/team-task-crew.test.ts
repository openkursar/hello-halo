import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RosterMember, TeamActivity, TeamConversation, TeamDetail } from '../../../src/shared/apps/team-types'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, vars?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars?.[key])) }),
}))
import { addressedMember, capStage, isExchange, orderCrew, recentTalk, rowGroups, talkClusters, talkExpiry, talkLinks, taskCrew, TALK_WINDOW, type CrewEntry } from '../../../src/renderer/components/team/detail/crew'
import { RowCrew } from '../../../src/renderer/components/team/detail/crew-ui'
import { layoutScene, SCENE_RADIUS } from '../../../src/renderer/components/team/detail/scene-layout'

const NOW = 1_800_000_000_000
const member = (appId: string, extra: Partial<RosterMember> = {}) => ({ appId, memberName: appId.toUpperCase(), role: '', status: 'idle', ...extra }) as unknown as RosterMember
const busy = (appId: string, extra: Partial<RosterMember> = {}) => member(appId, { status: 'working', busy: [{ epochId: 'e', label: '' }], ...extra } as Partial<RosterMember>)
const detailOf = (roster: RosterMember[], extra: Partial<TeamDetail> = {}) => ({ team: { id: 't', name: 'Crew', leadAppId: 'lead' }, roster, activities: [], pendingEscalations: [], ...extra }) as unknown as TeamDetail
const task = (extra: Partial<TeamConversation> = {}) => ({ epochId: 'e', teamId: 't', kind: 'collab', label: 'Launch', startedAt: 1, lastActivityAt: NOW, ...extra }) as TeamConversation
const message = (actor: string, target: string, ago: number, extra: Partial<TeamActivity> = {}) => ({
  id: `${actor}-${target}-${ago}`, epochId: 'e', kind: 'message', actorAppId: actor, targetAppId: target, subject: 'hi', createdAt: NOW - ago, ...extra,
}) as unknown as TeamActivity
const entries = (...ids: string[]): CrewEntry[] => ids.map(appId => ({ appId, state: 'working' }))

describe('task crew', () => {
  it('counts only messages and replies between two parties as exchanges', () => {
    expect([
      message('a', 'b', 1), message('b', 'a', 2, { kind: 'reply' }), message('a', 'b', 3, { status: 'undelivered' }),
      message('a', 'a', 4), message('a', '', 5), message('a', 'b', 6, { kind: 'task_post' }), message('a', 'b', 7, { kind: 'finding' }),
    ].filter(isExchange).map(activity => activity.id)).toEqual(['a-b-1', 'b-a-2', 'a-b-3'])
  })
  it('lists members working, waiting or stopped on the task, and nobody once it is finished', () => {
    const detail = detailOf([busy('a'), busy('b', { status: 'error' }), member('c'), member('d'), member('idle')], {
      pendingEscalations: [{ appId: 'c', epochId: 'e', question: 'Ship?' }] as TeamDetail['pendingEscalations'],
      activities: [message('d', 'lead', 10, { status: 'error' })],
    })
    expect(taskCrew(detail, task({ waitingMemberAppIds: [] }))).toEqual([
      { appId: 'a', state: 'working' }, { appId: 'b', state: 'failed' }, { appId: 'c', state: 'waiting' }, { appId: 'd', state: 'failed' },
    ])
    expect(taskCrew(detail, task({ completed: true }))).toEqual([])
    expect(taskCrew(detailOf([busy('a', { presence: 'offline' } as Partial<RosterMember>)]), task())).toEqual([{ appId: 'a', state: 'offline' }])
  })

  it('counts delivered messages inside the talk window as talking, keeping one link per pair', () => {
    const recent = recentTalk([
      message('a', 'b', 1_000), message('b', 'a', 5_000), message('a', 'c', TALK_WINDOW + 1),
      message('a', 'd', 1_000, { status: 'undelivered' }), message('a', 'a', 1_000), message('x', 'b', 1_000, { kind: 'task_post' }),
    ], NOW)
    expect(recent.map(row => row.id)).toEqual(['a-b-1000', 'b-a-5000'])
    expect(talkExpiry(recent)).toBe(NOW - 5_000 + TALK_WINDOW)
    expect(talkLinks(recent, 'e', new Set(['a', 'b']))).toEqual([{ a: 'a', b: 'b', at: NOW - 1_000 }])
    expect(talkLinks(recent, 'e', new Set(['a']))).toEqual([])
    expect(talkLinks(recent, 'other', new Set(['a', 'b']))).toEqual([])
  })

  it('puts members needing the user and their partners first, keeps talkers together, and never splits a pair under the cap', () => {
    const links = [{ a: 'c', b: 'd', at: 2 }, { a: 'b', b: 'lead', at: 1 }]
    const crew: CrewEntry[] = [...entries('a', 'b', 'c'), { appId: 'd', state: 'waiting' }, ...entries('lead')]
    const ordered = orderCrew(crew, links)
    expect(ordered.map(entry => entry.appId)).toEqual(['d', 'c', 'b', 'lead', 'a'])
    expect(rowGroups(ordered, links).map(group => group.map(entry => entry.appId))).toEqual([['d', 'c'], ['b', 'lead'], ['a']])
    expect(talkClusters(['a', 'lead', 'b'], [{ a: 'a', b: 'lead', at: 1 }, { a: 'lead', b: 'b', at: 1 }])).toEqual([['a', 'lead', 'b']])

    const many = entries('lead', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
    const pairAtEdge = [{ a: 'f', b: 'g', at: 1 }]
    const { shown, hidden } = capStage(many, pairAtEdge, 'lead', 6)
    expect(shown.map(entry => entry.appId)).toEqual(['lead', 'a', 'b', 'c', 'd', 'e'])
    expect(hidden).toBe(3)
    expect(capStage(entries('lead', 'a', 'b', 'c', 'd', 'e', 'f', 'g'), [], 'lead', 6).hidden).toBe(0)
  })
})

describe('scene layout', () => {
  it('overlaps talking members in a ring, stands the rest alone, and starts at the top of the content', () => {
    const crew = entries('lead', 'a', 'b', 'c')
    const layout = layoutScene(crew, 0, [{ a: 'lead', b: 'a', at: 1 }], 'lead', 400)
    const lead = layout.faces.find(face => face.appId === 'lead')!
    const a = layout.faces.find(face => face.appId === 'a')!
    expect(lead.talking && a.talking).toBe(true)
    expect(Math.hypot(lead.x - a.x, lead.y - a.y)).toBeLessThan(SCENE_RADIUS * 2)
    expect(layout.faces.indexOf(lead)).toBeGreaterThan(layout.faces.indexOf(a))
    expect(layout.labels.map(label => label.appIds)).toEqual([['lead', 'a'], ['b'], ['c']])
    expect(Math.min(...layout.faces.map(face => face.y - SCENE_RADIUS))).toBeGreaterThanOrEqual(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('wraps rows at the stage width and shows the folded count as its own node', () => {
    const wide = layoutScene(entries('a', 'b', 'c', 'd', 'e', 'f'), 2, [], null, 600)
    const narrow = layoutScene(entries('a', 'b', 'c', 'd', 'e', 'f'), 2, [], null, 200)
    expect(new Set(wide.faces.map(face => Math.round(face.y))).size).toBeLessThan(new Set(narrow.faces.map(face => Math.round(face.y))).size)
    expect(narrow.height).toBeGreaterThan(wide.height)
    expect(wide.more?.count).toBe(2)
    expect(layoutScene([], 0, [], null, 300)).toMatchObject({ faces: [], labels: [], height: 0 })
  })

  it('staggers a working row but lines a finished team up', () => {
    const rowYs = (state: CrewEntry['state']) => new Set(layoutScene(['a', 'b', 'c', 'd'].map(appId => ({ appId, state })), 0, [], null, 600).faces.map(face => face.y)).size
    expect(rowYs('working')).toBe(2)
    expect(rowYs('done')).toBe(1)
  })

  it('writes a state under the name only when the dot cannot say it', () => {
    const lines = (state: CrewEntry['state']) => layoutScene([{ appId: 'a', state }], 0, [], null, 300).labels[0].lines
    expect([lines('working'), lines('done'), lines('waiting'), lines('failed'), lines('offline')]).toEqual([1, 1, 2, 2, 2])
  })
})

describe('row crew', () => {
  it('shows who is on the task, overlapping those talking, folding the rest into +N', () => {
    vi.useFakeTimers({ now: NOW })
    const detail = detailOf([busy('lead'), busy('a'), busy('b'), busy('c'), busy('d')])
    const recent = [message('a', 'lead', 1_000)]
    const html = renderToStaticMarkup(createElement(RowCrew, { detail, task: task(), recent, cap: 3, size: 22 }))
    expect(html).toContain('+2')
    expect(html.match(/avatar-blink/g)).toHaveLength(2)
    expect(html).toContain('A · Talking with LEAD')
    expect(html).toContain('LEAD · Talking with A')
    expect(html).toContain('D · Working')
    expect(html).toContain('5 on it now')
    expect(html).toContain('A → LEAD')
    expect(html).not.toContain('took part')
    expect(renderToStaticMarkup(createElement(RowCrew, { detail, task: task({ completed: true }), recent, cap: 3, size: 22 }))).toBe('')
    vi.useRealTimers()
  })

  it('stacks who took part: in full once finished, faded past a divider while others still work', () => {
    const roster = ['lead', 'a', 'b', 'c', 'd', 'e'].map(id => member(id))
    const done = renderToStaticMarkup(createElement(RowCrew, {
      detail: detailOf(roster), task: task({ completed: true, participantAppIds: ['lead', 'a', 'b', 'c', 'd', 'e', 'gone'] }), recent: [], cap: 3, size: 22,
    }))
    expect(done).toContain('6 took part: LEAD, A, B, C, D, E')
    expect(done).toContain('+2')
    expect(done).not.toContain('opacity-50')
    expect(done).not.toContain('GONE')

    const live = renderToStaticMarkup(createElement(RowCrew, {
      detail: detailOf([busy('lead'), member('a'), member('b')]), task: task({ participantAppIds: ['lead', 'a', 'b'] }), recent: [], cap: 3, size: 22,
    }))
    expect(live).toContain('LEAD · Working, 2 took part, free now: A, B')
    expect(live).toContain('w-px')
    expect(live).toContain('opacity-50')
  })

  it('names the teammate a question went to directly, never the lead or an IM bot', () => {
    const detail = detailOf(['lead', 'a'].map(id => member(id)))
    expect(addressedMember(detail, task({ kind: 'native', memberAppId: 'a' }))).toBe('a')
    expect(addressedMember(detail, task({ kind: 'native', memberAppId: 'lead' }))).toBeNull()
    expect(addressedMember(detail, task({ kind: 'im', memberAppId: 'a' }))).toBeNull()
    expect(addressedMember(detail, task({ kind: 'run', memberAppId: 'a' }))).toBeNull()
  })
})
