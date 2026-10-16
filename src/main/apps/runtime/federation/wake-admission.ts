import { buildTeamSessionKey, SELF_NODE_ID } from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'
import type { SerializedWakeRequest } from './types'

export interface WakeAdmission {
  ok: boolean
  reason?: string
  metadataPending?: boolean
}

/** A wire request may choose work in this office, never another policy or private session. */
export function validateWakeAdmission(params: {
  officeId: string
  outerOfficeId: string
  correlationId: string
  fromNode: string
  selfNodeId: string
  authorityNodeId: string
  request: SerializedWakeRequest
  store: Pick<TeamStore, 'getMember' | 'getEpochById' | 'listMembersByTeam'>
  canDispatch?: (fromNode: string, request: SerializedWakeRequest) => boolean
}): WakeAdmission {
  const { officeId, outerOfficeId, correlationId, fromNode, selfNodeId, authorityNodeId, request, store } = params
  if (outerOfficeId !== officeId) return { ok: false, reason: 'office-mismatch' }
  if (!request || typeof request !== 'object' || !request.teamContext || typeof request.teamContext !== 'object') {
    return { ok: false, reason: 'invalid-wake-request' }
  }
  const trigger = request.teamContext
  if (trigger.teamId !== officeId) return { ok: false, reason: 'office-mismatch' }
  if (typeof request.appId !== 'string' || !request.appId || typeof trigger.epochId !== 'string' || !trigger.epochId || typeof request.message !== 'string') {
    return { ok: false, reason: 'invalid-wake-request' }
  }
  if (typeof correlationId !== 'string' || !correlationId || trigger.correlationId !== correlationId) {
    return { ok: false, reason: 'correlation-mismatch' }
  }
  if (request.conversationId !== buildTeamSessionKey(request.appId, officeId, trigger.epochId)) {
    return { ok: false, reason: 'session-key-mismatch' }
  }
  const epoch = store.getEpochById(trigger.epochId)
  if (epoch && epoch.teamId !== officeId) return { ok: false, reason: 'epoch-office-mismatch' }
  const target = store.getMember(officeId, request.appId)
  const owner = (value: { ownerNodeId?: string | null }): string =>
    !value.ownerNodeId || value.ownerNodeId === SELF_NODE_ID ? selfNodeId : value.ownerNodeId
  if (target && owner(target) !== selfNodeId && authorityNodeId !== selfNodeId) {
    return { ok: false, reason: 'recipient-not-owned' }
  }
  if (trigger.fromAppId !== null && typeof trigger.fromAppId !== 'string') {
    return { ok: false, reason: 'invalid-sender' }
  }
  const sender = trigger.fromAppId ? store.getMember(officeId, trigger.fromAppId) : null
  if (sender && fromNode !== authorityNodeId && owner(sender) !== fromNode) {
    return { ok: false, reason: 'sender-owner-mismatch' }
  }
  if (!epoch || !target || (trigger.fromAppId && !sender)) {
    return { ok: false, reason: 'wake-metadata-pending', metadataPending: true }
  }
  if (authorityNodeId !== selfNodeId && fromNode !== authorityNodeId) {
    return { ok: false, reason: 'wake-authority-pending', metadataPending: true }
  }
  if (fromNode !== authorityNodeId) {
    if (!trigger.fromAppId && !store.listMembersByTeam(officeId).some(member => owner(member) === fromNode)) {
      return { ok: false, reason: 'sender-node-not-member' }
    }
    if (params.canDispatch && !params.canDispatch(fromNode, request)) return { ok: false, reason: 'scope-denied' }
  }
  return { ok: true }
}
