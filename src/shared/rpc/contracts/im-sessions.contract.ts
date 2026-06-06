/**
 * IM-sessions RPC contract (passthrough — handler bodies preserved). Generic,
 * provider-agnostic session management (see ARCHITECTURE.md §22).
 */
import { rawRpcMethod } from '../define'

export const imSessionsRpc = {
  imSessionsList: rawRpcMethod('im-sessions:list'),
  imSessionsSetProactive: rawRpcMethod('im-sessions:set-proactive'),
  imSessionsRemove: rawRpcMethod('im-sessions:remove'),
  imSessionsSetCustomName: rawRpcMethod('im-sessions:set-custom-name'),
}
