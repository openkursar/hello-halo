import {
  CollaborationRefusal, ModelProfileCatalogView, finalizeModelSelection,
  type CollaborationOperations, type ModelSelectionCapability, type ModelSelectionSnapshot, type SpawnInput,
} from '@hello-halo/agent-sdk/collaboration'
import { getSubagentModelConfigurationSnapshot, getSubagentModelSettings, getSubagentModelProfile } from '../ai-sources'
import type { AgentModelSelection } from '../../../shared/types/ai-sources'
import type { DelegatedModelContext } from './delegated-model'
import { prepareSubagentModelMetadata } from './subagent-model-metadata'
import { buildSubagentModelCatalog } from './subagent-model-catalog'

async function awaitModelPreparation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('Model preparation was cancelled.'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}

export interface DelegatedModelEndpoint {
  capability: ModelSelectionCapability
  list: NonNullable<CollaborationOperations['list_model_profiles']>
  close(): void
  prepare(input: SpawnInput, parent: DelegatedModelContext, check: () => void, signal?: AbortSignal): Promise<{
    modelSelection: AgentModelSelection
    inheritedReasoning: DelegatedModelContext['reasoning']
    modelBinding: ModelSelectionSnapshot
  }>
}

/** Endpoint policy is fixed; a changed local configuration replaces its bounded catalog view. */
export function createDelegatedModelEndpoint(options: {
  parent(): DelegatedModelContext
  allowed(): boolean
}): DelegatedModelEndpoint | undefined {
  const settings = getSubagentModelSettings()
  if (!settings || !options.allowed()) return undefined
  const policyRevision = String(settings.policyRevision)
  const capability = { policy: settings.selectionMode, policyRevision }
  let cached: { revision: number; engineId: string; view: ModelProfileCatalogView } | undefined
  const parentBinding = (parent: DelegatedModelContext) => ({
    bindingId: parent.modelBinding?.bindingId ?? JSON.stringify({ sourceId: parent.selection.modelSourceId, modelId: parent.selection.modelId }),
    restoreRef: parent.modelBinding?.restoreRef ?? JSON.stringify({ sourceId: parent.selection.modelSourceId, modelId: parent.selection.modelId }),
    model: parent.selection.modelId, reasoning: parent.reasoning,
  })
  const catalog = () => {
    const snapshot = getSubagentModelConfigurationSnapshot()
    if (!snapshot?.settings || !options.allowed()) throw new CollaborationRefusal('model_selection_forbidden', 'Model selection is unavailable for this request.')
    const engineId = options.parent().engineId
    if (!cached || cached.revision !== snapshot.revision || cached.engineId !== engineId) {
      cached?.view.close()
      const view = new ModelProfileCatalogView(buildSubagentModelCatalog({ ...snapshot, settings: snapshot.settings,
        engineId, revision: String(snapshot.revision) }))
      cached = { revision: snapshot.revision, engineId, view }
    }
    return cached.view
  }
  return {
    capability,
    close() { cached?.view.close(); cached = undefined },
    list: async (input, call) => {
      call.signal?.throwIfAborted()
      const result = catalog().query({ parent: parentBinding(options.parent()), policyRevision, input })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
    async prepare(input, parent, check, signal) {
      check()
      signal?.throwIfAborted()
      if (!options.allowed()) throw new CollaborationRefusal('model_selection_forbidden', 'Model overrides are not allowed for this request.')
      const plan = catalog().plan({ input: {
        ...(input.model_profile !== undefined ? { model_profile: input.model_profile } : {}),
        ...(input.reasoning_effort !== undefined ? { reasoning_effort: input.reasoning_effort } : {}),
      }, parent: parentBinding(parent), policyRevision })
      const profile = plan.selection.kind === 'profile' ? getSubagentModelProfile(plan.selection.profileId) : undefined
      if (plan.selection.kind === 'profile' && (!profile?.target || String(profile.revision) !== plan.selection.profileRevision)) {
        throw new CollaborationRefusal('model_profile_stale', 'The model configuration changed. Query the catalog again.')
      }
      const target = profile?.target
      const selection = target ? target.kind === 'model'
        ? { modelSourceId: target.sourceId, modelId: target.modelId }
        : { modelSourceId: target.groupId, modelId: 'halo-auto' }
        : parent.selection
      const before = getSubagentModelConfigurationSnapshot()
      const source = before?.sources.find(item => item.id === selection.modelSourceId)
      const group = before?.groups.find(item => item.id === selection.modelSourceId)
      const prepared = await awaitModelPreparation(prepareSubagentModelMetadata(selection, parent.engineId), signal)
      check()
      signal?.throwIfAborted()
      const latest = getSubagentModelConfigurationSnapshot()
      const overrides = (input.model_profile !== undefined && input.model_profile !== 'inherit') || input.reasoning_effort !== undefined
      if (!options.allowed() || !latest?.settings || (overrides && String(latest.settings.policyRevision) !== policyRevision)
        || (profile && getSubagentModelProfile(profile.id)?.revision !== profile.revision)
        || (source && !latest.sources.some(item => item.id === source.id && item.createdAt === source.createdAt))
        || (group && !latest.groups.some(item => item.id === group.id))) {
        throw new CollaborationRefusal('model_selection_stale', 'Model settings or permissions changed while preparing the collaborator. Query again next turn.')
      }
      const snapshot = finalizeModelSelection({ plan, binding: prepared.metadata })
      return { modelSelection: selection, inheritedReasoning: snapshot.reasoning, modelBinding: snapshot }
    },
  }
}
