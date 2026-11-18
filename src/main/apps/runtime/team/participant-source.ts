import type { ExecutionWorkRequest } from '../../../services/agent'
import type { ParticipantSource } from '../../team'

/**
 * What a collaborator inherits from the execution that creates it: the tool
 * grants the session holds, the principal's model, permissions and environment,
 * and the limits of whoever asked.
 */
export function participantSourceOf(request: ExecutionWorkRequest): ParticipantSource {
  const { principal, requester } = request
  if (!request.modelSelection) throw new Error('The source model configuration is unavailable.')
  const fileAccess = requester?.files?.()
  const model = request.modelContext?.()
  return {
    ...request.grants(),
    modelSelection: model?.selection ?? request.modelSelection,
    ...(model ? { inheritedReasoning: model.reasoning, modelBinding: model.modelBinding } : {}),
    sourceAppId: principal.appId,
    environment: principal.environment,
    permissions: principal.permissions,
    ...(requester?.delegation ? { delegatedPolicy: requester.delegation.policy ?? {} } : {}),
    ...(fileAccess ? { fileAccess } : {}),
    ...(requester?.origin ? { origin: requester.origin } : {}),
  }
}
