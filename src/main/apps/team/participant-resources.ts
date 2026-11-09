import { releaseMemberWorkspace } from '@hello-halo/agent-sdk/collaboration/workspaces'
import type { TeamStore } from './types'

/** Call only after every team session has closed; work and commit history are retained by the shared lease owner. */
export async function releaseParticipantWorkspaces(store: TeamStore, teamId: string): Promise<void> {
  for (const member of store.participants.listByTeam(teamId)) {
    const workspace = store.participants.getExecution(teamId, member.epochId, member.appId)?.workspace
    if (workspace) await releaseMemberWorkspace(workspace)
  }
}
