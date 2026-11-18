import { createHash } from 'crypto'
import { spaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { bindTeamCollaborationSource } from './source-delivery'
import { CollaborationRefusal } from '@hello-halo/agent-sdk/collaboration'
import { createTeamMcpServer, type TeamMcpContext } from './team-tools'
import { createSpaceTeamMcpServer, type SpaceTeamMcpScope } from '../../conversation-mcp'
import { getTeamService, getTeamStore, type ParticipantSource } from '../../team'
import { createDelegatedModelEndpoint, type DelegatedModelContext } from '../../../services/agent'

interface Binding {
  context: TeamMcpContext
  generation: string
  token: symbol
}

const active = new Map<string, Binding>()
const sources = new Map<string, { generation: number; token: symbol; source(): ParticipantSource; requestId(): string; canSpawn(): boolean; modelContext?: () => DelegatedModelContext }>()

/** Reused engine sessions read the current turn without giving retired endpoints a new authority. */
export function bindTeamToolSession(conversationId: string, context: TeamMcpContext) {
  context.participants?.registerSource(conversationId)
  const generation = context.participants?.generation(context) ?? '0'
  const token = Symbol()
  active.set(conversationId, { context, generation, token })
  context.models = createDelegatedModelEndpoint({
    parent: () => {
      const source = resolve().spawnSource?.()
      if (!source?.inheritedReasoning) throw new CollaborationRefusal('source_unavailable', 'The parent model execution is unavailable.')
      return { selection: source.modelSelection, engineId: source.engineId, reasoning: source.inheritedReasoning, modelBinding: source.modelBinding }
    },
    allowed: () => {
      const current = active.get(conversationId)?.context ?? context
      return !current.origin && !current.servesGuest && current.canSpawn?.() !== false
    },
  })
  const resolve = () => {
    const current = active.get(conversationId)
    if (!current || current.generation !== generation) {
      throw new CollaborationRefusal('turn_unavailable', 'This tool endpoint no longer belongs to an active turn.')
    }
    return current.context
  }
  const privateContext = (current: TeamMcpContext, work: { team: { id: string; leadAppId: string | null }; epochId: string }): TeamMcpContext => ({
    ...current, teamId: work.team.id, epochId: work.epochId,
    callerAppId: spaceCoordinatorAppId(conversationId), collabMode: 'free', selfIsLead: true,
    requestId: privateRequest(current), privateAssistants: undefined,
  })
  const privateRequest = (current: TeamMcpContext) => {
    const parent = current.participants!.requestId(current)
    return `${parent}/assistant-${createHash('sha256').update(conversationId).digest('hex').slice(0, 24)}`
  }
  context.privateAssistants = {
    readContext() {
      const current = resolve()
      current.participants?.capture(current)()
      const work = getTeamService()?.getCollaborationScope(conversationId)
      return work ? privateContext(current, work) : null
    },
    async spawn(input, call) {
      const current = resolve()
      if (!current.participants || !current.spawnSource || current.canSpawn?.() === false) {
        throw new CollaborationRefusal('spawn_forbidden', 'Creating private assistants is not allowed for this turn.')
      }
      const check = current.participants.capture(current, call.signal)
      let source = current.spawnSource()
      if (context.models && source.inheritedReasoning && !current.origin && !current.servesGuest) {
        source = { ...source, ...await context.models.prepare(input, {
          selection: source.modelSelection, engineId: source.engineId, reasoning: source.inheritedReasoning,
          modelBinding: source.modelBinding,
        }, () => { check(); if (resolve().canSpawn?.() === false) throw new CollaborationRefusal('spawn_forbidden', 'Delegation permissions changed.') }, call.signal) }
      } else if ((input.model_profile && input.model_profile !== 'inherit') || input.reasoning_effort !== undefined) {
        throw new CollaborationRefusal('model_selection_forbidden', 'Model overrides are unavailable for this request.')
      }
      const service = getTeamService()
      if (!service) throw new CollaborationRefusal('runtime_unavailable', 'Collaboration services are unavailable.')
      const requestId = privateRequest(current)
      const parentRequestId = current.participants.requestId(current)
      bindTeamCollaborationSource({ conversationId, requestId, parentRequestId, origin: current.origin })
      const work = await service.ensureCollaboration({ conversationId, owningSpaceId: source.environment.spaceId!, title: input.prompt })
      check()
      const member = await current.participants.spawn(privateContext(current, work), input, source, call.signal)
      return { content: [{ type: 'text', text: JSON.stringify({ handle: member.appId, name: member.memberName, status: 'accepted' }) }] }
    },
    resolveHandle(handle, all) {
      const current = resolve()
      const work = getTeamService()?.getCollaborationScope(conversationId)
      if (!work || (!all && !getTeamStore()?.participants.get(work.team.id, work.epochId, handle))) return null
      current.participants?.capture(current)()
      bindTeamCollaborationSource({ conversationId, requestId: privateRequest(current),
        parentRequestId: current.participants!.requestId(current), origin: current.origin })
      return privateContext(current, work)
    },
  }
  const server = createTeamMcpServer(context, resolve)
  return {
    server, generation,
    release() {
      context.models?.close()
      if (active.get(conversationId)?.token === token) active.delete(conversationId)
    },
  }
}

export function bindSourceToolSession(scope: SpaceTeamMcpScope, callbacks: {
  source(): ParticipantSource
  requestId(): string
  canSpawn(): boolean
}) {
  const generation = getTeamService()?.participants.sourceGeneration(scope.conversationId) ?? 0
  const token = Symbol()
  sources.set(scope.conversationId, { generation, token, ...callbacks, modelContext: scope.modelContext })
  const current = () => {
    const value = sources.get(scope.conversationId)
    if (!value || value.generation !== generation || (scope.executionScoped && value.token !== token)) throw new CollaborationRefusal('turn_unavailable', 'This tool endpoint no longer belongs to an active source turn.')
    return value
  }
  return {
    generation,
    server: createSpaceTeamMcpServer({ ...scope, canSpawn: () => current().canSpawn(),
      modelContext: scope.modelContext ? () => {
        const model = current().modelContext?.()
        if (!model) throw new CollaborationRefusal('source_unavailable', 'The parent model execution is unavailable.')
        return model
      } : undefined },
      () => current().source(), () => current().requestId()),
    release() { if (sources.get(scope.conversationId)?.token === token) sources.delete(scope.conversationId) },
  }
}
