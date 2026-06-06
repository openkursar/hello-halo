/**
 * Conversation RPC contract (passthrough). Channels preserve their existing
 * `{ success, data } | { success, error }` return shapes verbatim.
 */
import { rawRpcMethod } from '../define'

export const conversationRpc = {
  listConversations: rawRpcMethod('conversation:list'),
  createConversation: rawRpcMethod('conversation:create'),
  getConversation: rawRpcMethod('conversation:get'),
  updateConversation: rawRpcMethod('conversation:update'),
  deleteConversation: rawRpcMethod('conversation:delete'),
  addMessage: rawRpcMethod('conversation:add-message'),
  updateLastMessage: rawRpcMethod('conversation:update-last-message'),
  getMessageThoughts: rawRpcMethod('conversation:get-thoughts'),
  toggleStarConversation: rawRpcMethod('conversation:toggle-star'),
}
