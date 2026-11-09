import type { TeamStore } from '../../team'
import { listWorkMembers, releaseParticipantWorkspaces } from '../../team'
import { buildTeamSessionKey, isRemoteMember } from '../../../../shared/apps/team-types'
import type { TeamRuntime } from './index'

/** Keep the replica and private leases until its local owners have actually closed. */
export async function disposeJoinedOfficeWork(store: TeamStore, runtime: TeamRuntime | null, teamId: string): Promise<void> {
  const release = store.beginDisposal(teamId)
  try {
    const epochs = store.listEpochsByTeam(teamId)
    for (const epoch of epochs) {
      store.recipientFences.clearEpoch(teamId, epoch.id)
      for (const member of listWorkMembers(store, teamId, epoch.id)) {
        if (isRemoteMember(member)) continue
        const key = buildTeamSessionKey(member.appId, teamId, epoch.id)
        const request = store.requests.current(key)
        if (request) store.requests.cancel(request)
        store.requests.cancelSource(key)
        runtime?.bus.cancelSession(key)
      }
    }
    if (!runtime) throw new Error('Team execution services are unavailable. The office was retained for cleanup.')
    const failures: unknown[] = []
    for (const scope of store.listPrivateCollaborations(teamId)) {
      try { await disposeJoinedOfficeWork(store, runtime, scope.id) } catch (error) { failures.push(error) }
    }
    for (const epoch of epochs) {
      try { await runtime.closeEpochResources(teamId, epoch.id) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'The dissolved office still has sessions that could not close; its records were retained.')
    await releaseParticipantWorkspaces(store, teamId)
    store.purgeJoinedOffice(teamId)
    await runtime.teamFolders?.remove(teamId, epochs.map(epoch => epoch.id))
  } finally { release() }
}
