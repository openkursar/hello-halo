/**
 * Search RPC contract (passthrough — handler bodies preserved). search:execute
 * carries its own searchId/cancellation flow; search:cancel returns void.
 */
import { rawRpcMethod } from '../define'

export const searchRpc = {
  search: rawRpcMethod('search:execute'),
  cancelSearch: rawRpcMethod('search:cancel'),
}
