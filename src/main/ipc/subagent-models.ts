import { subagentModelsRpc } from '../../shared/rpc/contracts/subagent-models.contract'
import { subagentModelHandlers } from '../controllers/subagent-models.controller'
import { registerRawRpcHandlers } from './rpc'
export function registerSubagentModelsHandlers(): void {
  registerRawRpcHandlers(subagentModelsRpc, subagentModelHandlers)
}
