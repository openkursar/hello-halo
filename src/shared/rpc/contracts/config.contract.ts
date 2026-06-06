/**
 * Config RPC contract (passthrough). Settings load/save, API validation,
 * model discovery, and AI-sources CRUD. Handler bodies build their own
 * `{ success, data | error }` envelopes, so these are raw passthrough.
 */
import { rawRpcMethod } from '../define'

export const configRpc = {
  getConfig: rawRpcMethod('config:get'),
  setConfig: rawRpcMethod('config:set'),
  validateApi: rawRpcMethod('config:validate-api'),
  fetchModels: rawRpcMethod('config:fetch-models'),
  refreshAISourcesConfig: rawRpcMethod('config:refresh-ai-sources'),
  aiSourcesSwitchSource: rawRpcMethod('ai-sources:switch-source'),
  aiSourcesSetModel: rawRpcMethod('ai-sources:set-model'),
  aiSourcesAddSource: rawRpcMethod('ai-sources:add-source'),
  aiSourcesUpdateSource: rawRpcMethod('ai-sources:update-source'),
  aiSourcesDeleteSource: rawRpcMethod('ai-sources:delete-source'),
}
