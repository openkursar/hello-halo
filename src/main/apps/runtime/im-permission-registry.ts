/**
 * apps/runtime -- IM Permission Registry
 *
 * Session-scoped registry that maps conversationId → the chat's last sender
 * and their standing.
 *
 * A message's own turn does not read it: dispatch-inbound hands the standing to
 * app-chat with the message (`AppChatRequest.imPermission`), so a message that
 * arrives in between can never change who a turn answers to. What reads it is a
 * turn with no sender of its own — a team-fronted chat woken by a teammate —
 * which takes the chat's last sender as it begins. Nothing reads it in the
 * middle of a turn: a tool that needs the turn's sender (the reminder tool,
 * for who set a reminder) asks app-chat for the sender of the turn it runs in.
 *
 * Architecture:
 *   dispatch-inbound.ts → set()   (the sender of each message it starts a turn for)
 *   reminders/delivery  → set()   (the person who asked, for a reminder's turn)
 *   app-chat.ts         → get()   (a turn without a sender, as it begins)
 *   dispatch-inbound.ts, chat-reset.ts → clear() (on /clear, and clearing all chats)
 *
 * Only IM-originated sessions have entries here; native Halo chat and
 * automation runs are unaffected.
 *
 * Lifecycle:
 *   - Entry is set (or overwritten) for every inbound IM message that starts a
 *     turn — the LATEST sender (group chats share a session).
 *   - Entry is cleared when the session is explicitly reset (/clear).
 *   - Entries are NOT persisted — they exist only while the process is alive.
 *     On restart, the next inbound message re-creates the entry.
 */

import type { GuestPolicy, ImPermissionContext } from '../../../shared/types/im-channel'

// Re-exported so consumers can import from a single location
export type { GuestPolicy, ImPermissionContext }

// ============================================
// Types
// ============================================

// ============================================
// Registry (module-level singleton)
// ============================================

const registry = new Map<string, ImPermissionContext>()

/**
 * Set (or overwrite) the permission context for a conversation.
 * Called by dispatch-inbound.ts on every inbound IM message.
 */
export function setImPermissionContext(conversationId: string, ctx: ImPermissionContext): void {
  registry.set(conversationId, ctx)
}

/**
 * Get the current permission context for a conversation.
 * Returns undefined for non-IM sessions (native chat, automation runs).
 */
export function getImPermissionContext(conversationId: string): ImPermissionContext | undefined {
  return registry.get(conversationId)
}

/**
 * Clear the permission context for a conversation.
 * Called on session reset (/halo-clear) and session removal.
 */
export function clearImPermissionContext(conversationId: string): void {
  registry.delete(conversationId)
}

/**
 * Clear all permission contexts. Used during shutdown cleanup.
 */
export function clearAllImPermissionContexts(): void {
  registry.clear()
}
