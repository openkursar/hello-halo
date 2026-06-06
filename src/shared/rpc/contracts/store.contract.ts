/**
 * Store (App Registry) RPC contract (passthrough). Channels preserve their
 * existing return shapes verbatim. `store:install` is excluded: its preload
 * binding wraps a progress-event listener around the invoke and cannot be
 * expressed as a one-line passthrough.
 */
import { rawRpcMethod } from '../define'

export const storeRpc = {
  storeQuery: rawRpcMethod('store:query'),
  storeListApps: rawRpcMethod('store:list-apps'),
  storeGetAppDetail: rawRpcMethod('store:get-app-detail'),
  storeRefresh: rawRpcMethod('store:refresh'),
  storeCheckUpdates: rawRpcMethod('store:check-updates'),
  storeGetRegistries: rawRpcMethod('store:get-registries'),
  storeAddRegistry: rawRpcMethod('store:add-registry'),
  storeRemoveRegistry: rawRpcMethod('store:remove-registry'),
  storeToggleRegistry: rawRpcMethod('store:toggle-registry'),
  storeUpdateRegistryAdapterConfig: rawRpcMethod('store:update-registry-adapter-config'),
}
