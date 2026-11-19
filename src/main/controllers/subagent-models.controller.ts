import { subagentModelsRpc, type SubagentModelResponse } from '../../shared/rpc/contracts/subagent-models.contract'
import { sendToRenderer } from '../foundation/window.service'
import { broadcastToAll } from '../http/websocket'
import { clearBuiltinSubagentModel, createSubagentModel, deleteSubagentModel, listSubagentModels, setSubagentModelSelectionMode, SubagentModelError, updateSubagentModel } from '../services/ai-sources'
import { emitConfigChange } from '../services/health'
import type { SubagentModelSettings } from '../../shared/types/subagent-models'

function answer(operation: () => SubagentModelSettings, write = false): SubagentModelResponse {
  try {
    const before = write ? listSubagentModels().revision : undefined
    const data = operation()
    if (write && before !== data.revision) {
      const event = { revision: data.revision, policyRevision: data.policyRevision }
      sendToRenderer('subagent-models:changed', event)
      broadcastToAll('subagent-models:changed', event)
      emitConfigChange(['aiSources.subagentModels'])
    }
    return { success: true, data }
  } catch (error) {
    if (!(error instanceof SubagentModelError)) console.error('[SubagentModels] Configuration operation failed:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Configuration operation failed', ...(error instanceof SubagentModelError ? { code: error.code } : {}) }
  }
}
export const subagentModelHandlers = {
  listSubagentModels: () => answer(listSubagentModels),
  createSubagentModel: (input: Parameters<typeof createSubagentModel>[0]) => answer(() => createSubagentModel(input), true),
  updateSubagentModel: (input: Parameters<typeof updateSubagentModel>[0]) => answer(() => updateSubagentModel(input), true),
  clearBuiltinSubagentModel: (input: Parameters<typeof clearBuiltinSubagentModel>[0]) => answer(() => clearBuiltinSubagentModel(input), true),
  deleteSubagentModel: (input: Parameters<typeof deleteSubagentModel>[0]) => answer(() => deleteSubagentModel(input), true),
  setSubagentModelSelectionMode: (input: Parameters<typeof setSubagentModelSelectionMode>[0]) => answer(() => setSubagentModelSelectionMode(input), true),
}
export { subagentModelsRpc }
