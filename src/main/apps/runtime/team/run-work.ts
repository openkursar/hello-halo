/**
 * Collaboration for a headless run, as the work host of an agent execution.
 *
 * The execution (`services/agent/execution`) decides when a run may finish and
 * carries input into the engine session; this module answers what only the team
 * runtime knows — which request a result belongs to, whether its sender may
 * reach this run, what work is still unfinished — and stops the descendants.
 * A result addressed to the run reaches only that run's own execution.
 */

import { randomUUID } from 'crypto'
import { COLLABORATION_GUIDANCE } from '@hello-halo/agent-sdk/collaboration'
import { addRunTokenUsage, type RunTokenUsage } from '../../../../shared/apps/app-types'
import { parseRunSenderKey, parseTeamSessionKey } from '../../../../shared/apps/im-keys'
import { TEAM_MCP_SERVER_NAME } from '../../../../shared/apps/team-types'
import { onAgentEvent } from '../../../services/agent'
import type { ExecutionWorkRequest, OwnedWork } from '../../../services/agent'
import type { IDisposable } from '../../../platform/event'
import { getTeamService, getTeamStore, type ParticipantSource } from '../../team'
import type { TeamRuntime } from './index'
import { participantSourceOf } from './participant-source'
import type { CoordinatorDeliveryRequest } from './space-coordinator'
import type { OwnedSourceDisposition } from './source-delivery'
import { bindSourceToolSession } from './tool-session'

const LOG_TAG = '[RunWork]'

export interface RunWorkDeps {
  runtime(): Pick<TeamRuntime, 'hasPendingWork' | 'onWorkChanged'> | null
}

const endpoints = new Map<string, { deliver(delivery: CoordinatorDeliveryRequest): Promise<OwnedSourceDisposition> }>()

export function openRunWork(request: ExecutionWorkRequest, deps: RunWorkDeps): OwnedWork {
  const { key, principal } = request
  const environment = principal.environment
  if (endpoints.has(key)) throw new Error('This execution already has an active collaboration source.')
  const requestId = randomUUID()
  const service = () => getTeamService()
  const scope = () => service()?.getCollaborationScope(key)
  const current = () => request.isLive() && service()?.participants.requestAllowed(requestId) === true
  let started = false
  let revoked = false
  let stopping: Promise<void> | undefined
  let usage: RunTokenUsage | undefined
  let stopUsage: (() => void) | undefined

  function observeMemberUsage(): void {
    const subscription = onAgentEvent(event => {
      if (event.channel !== 'agent:complete' || event.relayed) return
      const member = parseTeamSessionKey(event.conversationId)
      if (!member) return
      const execution = getTeamStore()?.participants.getExecution(member.teamId, member.epochId, member.appId)
      if (!execution?.requestId?.startsWith(`${requestId}/`)) return
      // `tokenUsage` is the last call's context gauge; a member's turn counts its
      // own result frame, as the run's own turns do.
      const tokens = event.data.resultUsage as RunTokenUsage | null | undefined
      if (tokens) usage = addRunTokenUsage(usage, tokens)
    })
    stopUsage = () => subscription.dispose()
  }

  function source(): ParticipantSource {
    if (!current() || !request.mayDelegate()) throw new Error('The originating run is no longer available for collaboration.')
    if (!started) {
      const participants = service()?.participants
      if (!participants) throw new Error('Collaboration services are unavailable.')
      participants.beginRequest(key, requestId)
      started = true
    }
    if (!stopUsage) observeMemberUsage()
    return participantSourceOf(request)
  }

  const tools = bindSourceToolSession({
    spaceId: environment.spaceId!, conversationId: key, workDir: environment.workDir,
    modelSelection: request.modelSelection, collaborationEnabled: request.mayDelegate(), executionScoped: true,
  }, { source, requestId: () => requestId, canSpawn: request.mayDelegate })

  const endpoint = {
    async deliver(delivery: CoordinatorDeliveryRequest): Promise<OwnedSourceDisposition> {
      const owned = scope()
      const reportRequest = delivery.persist.metadata.requestId
      const authorized = () => current() && delivery.spaceId === environment.spaceId && delivery.permissionIdentity === 'owner'
        && !!reportRequest && service()?.participants.requestAllowed(reportRequest) === true
        && (reportRequest === requestId || reportRequest.startsWith(`${requestId}/`))
        && owned?.team.id === delivery.persist.metadata.teamId && owned.epochId === delivery.persist.metadata.epochId
        && service()?.getCollaborationScope(key)?.team.id === owned.team.id
      if (!authorized()) {
        console.warn(`${LOG_TAG} Result discarded: source=${key} reason=source-request-unavailable`)
        return { handled: true, disposition: 'dispatched' }
      }
      const disposition = await request.input.accept({
        text: delivery.turnInput,
        record: { content: delivery.persist.content, provenance: { source: 'team-message', metadata: delivery.persist.metadata } },
      }, authorized)
      return { handled: true, disposition: disposition === 'discarded' ? 'dispatched' : disposition }
    },
  }
  endpoints.set(key, endpoint)

  function revoke(): void {
    if (revoked) return
    revoked = true
    if (endpoints.get(key) === endpoint) endpoints.delete(key)
    tools.release()
  }

  return {
    tools: { [TEAM_MCP_SERVER_NAME]: tools.server },
    guidance: COLLABORATION_GUIDANCE,
    hasPending(): boolean {
      const owned = scope()
      if (!owned) return false
      const runtime = deps.runtime()
      if (!runtime) throw new Error('The collaboration runtime is unavailable while this execution still owns collaborators.')
      return runtime.hasPendingWork(owned.team.id, owned.epochId)
    },
    onChanged(listener): IDisposable {
      // Any team change is a reason to re-read this run's pending work: a member's
      // private assistants report under their own range, and a turn-end notice may
      // be suppressed (report wake cap, circuit breaker), so filtering by this
      // run's own team/epoch could leave a nested range's end unseen.
      return deps.runtime()?.onWorkChanged(() => listener()) ?? { dispose() {} }
    },
    end(): Promise<void> {
      stopping ??= (async () => {
        revoke()
        const participants = service()?.participants
        if (started && participants?.sourceState(key).requestId === requestId) await participants.stopSource(key)
        if (!endpoints.has(key)) participants?.releaseRunSource(key, requestId)
      })()
      return stopping
    },
    takeUsage(): RunTokenUsage | undefined {
      stopUsage?.()
      stopUsage = undefined
      const value = usage
      usage = undefined
      return value
    },
  }
}

/** A result addressed to a run reaches only that run's own execution; ordinary conversation sends stay one-way. */
export async function deliverRunCollaborationSource(delivery: CoordinatorDeliveryRequest): Promise<OwnedSourceDisposition> {
  if (!parseRunSenderKey(delivery.conversationId)) return { handled: false }
  const endpoint = endpoints.get(delivery.conversationId)
  if (endpoint) return endpoint.deliver(delivery)
  console.warn(`${LOG_TAG} Result discarded: source=${delivery.conversationId} reason=run-closed`)
  return { handled: true, disposition: 'dispatched' }
}
