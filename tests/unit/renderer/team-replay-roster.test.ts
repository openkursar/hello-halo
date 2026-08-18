/**
 * What a past run shows about the people in it.
 *
 * A replay draws the shape of work that already finished, so its members are at
 * rest — but "someone is still waiting on an answer" is not a fact about that
 * run, it is true right now. Flattening it away made the office look unblocked
 * on exactly the screen someone opens to find out what stalled.
 */

import { describe, it, expect } from 'vitest'
import { replayRoster } from '../../../src/renderer/components/team/run-history'
import type { TeamMember, RosterMember } from '../../../src/shared/apps/team-types'

const LEAD: TeamMember = {
  teamId: 't1', appId: 'app-lead', memberName: 'Lead', role: 'Lead',
  isLead: true, aiProvisioned: false, addedAt: 0,
}
const RESEARCHER: TeamMember = {
  teamId: 't1', appId: 'app-researcher', memberName: 'Researcher', role: 'R',
  isLead: false, aiProvisioned: false, addedAt: 0,
}

function live(partial: Partial<RosterMember> & { appId: string }): RosterMember {
  return {
    memberName: partial.appId, role: '', isLead: false, spaceId: null, status: 'idle',
    ...partial,
  }
}

describe('replayed run roster', () => {
  it('rests everyone who is not blocked on a person', () => {
    const roster = replayRoster([LEAD, RESEARCHER], [
      live({ appId: 'app-lead', status: 'working' }),
      live({ appId: 'app-researcher', status: 'error' }),
    ])

    expect(roster.map(m => m.status)).toEqual(['idle', 'idle'])
  })

  it('keeps an unanswered decision visible, with whose it is', () => {
    const roster = replayRoster([LEAD, RESEARCHER], [
      live({ appId: 'app-researcher', status: 'waiting_user', owner: 'Alice', sameMachine: false }),
    ])

    const researcher = roster.find(m => m.appId === 'app-researcher')!
    expect(researcher.status).toBe('waiting_user')
    // Without the ownership the statement cannot tell the reader from a teammate,
    // and ends up asking the wrong person to answer.
    expect(researcher.owner).toBe('Alice')
    expect(researcher.sameMachine).toBe(false)
  })

  it('rests a member who has since left the team', () => {
    const roster = replayRoster([RESEARCHER], [])

    expect(roster).toHaveLength(1)
    expect(roster[0].status).toBe('idle')
  })
})
