/**
 * Task-state RPC contract (passthrough). Channels return the controller's
 * `{ success, data } | { success, error }` shape verbatim.
 */
import { rawRpcMethod } from '../define'

export const taskRpc = {
  taskListState: rawRpcMethod('task:list-state'),
  taskMarkUnseen: rawRpcMethod('task:mark-unseen'),
  taskMarkRead: rawRpcMethod('task:mark-read'),
  taskSetKept: rawRpcMethod('task:set-kept'),
  taskRemoveState: rawRpcMethod('task:remove-state'),
}
