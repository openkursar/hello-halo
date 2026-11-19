import { randomBytes } from 'node:crypto'
import {
  CollaborationRefusal, MODEL_SELECTION_LIMITS, ModelProfileCatalogView, finalizeModelSelection,
  type CollaborationOperations, type ModelSelectionCapability, type ModelSelectionSnapshot, type SpawnInput,
} from '@hello-halo/agent-sdk/collaboration'
import { getSubagentModelConfigurationSnapshot, getSubagentModelSettings, getSubagentModelProfile } from '../ai-sources'
import type { AgentModelSelection } from '../../../shared/types/ai-sources'
import type { DelegatedModelContext } from './delegated-model'
import { prepareSubagentModelMetadata } from './subagent-model-metadata'
import { delegatedReasoningLevel } from './reasoning-effort'
import { buildSubagentModelCatalog, formatSubagentModelDirectory } from './subagent-model-catalog'

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
    reasoningLevel?: DelegatedModelContext['reasoningLevel']
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
  const capability: ModelSelectionCapability = { policy: settings.selectionMode, policyRevision, reasoningPolicy: 'inherit' }
  let cached: {
    revision: number
    engineId: string
    view: ModelProfileCatalogView
    namespace: string
    text?: string
    refs: Map<string, string>
  } | undefined
  const parentBinding = (parent: DelegatedModelContext) => {
    if (!parent.reasoning) throw new CollaborationRefusal('source_unavailable', 'The parent model reasoning cannot be preserved for model selection.')
    return {
      bindingId: parent.modelBinding?.bindingId ?? JSON.stringify({ sourceId: parent.selection.modelSourceId, modelId: parent.selection.modelId }),
      restoreRef: parent.modelBinding?.restoreRef ?? JSON.stringify({ sourceId: parent.selection.modelSourceId, modelId: parent.selection.modelId }),
      model: parent.selection.modelId, reasoning: parent.reasoning,
    }
  }
  const catalog = () => {
    const snapshot = getSubagentModelConfigurationSnapshot()
    if (!snapshot?.settings || !options.allowed()) throw new CollaborationRefusal('model_selection_forbidden', 'Model selection is unavailable for this request.')
    const engineId = options.parent().engineId
    if (!cached || cached.revision !== snapshot.revision || cached.engineId !== engineId) {
      cached?.view.close()
      cached = undefined
      const view = new ModelProfileCatalogView(buildSubagentModelCatalog({ ...snapshot, settings: snapshot.settings,
        engineId, revision: String(snapshot.revision) }))
      cached = { revision: snapshot.revision, engineId, view, namespace: randomBytes(6).toString('hex'), refs: new Map() }
    }
    return cached
  }
  return {
    capability,
    close() { cached?.view.close(); cached = undefined },
    list: async (input, call) => {
      call.signal?.throwIfAborted()
      if (Object.keys(input).length) {
        throw new CollaborationRefusal('model_directory_arguments', 'Call list_model_profiles without arguments.')
      }
      const current = catalog()
      if (current.text === undefined) {
        const result = current.view.query({ parent: parentBinding(options.parent()), policyRevision, input: {} })
        const refs = new Map<string, string>()
        const text = formatSubagentModelDirectory(result, ref => {
          const id = `p${current.namespace}${refs.size.toString(36)}`
          refs.set(id, ref)
          return id
        })
        if (Buffer.byteLength(text, 'utf8') > MODEL_SELECTION_LIMITS.resultBytes) {
          throw new CollaborationRefusal('model_directory_too_large', 'The complete model directory is too large to return. No profiles were listed. Reduce the configured assignments or shorten their descriptions in Settings.')
        }
        current.refs = refs
        current.text = text
      }
      return { content: [{ type: 'text', text: current.text }] }
    },
    async prepare(input, parent, check, signal) {
      check()
      signal?.throwIfAborted()
      if (!options.allowed()) throw new CollaborationRefusal('model_selection_forbidden', 'Model overrides are not allowed for this request.')
      if (input.reasoning_effort !== undefined) {
        throw new CollaborationRefusal('reasoning_override_removed', 'Omit reasoning_effort. The collaborator follows the direct parent’s reasoning setting.')
      }
      const { view, refs } = catalog()
      const requested = input.model_profile
      const selected = requested === undefined || requested === 'inherit' ? requested : refs.get(requested)
      if (requested !== undefined && selected === undefined) {
        throw new CollaborationRefusal('model_profile_stale', 'This model profile ID is no longer valid. List model profiles again.')
      }
      const bindingParent = parentBinding(parent)
      const plan = view.plan({ input: { ...(selected !== undefined ? { model_profile: selected } : {}) }, parent: bindingParent, policyRevision })
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
      const reasoningLevel = parent.reasoningLevel ?? delegatedReasoningLevel(bindingParent.reasoning)
      const adapted = target && (selection.modelSourceId !== parent.selection.modelSourceId || selection.modelId !== parent.selection.modelId)
      const prepared = await awaitModelPreparation(prepareSubagentModelMetadata(selection, parent.engineId, target ? reasoningLevel : undefined), signal)
      check()
      signal?.throwIfAborted()
      const latest = getSubagentModelConfigurationSnapshot()
      const overrides = plan.selection.kind === 'profile'
      if (!options.allowed() || !latest?.settings || (overrides && String(latest.settings.policyRevision) !== policyRevision)
        || (profile && getSubagentModelProfile(profile.id)?.revision !== profile.revision)
        || (source && !latest.sources.some(item => item.id === source.id && item.createdAt === source.createdAt))
        || (group && !latest.groups.some(item => item.id === group.id))) {
        throw new CollaborationRefusal('model_selection_stale', 'Model settings or permissions changed while preparing the collaborator. Query again next turn.')
      }
      const binding = target && !adapted
        ? { ...prepared.metadata, reasoning: { ...prepared.metadata.reasoning, default: bindingParent.reasoning } }
        : prepared.metadata
      const snapshot = finalizeModelSelection({ plan, binding })
      return { modelSelection: selection, inheritedReasoning: snapshot.reasoning, modelBinding: snapshot,
        ...(reasoningLevel ? { reasoningLevel } : {}) }
    },
  }
}
