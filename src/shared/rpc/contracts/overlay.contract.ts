/**
 * Overlay RPC contract (passthrough). Floating chat-capsule UI rendered above
 * the embedded BrowserView. Handler bodies and return shapes preserved verbatim.
 */
import { rawRpcMethod } from '../define'

export const overlayRpc = {
  showChatCapsuleOverlay: rawRpcMethod('overlay:show-chat-capsule'),
  hideChatCapsuleOverlay: rawRpcMethod('overlay:hide-chat-capsule'),
}
