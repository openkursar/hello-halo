/**
 * Which conversation-scoped agent events a client receives.
 *
 * A client (the desktop window, each remote WebSocket client) declares the
 * conversations whose streaming detail it renders. Those get every event. Every
 * other conversation gets only its status events — enough for task lists, the
 * people inbox and "is running" indicators — so a background digital human's
 * token stream never reaches a window that is not showing it.
 *
 * One rule for every transport: the IPC forwarder and the WebSocket server both
 * call `shouldDeliverAgentEvent`.
 */

/**
 * Status events: low-frequency, needed for any conversation a client lists.
 * - turn-start / complete / error: running state and completion badges
 * - ask-question: a turn is blocked on the user
 * - goal-updated: goal state shown outside the conversation view
 * Plus `agent:tool-call` events that request approval (see isBlockingToolCall).
 */
export const AGENT_STATUS_CHANNELS: ReadonlySet<string> = new Set([
  'agent:turn-start',
  'agent:complete',
  'agent:error',
  'agent:ask-question',
  'agent:goal-updated',
])

export function isAgentStatusChannel(channel: string): boolean {
  return AGENT_STATUS_CHANNELS.has(channel)
}

/**
 * A tool call waiting for the user's approval blocks the turn exactly like a
 * question does, so it travels as status even though other tool calls are detail.
 */
function isBlockingToolCall(channel: string, data: unknown): boolean {
  return channel === 'agent:tool-call' && (data as { requiresApproval?: unknown } | null)?.requiresApproval === true
}

/**
 * Deliver an event for `conversationId` on `channel` (payload `data`) to a
 * client that renders the detail of `detailConversations`.
 */
export function shouldDeliverAgentEvent(
  channel: string,
  conversationId: string,
  detailConversations: ReadonlySet<string>,
  data?: unknown,
): boolean {
  return AGENT_STATUS_CHANNELS.has(channel)
    || detailConversations.has(conversationId)
    || isBlockingToolCall(channel, data)
}
