import { rawRpcMethod, type RpcResponse } from '../define'
import type { SubagentModelInput, SubagentModelModeInput, SubagentModelRevisionInput, SubagentModelSettings, SubagentModelUpdate } from '../../types/subagent-models'
export type SubagentModelResponse = RpcResponse<SubagentModelSettings> & { code?: string }
export const subagentModelsRpc = {
  listSubagentModels: rawRpcMethod<[], SubagentModelResponse>('subagent-models:list'),
  createSubagentModel: rawRpcMethod<[input: SubagentModelInput], SubagentModelResponse>('subagent-models:create'),
  updateSubagentModel: rawRpcMethod<[input: SubagentModelUpdate], SubagentModelResponse>('subagent-models:update'),
  clearBuiltinSubagentModel: rawRpcMethod<[input: SubagentModelRevisionInput], SubagentModelResponse>('subagent-models:clear-builtin'),
  deleteSubagentModel: rawRpcMethod<[input: SubagentModelRevisionInput], SubagentModelResponse>('subagent-models:delete'),
  setSubagentModelSelectionMode: rawRpcMethod<[input: SubagentModelModeInput], SubagentModelResponse>('subagent-models:set-selection-mode'),
}
