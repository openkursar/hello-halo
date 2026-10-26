import { describe, expect, it } from 'vitest'
import { detailForTask, ownedTaskMembers } from '../../../src/renderer/components/team/workbench/members'
import { spaceCoordinatorAppId, type TeamConversation, type TeamDetail } from '../../../src/shared/apps/team-types'

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
})
