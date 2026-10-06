/**
 * Config RPC contract (passthrough). Settings load/save, API validation,
 * model discovery, and AI-sources CRUD. Handler bodies build their own
 * `{ success, data | error }` envelopes, so these are raw passthrough.
 */
import { rawRpcMethod } from '../define'

/** `code` of a write declined because config.json cannot be read: nothing was saved. */
export const CONFIG_UNREADABLE_CODE = 'CONFIG_UNREADABLE'

/**
 * `code` of a whole-settings save declined because the client's settings were
 * loaded before the latest failed read of config.json, or during it: nothing
 * was saved, and the client should reload its settings.
 *
 * The stamp that decides this travels as `configEpoch` on a config:get
 * response and comes back as the second argument of config:set
 * (`?snapshotEpoch=` on `POST /api/config`).
 */
export const CONFIG_RELOAD_REQUIRED_CODE = 'CONFIG_RELOAD_REQUIRED'

export const configRpc = {
  getConfig: rawRpcMethod('config:get'),
  setConfig: rawRpcMethod('config:set'),
  getCredentialFailures: rawRpcMethod('config:get-credential-failures'),
  getConfigReadFailure: rawRpcMethod('config:get-read-failure'),
  validateApi: rawRpcMethod('config:validate-api'),
  fetchModels: rawRpcMethod('config:fetch-models'),
  refreshAISourcesConfig: rawRpcMethod('config:refresh-ai-sources'),
  aiSourcesSwitchSource: rawRpcMethod('ai-sources:switch-source'),
  aiSourcesSetModel: rawRpcMethod('ai-sources:set-model'),
  aiSourcesAddSource: rawRpcMethod('ai-sources:add-source'),
  aiSourcesUpdateSource: rawRpcMethod('ai-sources:update-source'),
  aiSourcesDeleteSource: rawRpcMethod('ai-sources:delete-source'),
}
