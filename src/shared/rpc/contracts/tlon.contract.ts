/**
 * Tlon (knowledge base) RPC contract (passthrough). Channels preserve their
 * `{ success, data } | { success, error }` return shapes verbatim.
 */
import { rawRpcMethod } from '../define'

export const tlonRpc = {
  tlonCreate: rawRpcMethod('tlon:create'),
  tlonList: rawRpcMethod('tlon:list'),
  tlonListForSpace: rawRpcMethod('tlon:list-for-space'),
  tlonGet: rawRpcMethod('tlon:get'),
  tlonUpdate: rawRpcMethod('tlon:update'),
  tlonDelete: rawRpcMethod('tlon:delete'),
  tlonSetDefault: rawRpcMethod('tlon:set-default'),
  tlonBindSpace: rawRpcMethod('tlon:bind-space'),
  tlonUnbindSpace: rawRpcMethod('tlon:unbind-space'),
  tlonBindApp: rawRpcMethod('tlon:bind-app'),
  tlonUnbindApp: rawRpcMethod('tlon:unbind-app'),
  tlonAddLinkedDir: rawRpcMethod('tlon:add-linked-dir'),
  tlonRemoveLinkedDir: rawRpcMethod('tlon:remove-linked-dir'),
  tlonAddFiles: rawRpcMethod('tlon:add-files'),
  tlonListRaw: rawRpcMethod('tlon:list-raw'),
  tlonRemoveRaw: rawRpcMethod('tlon:remove-raw'),
  tlonListWiki: rawRpcMethod('tlon:list-wiki'),
  tlonReadWiki: rawRpcMethod('tlon:read-wiki'),
  tlonReadIndex: rawRpcMethod('tlon:read-index'),
  tlonTriggerIngest: rawRpcMethod('tlon:trigger-ingest'),
  tlonClearRelearn: rawRpcMethod('tlon:clear-relearn'),
  tlonGetIngestStatus: rawRpcMethod('tlon:get-ingest-status'),
  tlonPickFiles: rawRpcMethod('tlon:pick-files'),
  tlonPickFolder: rawRpcMethod('tlon:pick-folder'),
}
