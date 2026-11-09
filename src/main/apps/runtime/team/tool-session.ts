import { createHash } from 'crypto'
import { spaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { bindTeamCollaborationSource } from './source-delivery'
import { CollaborationRefusal } from '@hello-halo/agent-sdk/collaboration'
import { createTeamMcpServer, type TeamMcpContext } from './team-tools'
import { createSpaceTeamMcpServer, type SpaceTeamMcpScope } from '../../conversation-mcp'
import { getTeamService, getTeamStore, type ParticipantSource } from '../../team'

interface Binding {
  context: TeamMcpContext
  generation: string
  token: symbol
}

const active = new Map<string, Binding>()
const sources = new Map<string, { generation: number; token: symbol; source(): ParticipantSource; requestId(): string; canSpawn(): boolean }>()

/** Reused engine sessions read the current turn without giving retired endpoints a new authority. */
export function bindTeamToolSession(conversationId: string, context: TeamMcpContext) {
  context.participants?.registerSource(conversationId)
  const generation = context.participants?.generation(context) ?? '0'
  const token = Symbol()
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
    async spawn(input, call) {
      const current = resolve()
      if (!current.participants || !current.spawnSource || current.canSpawn?.() === false) {
        throw new CollaborationRefusal('spawn_forbidden', 'Creating private assistants is not allowed for this turn.')
      }
      const check = current.participants.capture(current, call.signal)
      const source = current.spawnSource()
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
  active.set(conversationId, { context, generation, token })
  const server = createTeamMcpServer(context, resolve)
  return {
    server, generation,
    release() { if (active.get(conversationId)?.token === token) active.delete(conversationId) },
  }
}

export function bindSourceToolSession(scope: SpaceTeamMcpScope, callbacks: {
  source(): ParticipantSource
  requestId(): string
  canSpawn(): boolean
}) {
  const generation = getTeamService()?.participants.sourceGeneration(scope.conversationId) ?? 0
  const token = Symbol()
  sources.set(scope.conversationId, { generation, token, ...callbacks })
  const current = () => {
    const value = sources.get(scope.conversationId)
    if (!value || value.generation !== generation) throw new CollaborationRefusal('turn_unavailable', 'This tool endpoint no longer belongs to an active source turn.')
    return value
  }
  return {
    generation,
    server: createSpaceTeamMcpServer({ ...scope, canSpawn: () => current().canSpawn() },
      () => current().source(), () => current().requestId()),
    release() { if (sources.get(scope.conversationId)?.token === token) sources.delete(scope.conversationId) },
  }
}
