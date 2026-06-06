/**
 * Space RPC contract (passthrough). Channels preserve their existing
 * `{ success, data } | { success, error }` return shapes verbatim.
 */
import { rawRpcMethod } from '../define'

export const spaceRpc = {
  getHaloSpace: rawRpcMethod('space:get-halo'),
  listSpaces: rawRpcMethod('space:list'),
  createSpace: rawRpcMethod('space:create'),
  deleteSpace: rawRpcMethod('space:delete'),
  getSpace: rawRpcMethod('space:get'),
  openSpaceFolder: rawRpcMethod('space:open-folder'),
  updateSpace: rawRpcMethod('space:update'),
  getDefaultSpacePath: rawRpcMethod('space:get-default-path'),
  selectFolder: rawRpcMethod('dialog:select-folder'),
  updateSpacePreferences: rawRpcMethod('space:update-preferences'),
  getSpacePreferences: rawRpcMethod('space:get-preferences'),
}
