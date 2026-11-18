/**
 * Collaboration for a chat turn, as the work host of an agent execution: a
 * digital human's conversation (native chat, IM) and a team member's turn.
 * A person's space conversation mounts the team server from the capability
 * broker instead; that server's lifetime is the engine session's toolset, so it
 * has no execution of its own to open or close.
 *
 * A chat has no end of its own: the conversation is the inbox, and what its
 * collaborators report resumes it (see `source-delivery.ts`), so none of this
 * waits for anything. What a turn does need — the scoped tool endpoint, the
 * request it serves, the sender authority an IM report returns under — is built
 * here from the context the entry describes, and retired when the turn ends. A
 * conversation's collaborators belong to the conversation: ending a turn leaves
 * them running, and the conversation's own stop is what stops them.
 */

import { COLLABORATION_GUIDANCE } from '@hello-halo/agent-sdk/collaboration'
import { TEAM_MCP_SERVER_NAME } from '../../../../shared/apps/team-types'
import { markMcpServerSettings } from '../../../services/agent'
import type { ExecutionWorkRequest, OwnedWork } from '../../../services/agent'
import { getTeamService } from '../../team'
import type { TeamRuntime } from './index'
import { participantSourceOf } from './participant-source'
import { bindImCollaborationSource } from './source-delivery'
import { bindSourceToolSession, bindTeamToolSession } from './tool-session'

export interface ChatWorkDeps {
  runtime(): TeamRuntime | null
}

type SourceOf<K extends ExecutionWorkRequest['source']['kind']> = Extract<ExecutionWorkRequest['source'], { kind: K }>

/** Nothing here waits, reports usage or owns collaborators beyond the turn. */
function chatWork(server: unknown, end: () => void): OwnedWork {
  return {
    tools: { [TEAM_MCP_SERVER_NAME]: server },
    guidance: COLLABORATION_GUIDANCE,
    hasPending: () => false,
    onChanged: () => ({ dispose() {} }),
    end: () => { end(); return Promise.resolve() },
    takeUsage: () => undefined,
  }
}

export function openConversationWork(request: ExecutionWorkRequest, source: SourceOf<'conversation'>): OwnedWork {
  const { principal, requester, key } = request
  const sourceRequestId = (): string => {
    const service = getTeamService()
    if (!service) throw new Error('Collaboration services are unavailable.')
    return source.requestId?.split('/')[0] ?? service.participants.sourceRequestId(key)
  }
  const participantSource = () => {
    if (!request.modelSelection) throw new Error('The source model configuration is unavailable.')
    if (source.channel) {
      if (!source.channel.permission) throw new Error('The originating chat authority is unavailable.')
      if (!principal.appId) throw new Error('The IM collaboration source is not available.')
      bindImCollaborationSource({ appId: principal.appId, conversationId: key, requestId: sourceRequestId(),
        imSession: source.channel.session, permission: source.channel.permission })
    }
    return participantSourceOf(request)
  }

  const binding = bindSourceToolSession({
    spaceId: principal.environment.spaceId!, conversationId: key, workDir: principal.environment.workDir,
    modelSelection: request.modelSelection, modelContext: request.modelContext, origin: requester?.origin,
    collaborationEnabled: request.mayDelegate(), publicationRefusal: requester?.publicationRefusal,
  }, { source: participantSource, requestId: sourceRequestId, canSpawn: request.mayDelegate })
  const server = markMcpServerSettings(binding.server, {
    origin: requester?.origin ?? null, generation: binding.generation, canSpawn: request.mayDelegate(),
  })
  return chatWork(server, binding.release)
}

export function openMemberWork(request: ExecutionWorkRequest, source: SourceOf<'member'>, deps: ChatWorkDeps): OwnedWork {
  const { principal, requester, key } = request
  const runtime = deps.runtime()
  if (!runtime) throw new Error('The team runtime is unavailable.')
  const { member } = source

  const binding = bindTeamToolSession(key, {
    teamId: member.teamId,
    epochId: member.epochId,
    callerAppId: member.appId,
    collabMode: member.collabMode,
    selfIsLead: member.selfIsLead,
    // The agent's own cwd: published refs are resolved against it, so it
    // must be the very directory this turn runs in.
    callerWorkDir: principal.environment.workDir,
    // The same folder the Entry points the member at.
    callerTeamFolder: member.teamFolder,
    teamFolders: runtime.teamFolders,
    bus: runtime.bus,
    blackboard: runtime.blackboard,
    // Location-transparent artifact read (wired by bootstrap); absent →
    // the tool reports the capability is unavailable.
    ...(runtime.readArtifact ? { readArtifact: runtime.readArtifact } : {}),
    ...(runtime.readMemberRecord ? { readMemberRecord: runtime.readMemberRecord } : {}),
    checks: !member.disposable && requester?.origin !== 'guest' ? runtime.checks : undefined,
    digest: runtime.digest,
    archive: runtime.archive,
    // Stamped onto the messages this turn sends, so the circuit
    // breaker's depth limit spans hops.
    forwardDepth: member.forwardDepth,
    // Same reasoning, different property of the chain: whose request it serves.
    ...(requester?.origin ? { origin: requester.origin } : {}),
    requestId: source.requestId,
    ...(member.servesGuest ? { servesGuest: true } : {}),
    participants: getTeamService()?.participants,
    canSpawn: request.mayDelegate,
    publicationRefusal: requester?.publicationRefusal,
    spawnSource: () => participantSourceOf(request),
  })
  const server = markMcpServerSettings(binding.server, {
    origin: requester?.origin ?? null, generation: binding.generation, canSpawn: request.mayDelegate(),
  })
  return chatWork(server, binding.release)
}
