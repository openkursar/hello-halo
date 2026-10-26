import type { EngineId } from '../../../shared/types/engine'
import type { StoredModelSelection } from '../../../shared/types/ai-sources'
import { assertEngineSourceCompatible } from '../../../shared/engine-source'
import { getAISourceManager } from '../ai-sources'

/** Save-time validation reads the provider descriptor without refreshing a credential or contacting a model. */
export async function assertEngineSourceSelection(engineId: EngineId, selection?: StoredModelSelection | null): Promise<void> {
  const manager = getAISourceManager()
  await manager.ensureInitialized()
  const source = selection?.modelSourceId
    ? manager.getSourceConfig(selection.modelSourceId)
    : manager.getCurrentSourceConfig()
  if (!source) {
    if (selection?.modelSourceId) throw new Error('The selected model account is unavailable. Choose an available account before changing engines.')
    return
  }
  const backend = manager.getBackendConfigForSource(source.id, selection?.modelId ?? source.model)
  assertEngineSourceCompatible(engineId, {
    ...source,
    apiType: backend?.apiType ?? source.apiType,
    delegatedAuth: backend?.delegatedAuth,
  })
}
