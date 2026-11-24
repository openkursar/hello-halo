import { describe, expect, it } from 'vitest'
import { detailForTask, involvedOwnMember, ownedTaskMembers } from '../../../src/renderer/components/team/workbench/members'
import { spaceCoordinatorAppId, temporaryMemberHandle, type TeamConversation, type TeamDetail, type EpochBoard } from '../../../src/shared/apps/team-types'

const source = spaceCoordinatorAppId('source')
const members = [
  { appId: source, isLead: false, isSystemCoordinator: true },
  { appId: 'Alice', isLead: false },
  { appId: 'Lead', isLead: true, isSystemCoordinator: true },
  { appId: 'Bob', isLead: false, origin: 'remote', ownerNodeId: 'other' },
]
const detail = {
  team: { id: 'team', leadAppId: 'Lead', ephemeral: false }, members,
  roster: members.map(member => ({ ...member, spaceId: member.appId === 'Bob' ? null : 'space' })),
} as TeamDetail

describe('members in a task view', () => {
  it('shows source participants without either internal coordinator or standalone lead', () => {
    const sourceView = detailForTask(detail, { kind: 'collab' } as TeamConversation)
    expect(sourceView.members.map(m => m.appId)).toEqual(['Alice', 'Bob'])
    expect(sourceView.roster.map(m => m.appId)).toEqual(['Alice', 'Bob'])
  })

  it('can select a newly prepared lead before the app-directory refresh arrives', () => {
    const view = detailForTask(detail, null)
    expect(view.roster.map(m => m.appId)).toEqual(['Alice', 'Lead', 'Bob'])
    expect(ownedTaskMembers(view, []).map(m => m.appId)).toEqual(['Lead', 'Alice'])
  })

  it('opens someone else\'s task on my member that took part, not the lead', () => {
    const own = [{ appId: 'Lead' }, { appId: 'Alice' }]
    expect(involvedOwnMember(own, [{ actorAppId: 'Bob', targetAppId: 'Alice' }], [])).toBe('Alice')
    expect(involvedOwnMember(own, [], [{ createdByAppId: 'Bob', assigneeAppId: 'Alice' }])).toBe('Alice')
    expect(involvedOwnMember(own, [{ actorAppId: 'Bob', targetAppId: null }], [])).toBeUndefined()
  })
})


describe('work-scoped roster projection', () => {
  const participant = { appId: 'temporary', memberName: 'Investigator', isTemporary: true, isLead: false, origin: 'local' }
  const remote = { appId: 'remote-temporary', memberName: 'Remote', isTemporary: true, isLead: false, origin: 'remote', ownerNodeId: 'peer' }
  const board = { epoch: { id: 'work-a', teamId: 'team' }, members: [...members, participant, remote],
    roster: [...detail.roster, { ...participant, spaceId: 'space', sameMachine: true }, { ...remote, spaceId: null, sameMachine: false }],
    tasks: [], findings: [] } as unknown as EpochBoard

  it('includes temporary participants only in the matching task, while leaving the permanent settings projection unchanged', () => {
    const task = { epochId: 'work-a', kind: 'native' } as TeamConversation
    const scoped = detailForTask(detail, task, board)
    expect(scoped.roster.map(member => member.appId)).toContain('temporary')
    expect(scoped.roster.map(member => member.appId)).toContain('remote-temporary')
    expect(ownedTaskMembers(scoped, []).map(member => member.appId)).toContain('temporary')
    expect(ownedTaskMembers(scoped, []).map(member => member.appId)).not.toContain('remote-temporary')
    expect(detail.members.map(member => member.appId)).not.toContain('temporary')
    expect(detailForTask(detail, null, board).roster.map(member => member.appId)).not.toContain('temporary')
    expect(detailForTask(detail, { ...task, epochId: 'work-b' }, board).roster.map(member => member.appId)).not.toContain('temporary')
    expect(detailForTask(detail, task, { ...board, epoch: { ...board.epoch, teamId: 'other' } }).roster.map(member => member.appId)).not.toContain('temporary')
  })

  it('honors an authoritative empty roster instead of showing another task’s participants', () => {
    const task = { epochId: 'work-a', kind: 'native' } as TeamConversation
    expect(detailForTask(detail, task, { ...board, roster: [] }).roster).toEqual([])
    expect(detailForTask(detail, task, { ...board, roster: undefined }).roster).toEqual(detailForTask(detail, task).roster)
  })

  it('shows a collaborator by its given name, not the handle it is addressed by', () => {
    const task = { epochId: 'work-a', kind: 'native' } as TeamConversation
    const named = { appId: 'ba82e662-0000', memberName: temporaryMemberHandle('Reviewer', 'ba82e662-0000'), role: 'Reviewer', isTemporary: true, isLead: false, origin: 'local' }
    const chosen = { appId: 'c1', memberName: 'Reviewer-ba82e662', role: 'Editor', isLead: false }
    const scoped = detailForTask(detail, task, { ...board, members: [...board.members, named, chosen], roster: [{ ...named, spaceId: 'space' }, { ...chosen, spaceId: 'space' }] } as unknown as EpochBoard)
    expect(scoped.roster.map(member => member.memberName)).toEqual(['Reviewer', 'Reviewer-ba82e662'])
    expect(scoped.members.find(member => member.appId === named.appId)?.memberName).toBe('Reviewer')
  })
})
