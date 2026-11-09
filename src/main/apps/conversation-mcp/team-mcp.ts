import { COLLABORATION_GUIDANCE, CollaborationRefusal, type CollaborationOperations } from '@hello-halo/agent-sdk/collaboration'
import { getTeamService, type ParticipantSource } from '../team'
import { getAppManager } from '../manager'
import { getActiveTeamRuntime, createCoordinationMcpServer, type TeamMcpContext } from '../runtime/team'
import { getSpace } from '../../services/space.service'
import type { ToolsetScope } from '../../services/agent/toolsets'
import { nativeChatAppId } from '../../../shared/apps/im-keys'
import { spaceCoordinatorAppId, type TeamRequestOrigin } from '../../../shared/apps/team-types'

export const TEAM_TOOLSET_GUIDE = COLLABORATION_GUIDANCE
export interface SpaceTeamMcpScope extends ToolsetScope {
  origin?: TeamRequestOrigin
  canSpawn?: () => boolean
  publicationRefusal?: (absolutePath: string) => string | null
}

function sourceOf(scope: SpaceTeamMcpScope): ParticipantSource {
  const settings = scope.executionOptions?.()
  const space = getSpace(scope.spaceId)
  if (!settings || !scope.modelSelection || !space) {
    throw new CollaborationRefusal('source_unavailable', 'The host could not resolve this conversation’s execution configuration.')
  }
  if (!settings.collaborationEnabled) throw new CollaborationRefusal('collaboration_disabled', 'Creating collaborators is disabled by the owner.')
  const sourceAppId = nativeChatAppId(scope.conversationId) ?? undefined
  const manager = getAppManager()
  const app = sourceAppId ? manager?.getApp(sourceAppId) : undefined
  if (sourceAppId && !app) throw new CollaborationRefusal('source_unavailable', 'The source digital human is unavailable.')
  const allowed = new Set(settings.mcpServerNames)
  const bindings = Object.fromEntries((manager?.listEffectiveMcpApps(scope.spaceId) ?? [])
    .filter(resource => allowed.has(resource.specId)).map(resource => [resource.specId, resource.id]))
  return {
    ...settings, modelSelection: scope.modelSelection, sourceAppId,
    permissions: app?.permissions ?? { granted: [], denied: [] },
    environment: { spaceId: scope.spaceId, spacePath: space.path, workDir: scope.workDir,
      memoryDir: space.path, mcpBindings: bindings },
  }
}

/** The source conversation fixes scope; neither a group nor a goal is a model argument. */
export function createSpaceTeamMcpServer(scope: SpaceTeamMcpScope, source?: () => ParticipantSource, requestId?: () => string) {
  const callerAppId = spaceCoordinatorAppId(scope.conversationId)
  getTeamService()?.participants.registerSource(scope.conversationId)
  const generation = getTeamService()?.participants.sourceGeneration(scope.conversationId) ?? 0
  const checkEndpoint = () => {
    const participants = getTeamService()?.participants
    if (!participants) throw new CollaborationRefusal('runtime_unavailable', 'Collaboration services are still starting.')
    if (participants.sourceGeneration(scope.conversationId) !== generation) {
      throw new CollaborationRefusal('execution_stopped', 'This collaboration endpoint was stopped. Continue through the current conversation.')
    }
  }
  const resolve = (): TeamMcpContext | null => {
    checkEndpoint()
    const service = getTeamService()
    const runtime = getActiveTeamRuntime()
    const collab = service?.getCollaborationScope(scope.conversationId)
    if (!service || !runtime || !collab) return null
    const team = collab.team
    if (!team || team.owningSpaceId !== scope.spaceId) return null
    const origin = source ? source().origin : scope.origin
    return {
      teamId: team.id, epochId: collab.epochId, callerAppId, collabMode: team.collabMode, selfIsLead: true,
      requestId: requestId?.() ?? service.participants.sourceRequestId(scope.conversationId),
      ...(origin ? { origin } : {}),
      publicationRefusal: scope.publicationRefusal,
      bus: runtime.bus, blackboard: runtime.blackboard, participants: service.participants,
      callerWorkDir: scope.workDir, callerTeamFolder: runtime.teamFolders.forMember(team.id, collab.epochId, callerAppId),
      teamFolders: runtime.teamFolders, readArtifact: runtime.readArtifact, readMemberRecord: runtime.readMemberRecord,
      digest: runtime.digest, archive: runtime.archive,
    }
  }
  const enabled = scope.collaborationEnabled ?? scope.executionOptions?.().collaborationEnabled ?? false
  const spawn: CollaborationOperations['spawn_agent'] = enabled ? async (input, context) => {
    checkEndpoint()
    context.signal?.throwIfAborted()
    if (scope.canSpawn?.() === false) throw new CollaborationRefusal('collaboration_disabled', 'Creating collaborators is not allowed for this request.')
    const capturedSource = source ? source() : sourceOf(scope)
    const service = getTeamService()
    if (!service) throw new CollaborationRefusal('runtime_unavailable', 'Collaboration services are still starting.')
    const current = service.participants.captureSource(scope.conversationId, context.signal)
    const capturedRequest = requestId?.() ?? service.participants.sourceRequestId(scope.conversationId)
    const check = () => {
      current()
      if (!service.participants.requestAllowed(capturedRequest)) throw new CollaborationRefusal('request_stopped', 'This collaboration request was stopped.')
    }
    check()
    const work = await service.ensureCollaboration({ owningSpaceId: scope.spaceId, conversationId: scope.conversationId, title: input.prompt })
    context.signal?.throwIfAborted()
    check()
    const member = await service.participants.spawn({ teamId: work.team.id, epochId: work.epochId, callerAppId,
      requestId: capturedRequest, ...(capturedSource.origin ? { origin: capturedSource.origin } : {}) }, input, capturedSource, context.signal)
    return { content: [{ type: 'text', text: JSON.stringify({ handle: member.appId, name: member.memberName, status: 'accepted' }) }] }
  } : undefined
  return createCoordinationMcpServer(resolve, { spawn, readMember: !scope.origin })
}
