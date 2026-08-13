/**
 * Unit tests for runtime/team/team-prompt — the IM front-desk bridge fragment.
 *
 * buildTeamImBridge is the Entry overlay used when a team LEAD serves an IM
 * channel (a team-backed IM instance). It must override the base team Entry's
 * "delivered by the runtime, not a human" framing: the message is from a real
 * person and the lead replies straight back to them in-chat.
 */

import { describe, it, expect } from 'vitest'
import {
  buildTeamImBridge,
  buildTeamEntry,
  buildTeamConstraints,
  type TeamPromptContext,
  type TeamPromptRosterEntry,
} from '../../../../../src/main/apps/runtime/team/team-prompt'

function makeCtx(overrides: Partial<TeamPromptContext> = {}): TeamPromptContext {
  return {
    teamName: 'Weekly Brief',
    goal: 'Produce the competitor brief',
    collabMode: 'free',
    escalationRouting: 'lead',
    selfMemberName: 'lead',
    selfRole: 'Lead',
    selfIsLead: true,
    roster: [],
    ...overrides,
  }
}

const localMate: TeamPromptRosterEntry = {
  memberName: 'researcher',
  role: 'Research',
  isLead: false,
  contactable: true,
  owner: null,
  sameMachine: true,
}
const remoteMate: TeamPromptRosterEntry = {
  memberName: 'analyst',
  role: 'Analyst',
  isLead: false,
  contactable: true,
  owner: 'Bob',
  sameMachine: false,
}

describe('buildTeamImBridge', () => {
  const im = { channel: 'wecom-bot', displayName: 'Acme Sales Group', chatType: 'group' as const }

  it('frames the lead as the team front desk for the person', () => {
    const out = buildTeamImBridge(im)
    expect(out).toContain('Front Desk')
    expect(out).toContain('wecom-bot')
    expect(out).toContain('Acme Sales Group')
    expect(out).toContain('group')
    // Explicitly corrects the base team Entry framing.
    expect(out).toContain('NOT by the team runtime')
  })

  it('tells the lead its final message is the reply (no tool needed)', () => {
    const out = buildTeamImBridge(im)
    expect(out).toContain('final message')
    expect(out.toLowerCase()).toContain('do not call any tool to reply')
  })

  it('steers delegation toward wait=true so results land within the turn', () => {
    const out = buildTeamImBridge(im)
    expect(out).toContain('team_send')
    expect(out).toContain('wait=true')
    expect(out).toContain('wait=false')
  })

  it('reflects a direct chat type', () => {
    const out = buildTeamImBridge({ channel: 'weixin-ilink-bot', displayName: 'Jane', chatType: 'direct' })
    expect(out).toContain('direct')
    expect(out).toContain('Jane')
  })
})

describe('buildTeamEntry — no per-turn content', () => {
  // The Entry is baked into the session's system prompt, which is part of the
  // agent session's reuse fingerprint. Anything that changes per turn rebuilds
  // the subprocess on every turn and kills the one still streaming.
  it('says nothing about who started this turn or whether they are waiting', () => {
    const out = buildTeamEntry(makeCtx({ roster: [localMate] }))
    expect(out).not.toContain('This turn was started by')
    expect(out).not.toContain('waiting for your reply')
  })
})

describe('buildTeamEntry roster — cross-machine awareness', () => {
  it('labels a remote teammate with its owner and adds the cross-machine section', () => {
    const out = buildTeamEntry(makeCtx({ roster: [localMate, remoteMate] }))
    // Remote teammate is labelled by owner; local teammate is not.
    expect(out).toContain('analyst')
    expect(out).toContain('Bob')
    expect(out).toContain('Working across machines')
    // The file-locality rule (the concrete cross-machine failure mode) is present.
    expect(out).toContain('team_read_artifact')
    expect(out.toLowerCase()).toContain('do not cross machines')
  })

  it('omits the cross-machine section for a purely single-machine team', () => {
    const out = buildTeamEntry(makeCtx({ roster: [localMate] }))
    expect(out).not.toContain('Working across machines')
    // A same-machine teammate carries no owner label.
    expect(out).not.toContain('digital human')
  })
})

describe('buildTeamConstraints — dispatch + side-effect discipline', () => {
  it('always includes side-effect safety guidance', () => {
    const out = buildTeamConstraints(makeCtx({ selfIsLead: false })).join('\n')
    expect(out).toContain('Side-effect safety')
    // A "not delivered" receipt must not be treated as "redo the action".
    expect(out.toLowerCase()).toContain('coordination failure to retry')
  })

  it('adds presence-aware dispatch guidance only for the lead', () => {
    const leadOut = buildTeamConstraints(makeCtx({ selfIsLead: true })).join('\n')
    expect(leadOut.toLowerCase()).toContain('presence')
    expect(leadOut).toContain('reassign')

    const memberOut = buildTeamConstraints(makeCtx({ selfIsLead: false })).join('\n')
    expect(memberOut).not.toContain('Dispatch to who is available')
  })
})

describe('team duty in the prompt', () => {
  it('tells a member what it is responsible for in this team', () => {
    const entry = buildTeamEntry(makeCtx({ selfDuty: 'You do the coding.\nTell Code Review when done.' }))

    expect(entry).toContain('What you are responsible for here')
    expect(entry).toContain('You do the coding.')
    expect(entry).toContain('Tell Code Review when done.')
  })

  it('says nothing about a duty that has not been written', () => {
    expect(buildTeamEntry(makeCtx())).not.toContain('What you are responsible for here')
    expect(buildTeamEntry(makeCtx({ selfDuty: '   ' }))).not.toContain('What you are responsible for here')
  })

  it('carries a teammate’s duty in full so work can be handed to the right one', () => {
    const entry = buildTeamEntry(makeCtx({
      roster: [{ ...localMate, duty: 'You review code and reject what is not ready.' }],
    }))

    expect(entry).toContain('- researcher — Research')
    expect(entry).toContain('You review code and reject what is not ready.')
  })

  it('leaves the roster line alone for a teammate with no duty written', () => {
    const entry = buildTeamEntry(makeCtx({ roster: [localMate] }))
    expect(entry).toContain('- researcher — Research')
  })
})
