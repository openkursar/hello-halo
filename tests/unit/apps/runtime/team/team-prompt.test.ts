/** Stable team context and IM responsibilities across human and teammate wakes. */

import { describe, it, expect } from 'vitest'
import {
  buildRestrictionNotice,
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
    selfIsDisposable: false,
    roster: [],
    teamFolder: null,
    chatKey: null,
    ...overrides,
  }
}

const localMate: TeamPromptRosterEntry = {
  appId: 'app-researcher',
  memberName: 'researcher',
  role: 'Research',
  isLead: false,
  contactable: true,
  owner: null,
  sameMachine: true,
}
const remoteMate: TeamPromptRosterEntry = {
  appId: 'app-analyst',
  memberName: 'analyst',
  role: 'Analyst',
  isLead: false,
  contactable: true,
  owner: 'Bob',
  sameMachine: false,
}

describe('buildTeamImBridge', () => {
  const im = { channel: 'wecom-bot', displayName: 'Acme Sales Group', chatType: 'group' as const }

  it('frames the lead as the stable team front desk', () => {
    const out = buildTeamImBridge(im, true)
    expect(out).toContain('### Team replies')
    expect(out).toContain('team’s front desk')
    expect(out).toContain('single point of contact')
  })

  it('lets a directly addressed member handle its own remit', () => {
    const out = buildTeamImBridge(im, false)
    expect(out).not.toContain('front desk')
    expect(out).not.toContain('single point of contact')
    expect(out).toContain('People can address you directly')
    expect(out).toContain('do not route everything through the lead')
  })

  it.each([true, false])('keeps channel delivery distinct from teammate replies (isLead=%s)', (isLead) => {
    const out = buildTeamImBridge(im, isLead)
    const communication = buildTeamEntry(makeCtx({ selfIsLead: isLead }))
    expect(communication).toContain('final reply is not a team message')
    expect(communication).toContain('actual requester with `team_send(to, message)`')
    expect(out).not.toContain('team_send')
    expect(out).not.toContain('This turn was started')
    expect(out).not.toContain('Only the text you write after your last tool call')
    expect(out).not.toContain('Acme Sales Group')
  })

  it.each([true, false])('distinguishes live replies from different-permission continuations (isLead=%s)', (isLead) => {
    const out = buildTeamImBridge(im, isLead)
    const communication = buildTeamEntry(makeCtx({ selfIsLead: isLead }))
    expect(communication).toContain('Permission-compatible\n  messages reach you after your current tool call')
    expect(communication).toContain('different permissions run in a separate turn')
    expect(out).toContain('pending when you end')
    expect(out).toContain('answer when the result arrives')
    expect(out).toContain('Never invent or promise an unheard result')
    expect(out).toContain('Keep internal team chatter out')
    expect(out).not.toContain('wait=true')
    expect(out).not.toContain('wait=false')
    expect(out).not.toContain('Two short messages')
  })

  it('leaves session metadata to the channel fragment', () => {
    expect(buildTeamImBridge({ channel: 'weixin-ilink-bot', displayName: 'Jane', chatType: 'direct' }, true))
      .toBe(buildTeamImBridge(im, true))
  })
})

