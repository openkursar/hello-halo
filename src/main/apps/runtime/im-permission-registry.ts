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
 * which takes the chat's last sender as it begins.
 *
 * Architecture:
 *   dispatch-inbound.ts → set()   (the sender of each message it starts a turn for)
 *   app-chat.ts         → get()   (a turn without a sender, as it begins)
 *   dispatch-inbound.ts → clear() (on /clear)
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

import type { GuestPolicy } from '../../../shared/types/im-channel'

// Re-export GuestPolicy so consumers can import from a single location
export type { GuestPolicy }

// ============================================
// Types
// ============================================

/**
 * Per-message permission context stored in the registry.
 *
 * Updated on every inbound dispatch — always reflects the latest sender.
 */
export interface ImPermissionContext {
  /** Platform-side user ID of the message sender */
  senderId: string
  /** Display name of the sender */
  senderName: string
  /** Whether this sender is in the channel instance's owners list */
  isOwner: boolean
  /** Resolved guest policy (from channel instance config). Only meaningful when !isOwner. */
  guestPolicy?: GuestPolicy
  /** Owner user IDs for security prompt injection. Present when owners are configured. */
  ownerIds?: string[]
}

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
