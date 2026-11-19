import { CollaborationRefusal } from '@hello-halo/agent-sdk/collaboration'
import { TEAM_LEAD_ADDRESS } from '../../../shared/apps/team-types'
import type { TeamStore } from './types'
import { workMemberAddressTaken } from './work-members'

type WorkScope = { teamId: string; epochId: string }

/** Normalize a requested name and reject reserved tool addresses before allocation. */
export function participantName(requested?: string, scope?: WorkScope): string {
  const name = requested?.trim() || 'collaborator'
  if (name === TEAM_LEAD_ADDRESS || name === 'all') {
    throw new CollaborationRefusal('reserved_name', 'Choose a collaborator name other than all or lead.', scope)
  }
  return name
}

/** Refuse names that would collide with an address already usable in the given work. */
export function assertParticipantNameAvailable(store: TeamStore, scope: WorkScope, name: string, privateAssistants: boolean): void {
  if (!workMemberAddressTaken(store, scope.teamId, scope.epochId, name)) return
  const continuation = privateAssistants ? 'using its original handle, not the name' : 'by its existing address'
  throw new CollaborationRefusal('name_taken',
    `A member already uses the address ${JSON.stringify(name)}. Continue the existing collaborator with team_send ${continuation}, or choose a distinct name for new work.`, scope)
}
