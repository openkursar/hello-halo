import { httpRequest, isElectron, onEvent } from './_shared'
import type { SubagentModelResponse } from '../../shared/rpc/contracts/subagent-models.contract'
import type { SubagentModelInput, SubagentModelModeInput, SubagentModelRevisionInput, SubagentModelUpdate, SubagentModelsChangedEvent } from '../../shared/types/subagent-models'

export const subagentModelsApi = {
  listSubagentModels: async (): Promise<SubagentModelResponse> => isElectron()
    ? window.halo.listSubagentModels() : httpRequest('GET', '/api/subagent-models'),
  createSubagentModel: async (input: SubagentModelInput): Promise<SubagentModelResponse> => isElectron()
    ? window.halo.createSubagentModel(input) : httpRequest('POST', '/api/subagent-models/create', { ...input }),
  updateSubagentModel: async (input: SubagentModelUpdate): Promise<SubagentModelResponse> => isElectron()
    ? window.halo.updateSubagentModel(input) : httpRequest('POST', '/api/subagent-models/update', { ...input }),
  clearBuiltinSubagentModel: async (input: SubagentModelRevisionInput): Promise<SubagentModelResponse> => isElectron()
    ? window.halo.clearBuiltinSubagentModel(input) : httpRequest('POST', '/api/subagent-models/clear-builtin', { ...input }),
  deleteSubagentModel: async (input: SubagentModelRevisionInput): Promise<SubagentModelResponse> => isElectron()
    ? window.halo.deleteSubagentModel(input) : httpRequest('POST', '/api/subagent-models/delete', { ...input }),
  setSubagentModelSelectionMode: async (input: SubagentModelModeInput): Promise<SubagentModelResponse> => isElectron()
    ? window.halo.setSubagentModelSelectionMode(input) : httpRequest('POST', '/api/subagent-models/set-selection-mode', { ...input }),
  onSubagentModelsChanged: (callback: (data: SubagentModelsChangedEvent) => void): (() => void) => onEvent('subagent-models:changed', callback),
}