describe('buildTeamEntry — no per-turn content', () => {
  it('uses one lead address even when an existing source has the old stored name', () => {
    const context = makeCtx({ collabMode: 'structured', selfIsLead: false, selfMemberName: 'Alice', roster: [
      { ...localMate, appId: 'source', memberName: 'coordinator', role: '', isLead: true },
      { ...localMate, appId: 'other', memberName: 'lead' },
    ] })
    const out = buildTeamEntry(context)
    expect(out).toContain('to="lead"')
    expect(out).toContain('to="other"')
    expect(out).toContain('actual requester')
    expect(out).not.toContain('coordinator')
    expect(buildTeamConstraints(context).join('\n')).not.toContain('coordinator')
  })

  it('omits absent and temporary goals while describing the available collaboration protocol', () => {
    const noGoal = buildTeamEntry(makeCtx({ goal: '' }))
    expect(noGoal).not.toContain('### Standing Team Goal')
    expect(noGoal).toContain('spawn_agent')
    expect(noGoal).toContain('No team-completion tool call is required')
    expect(noGoal).toContain('Temporary collaborators')
    expect(noGoal).toContain('With one collaborator')
    const temporary = buildTeamEntry(makeCtx({ temporaryCollaboration: true, goal: 'Historical temporary goal' }))
    expect(temporary).not.toContain('Historical temporary goal')
    expect(temporary).not.toContain('member of the standing team')
    expect(buildTeamEntry(makeCtx())).toContain('Produce the competitor brief')
  })

  // The Entry is baked into the session's system prompt, which is part of the
  // agent session's reuse fingerprint. Anything that changes per turn rebuilds
  // the subprocess on every turn and kills the one still streaming.
  it('says nothing about who started this turn or whether they are waiting', () => {
    const out = buildTeamEntry(makeCtx({ roster: [localMate] }))
    expect(out).not.toContain('This turn was started by')
    expect(out).not.toContain('waiting for your reply')
  })

  // app-chat reads selfIsDisposable directly; if it leaked into the prompt too,
  // the two turns would differ and rebuild the session for no reason the
  // teammate should see.
  it('never mentions whether the member is disposable', () => {
    const ctx = makeCtx({ roster: [localMate] })
    const disposable = buildTeamEntry({ ...ctx, selfIsDisposable: true })
    expect(disposable).toBe(buildTeamEntry(ctx))
    expect(buildTeamConstraints({ ...ctx, selfIsDisposable: true }))
      .toEqual(buildTeamConstraints(ctx))
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
  it.each(['lead', 'user'] as const)('names the actual escalation tool and message payload (%s routing)', (escalationRouting) => {
    const context = makeCtx({ escalationRouting })
    const prompt = [buildTeamEntry(context), ...buildTeamConstraints(context)].join('\n')
    expect(prompt).toContain('report_to_user({type:"escalation", message:"Your question"')
    expect(prompt).not.toContain('`report(')
    expect(prompt).not.toContain('content, choices')
  })

  it('distinguishes compatible live input from separately authorized turns', () => {
    const prompt = buildTeamEntry(makeCtx())
    expect(prompt).toContain('Permission-compatible\n  messages reach you after your current tool call')
    expect(prompt).toContain('Messages with different permissions run in a separate turn after this one.')
  })

  it('keeps delivery, delegation, board and ending contracts in a bounded generated entry', () => {
    const out = buildTeamEntry(makeCtx())
    expect(out.length).toBeLessThan(4400)
    for (const rule of [
      'actual requester', 'Human conversations with your owner are private',
      'at most 500 characters', 'independent notification', 'Do not poll',
      'Posting a task does not dispatch it', 'separate history', 'self-contained context',
      'permitted actions and required evidence', 'Findings are reusable knowledge',
      'Publishing does not notify', 'silence proves nothing',
    ]) expect(out).toContain(rule)
  })

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
  it.each([undefined, '', '   ', 'Different self responsibility.'])('preserves roster duty when self duty is %s', (selfDuty) => {
    const entry = buildTeamEntry(makeCtx({
      selfIsLead: false, selfMemberName: 'researcher', selfDuty,
      roster: [{ ...localMate, duty: 'Full roster responsibility.' }],
    }))
    expect(entry).toContain('Full roster responsibility.')
    if (selfDuty?.trim()) expect(entry).toContain(selfDuty)
  })

  it('deduplicates only matching trimmed self duty', () => {
    const entry = buildTeamEntry(makeCtx({
      selfIsLead: false, selfMemberName: 'researcher', selfDuty: '  Same responsibility.\n',
      roster: [{ ...localMate, duty: '\nSame responsibility.  ' }],
    }))
    expect(entry.split('Same responsibility.')).toHaveLength(2)
  })

  it.each([true, false])('quotes full owner Markdown and states self duty only once (lead=%s)', (selfIsLead) => {
    const duty = '# Review\n\n- Keep every detail\n' + 'Long responsibility. '.repeat(100)
    const goal = '## Goal\n\nKeep the full goal.'
    const entry = buildTeamEntry(makeCtx({
      selfIsLead, selfMemberName: 'reviewer', selfDuty: duty, goal,
      roster: [{ ...localMate, memberName: 'reviewer', isLead: selfIsLead, duty }],
    }))
    expect(entry).toContain('> # Review\n> \n> - Keep every detail')
    expect(entry).toContain('> ## Goal\n> \n> Keep the full goal.')
    expect(entry.split('Long responsibility.').length - 1).toBe(100)
    expect(entry).toContain('## Team work')
    expect(entry).toContain('## Team communication')
    expect(entry).not.toContain('## Team Session Context')
    expect(buildTeamConstraints(makeCtx())[0]).toMatch(/^### Team\n/)
  })

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

describe('what a teammate IS, alongside what it does here', () => {
  it('carries the digital human’s own description so a blank duty still says something', () => {
    const entry = buildTeamEntry(makeCtx({
      roster: [{ ...localMate, description: 'Searches the web and writes sourced summaries.' }],
    }))

    expect(entry).toContain('Searches the web and writes sourced summaries.')
    // Alone there is nothing to tell it apart from, so it costs no label.
    expect(entry).not.toContain('About:')
  })

  it('labels both when both are present, so they cannot read as one paragraph', () => {
    const entry = buildTeamEntry(makeCtx({
      roster: [{
        ...localMate,
        description: 'Searches the web and writes sourced summaries.',
        duty: 'You gather the competitor pricing.',
      }],
    }))

    expect(entry).toContain('About: Searches the web and writes sourced summaries.')
    expect(entry).toContain('Duty here: You gather the competitor pricing.')
  })

  it('writes no line at all when the owner described nothing', () => {
    // The roster head is the whole entry — no stray blank or orphan label.
    const entry = buildTeamEntry(makeCtx({ roster: [{ ...localMate, description: '   ' }] }))
    expect(entry).toContain('- researcher — Research')
    expect(entry).not.toContain('About:')
    expect(entry).not.toMatch(/- researcher — Research\n\s*\n/)
  })
})

describe('buildTeamEntry — where files go', () => {
  const folder = { shared: '/halo/team-work/abc123def456', self: '/halo/team-work/abc123def456/reviewer' }

  it('tells the member where temporary collaboration files go', () => {
    const out = buildTeamEntry(makeCtx({ teamFolder: folder }))
    expect(out).toContain(`Scratch folder for this piece of work: ${folder.self}.`)
    expect(out).toContain('or inside your scratch folder')
    // Members read each other's files through team_read_artifact, not the shared path.
    expect(out).not.toContain(`${folder.shared}\n`)
  })

  it('preserves unique ownership and validated publishing without repeating the rationale', () => {
    const out = buildTeamEntry(makeCtx({ teamFolder: folder }))
    expect(out).toContain('A published name belongs to one member only')
    expect(out).toContain('producer-unique name')
    expect(out).toContain('rename and republish')
    expect(out).toContain('Publishing validates the file and access')
    expect(out).toContain('fix a failed publish before sharing')
  })

  it('renders exactly the working-directory wording when no scratch folder could be prepared', () => {
    const out = buildTeamEntry(makeCtx({ teamFolder: null }))
    expect(out).not.toContain('scratch folder')
    expect(out).toContain('inside your working directory, relative to it')
    expect(out).toContain('"docs/design.md"); files elsewhere cannot be shared')
    expect(out).toContain('team_read_artifact(ref)')
  })
})

describe('buildRestrictionNotice — a restricted turn is told why, not left to guess', () => {
  const withheld = ['running commands', 'skills', 'AI Browser']

  it('names a colleague and whose digital human it is, and where the owner turns things on', () => {
    const notice = buildRestrictionNotice({ origin: 'colleague', member: remoteMate }, withheld)
    expect(notice.startsWith('[Limited permissions for this turn]')).toBe(true)
    expect(notice).toContain('This request comes from analyst, Bob\u2019s digital human on another machine.')
    expect(notice).toContain('"What others can ask it to do"')
    for (const item of withheld) expect(notice).toContain(`- ${item}`)
    expect(notice).toContain('This is your owner\u2019s setting, not a fault.')
    expect(notice).toContain('do not ask anyone to change hooks')
  })

  it('says when a request was passed on by one of the owner\u2019s own members, or came from no named member', () => {
    expect(buildRestrictionNotice({ origin: 'colleague', member: localMate }, withheld))
      .toContain('This request comes from researcher, passing on work that came from another machine.')
    expect(buildRestrictionNotice({ origin: 'colleague' }, withheld))
      .toContain('This request comes from someone on another machine in this team.')
    expect(buildRestrictionNotice({ origin: 'colleague', member: { ...remoteMate, owner: null } }, withheld))
      .toContain('analyst, a teammate\u2019s digital human on another machine')
  })

  it('tells a guest\u2019s request apart, capped by that chat\u2019s guest settings', () => {
    const notice = buildRestrictionNotice({ origin: 'guest' }, withheld)
    expect(notice).toContain('This request comes from a guest in an IM chat your team answers, not from your owner.')
    expect(notice).toContain('that chat\u2019s guest settings')
  })
})
