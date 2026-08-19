/**
 * Unit tests for the agent-facing board rendering.
 *
 * Two properties carry the whole design and are pinned here: the compression is
 * lossless (long text is reflowed, never cut), and a bounded read SAYS it is
 * bounded. The second one is the bug this replaced — a silent cut let an agent
 * mistake its window for the whole record and conclude that work nobody could
 * see had never been done.
 */

import { describe, it, expect } from 'vitest'

import { renderBoardMarkdown } from '../../../../../src/main/apps/runtime/team/board-render'
import type {
  BlackboardSnapshot,
  BlackboardTask,
  TeamActivity,
} from '../../../../../src/shared/apps/team-types'

const NOW = 1_700_000_000_000
const LEAD_APP = 'app-lead'
const RESEARCHER_APP = 'app-researcher'

function snapshot(overrides: Partial<BlackboardSnapshot> = {}): BlackboardSnapshot {
  return {
    tasks: [],
    findings: [],
    checks: [],
    activities: [],
    roster: [
      {
        appId: LEAD_APP,
        memberName: 'lead',
        role: 'Lead',
        isLead: true,
        spaceId: null,
        status: 'idle',
        sameMachine: true,
        presence: 'online',
      },
      {
        appId: RESEARCHER_APP,
        memberName: 'researcher',
        role: 'Research',
        isLead: false,
        spaceId: null,
        status: 'working',
        sameMachine: false,
        owner: 'alice',
        presence: 'offline',
      },
    ],
    ...overrides,
  }
}

function task(overrides: Partial<BlackboardTask> = {}): BlackboardTask {
  return {
    id: 'task-1',
    teamId: 'team-1',
    epochId: 'epoch-1',
    title: 'Scrape competitors',
    assigneeAppId: RESEARCHER_APP,
    status: 'in_progress',
    resultRef: null,
    note: null,
    parentId: null,
    createdByAppId: LEAD_APP,
    createdAt: NOW - 3 * 60 * 60 * 1000,
    updatedAt: NOW - 5 * 60 * 1000,
    ...overrides,
  }
}

function act(overrides: Partial<TeamActivity> = {}): TeamActivity {
  return {
    id: 'a-1',
    teamId: 'team-1',
    epochId: 'epoch-1',
    kind: 'message',
    actorAppId: LEAD_APP,
    targetAppId: RESEARCHER_APP,
    subject: 'Do task T1',
    body: null,
    refId: null,
    correlationId: null,
    status: 'sent',
    createdAt: NOW - 2 * 60 * 1000,
    ...overrides,
  }
}

describe('board rendering', () => {
  it('names members instead of app ids, since names are what every tool takes', () => {
    const out = renderBoardMarkdown(snapshot({ tasks: [task()] }), { now: NOW })

    expect(out).toContain('| researcher |')
    // An app id in the output is a dead end: no tool accepts one and nothing
    // maps it back to a name for the reader.
    expect(out).not.toContain(RESEARCHER_APP)
    expect(out).not.toContain(LEAD_APP)
  })

  it('keeps the task id verbatim — updating a task needs it exactly', () => {
    const out = renderBoardMarkdown(snapshot({ tasks: [task({ id: 'e8f1-abc' })] }), { now: NOW })
    expect(out).toContain('e8f1-abc')
  })

  it('reflows long text onto one line without cutting any of it', () => {
    const note = 'blocked on\nthe upstream export\nwhich has not landed'
    const out = renderBoardMarkdown(snapshot({ tasks: [task({ status: 'blocked', note })] }), { now: NOW })

    expect(out).toContain('blocked on the upstream export which has not landed')
  })

  it('escapes a pipe so one field cannot break the table into fake columns', () => {
    const out = renderBoardMarkdown(snapshot({ tasks: [task({ title: 'a | b' })] }), { now: NOW })
    expect(out).toContain('a \\| b')
  })

  it('prints empty sections rather than omitting them', () => {
    // A missing heading reads as "not included in this view", which is a
    // different claim from "there is none".
    const out = renderBoardMarkdown(snapshot(), { now: NOW })

    expect(out).toContain('## Tasks\nNone.')
    expect(out).toContain('## Findings\nNone.')
    expect(out).toContain('## Periodic checks\nNone.')
  })

  it('keeps a finding body intact, paragraphs and all', () => {
    const body = 'Competitor X dropped prices 20%.\n\nSource: their pricing page.'
    const out = renderBoardMarkdown(
      snapshot({
        findings: [
          {
            id: 'f-1',
            teamId: 'team-1',
            epochId: 'epoch-1',
            authorAppId: RESEARCHER_APP,
            body,
            ref: 'competitors.md',
            createdAt: NOW - 60 * 60 * 1000,
          },
        ],
      }),
      { now: NOW }
    )

    expect(out).toContain('Competitor X dropped prices 20%.')
    expect(out).toContain('Source: their pricing page.')
    expect(out).toContain('file: competitors.md')
  })

  it('says which machine a teammate runs on, so a bare path is not assumed readable', () => {
    const out = renderBoardMarkdown(snapshot(), { now: NOW })

    expect(out).toMatch(/researcher \|.*\| offline \| alice's \|/)
    expect(out).toMatch(/lead \(lead\) \|.*\| online \| yours \|/)
  })

  describe('a bounded history read', () => {
    const activities = [act({ id: 'a-1' }), act({ id: 'a-2', kind: 'finding', subject: 'notes.md' })]

    it('states the total, the gap, and where the rest is', () => {
      const out = renderBoardMarkdown(snapshot({ activities }), {
        now: NOW,
        history: { total: 340, path: '/tmp/halo-team-board/team-x.md' },
      })

      expect(out).toContain('the latest 2 of 340')
      expect(out).toContain('The 338 earlier entries are NOT above')
      expect(out).toContain('/tmp/halo-team-board/team-x.md')
      // The warning is the point: absence in this view is not evidence.
      expect(out).toContain('before concluding that something was never done')
    })

    it('still reports the gap when the export could not be written', () => {
      const out = renderBoardMarkdown(snapshot({ activities }), {
        now: NOW,
        history: { total: 40, path: null },
      })

      expect(out).toContain('38 earlier entries')
      expect(out).toContain('could not be exported')
    })

    it('says nothing about a gap when there is none', () => {
      const out = renderBoardMarkdown(snapshot({ activities }), {
        now: NOW,
        history: { total: 2, path: '/tmp/halo-team-board/team-x.md' },
      })

      expect(out).toContain('## Recent activity (2)')
      expect(out).not.toContain('earlier entries')
      expect(out).not.toContain('/tmp/halo-team-board/team-x.md')
    })
  })
})
