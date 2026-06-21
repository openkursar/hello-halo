/**
 * apps/runtime/im-channels -- Owner Auto-Claim (channel-agnostic)
 *
 * Binds the first direct-message sender as the owner of an IM channel
 * instance that has permission control enabled but no owners configured.
 *
 * Why this exists:
 *   Enterprise builds default new instances to `permissionEnabled: true`
 *   with empty `owners`, which makes everyone — including the creator —
 *   a deny-all guest. Asking users to look up their own platform user ID
 *   (e.g. by prompting the LLM) is error-prone and hallucination-prone.
 *   Since Halo is a personal client, the instance creator is the person
 *   who first DMs the bot, so first-direct-sender == owner holds in
 *   practice across all providers (WeCom / Feishu / DingTalk / ...).
 *
 * Claim condition (checked here, channel-agnostic):
 *   `permissionEnabled === true` AND `owners` is empty/undefined.
 *   The direct-vs-group distinction is enforced by the caller
 *   (dispatch-inbound) — group chats never auto-claim.
 *
 * Concurrency:
 *   Idempotent. The check + write run on Node.js's single event loop with
 *   no `await` between read and conditional, so there is no double-claim
 *   window; a later concurrent inbound finds `owners` non-empty and no-ops.
 *
 * Persistence + WS continuity:
 *   `owners` is a top-level field of `ImChannelInstanceConfig`, NOT inside
 *   the provider config bag, so `ImChannelManager.configEqual` ignores it.
 *   The manager snapshot is refreshed via `updateInstanceConfigSnapshot`
 *   (pure snapshot replacement — no lifecycle action), so the channel
 *   connection is never torn down and the inbound message that triggered
 *   the claim continues uninterrupted.
 */

import { getConfig, saveConfig } from '../../../foundation/config.service'
import { invalidateImSessions } from '../../../services/agent/session-manager'
import { sendToRenderer } from '../../../foundation/window.service'
import { broadcastToAll } from '../../../http/websocket'
import { getActiveImChannelManager } from './index'

// ============================================
// Logging
// ============================================

const LOG_TAG = '[ImOwnerClaim]'

// ============================================
// Public API
// ============================================

/**
 * If the given instance has permission control enabled and no owners yet,
 * bind the supplied sender as its sole owner.
 *
 * On a successful claim this helper performs four side-effects in order:
 *   1. Persist the updated instance to `config.json` via `saveConfig`.
 *   2. Refresh the `ImChannelManager` snapshot via
 *      `updateInstanceConfigSnapshot` — a pure snapshot replacement with
 *      no lifecycle action, so no WS reconnect occurs.
 *   3. Invalidate any IM agent sessions that may have been created with
 *      stale permission context (defense-in-depth — mirrors the
 *      `im-channels:reload` IPC handler's behavior). No-op when no
 *      sessions exist (typical first-message case).
 *   4. Broadcast `im-channels:instance-updated` to both Electron renderer
 *      and remote WebSocket clients so the Settings UI reflects the new
 *      `owners` list without manual refresh.
 *
 * Returns `true` when a claim write was performed, `false` otherwise
 * (permission control off, owners already set, instance missing, sender
 * empty, or persistence error). Callers use the return value to decide
 * whether to push a one-time welcome message.
 *
 * Caller contract:
 *   - Only invoke for direct messages (group auto-claim is intentionally
 *     unsupported — first-sender-wins would be unsafe in groups).
 *   - Must be awaited before permission resolution in `dispatch-inbound`,
 *     so it sees the updated owners list.
 *
 * @param instanceId - IM channel instance ID (matches ImChannelInstanceConfig.id)
 * @param ownerId    - Platform-side user ID of the direct-message sender
 */
export async function maybeClaimOwner(
  instanceId: string,
  ownerId: string,
): Promise<boolean> {
  if (!instanceId || !ownerId) {
    return false
  }

  const config = getConfig()
  const instances = config.imChannels?.instances ?? []
  const idx = instances.findIndex((inst) => inst.id === instanceId)
  if (idx === -1) {
    console.warn(
      `${LOG_TAG} Instance not found: instanceId=${instanceId} (likely just removed)`,
    )
    return false
  }

  const current = instances[idx]

  // Claim only applies when permission control is on but unconfigured.
  if (current.permissionEnabled !== true) {
    return false
  }
  if (Array.isArray(current.owners) && current.owners.length > 0) {
    return false
  }

  // Replace rather than append: an unconfigured instance is single-owner
  // at claim time; the user can add more owners in Settings afterwards.
  const updatedInstance = {
    ...current,
    owners: [ownerId],
  }
  const updated = instances.map((inst) =>
    inst.id === instanceId ? updatedInstance : inst,
  )

  try {
    saveConfig({ imChannels: { ...config.imChannels, instances: updated } })
  } catch (err) {
    console.error(
      `${LOG_TAG} saveConfig failed: instanceId=${instanceId}, ` +
        `err=${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }

  // Refresh the manager snapshot so the next dispatch reads the new values.
  // Pure snapshot replacement — no lifecycle action, no WS reconnect.
  const manager = getActiveImChannelManager()
  if (manager && !manager.updateInstanceConfigSnapshot(updatedInstance)) {
    // Persistence already succeeded; the next full applyConfig (manager
    // reload) picks up the owners. Only the current message may transiently
    // see the stale snapshot. Don't fail the claim for this.
    console.warn(
      `${LOG_TAG} Snapshot refresh skipped (instance not in manager snapshot): ` +
        `instanceId=${instanceId}`,
    )
  }

  // Invalidate any cached IM agent sessions so the new permission context
  // takes effect on the next inbound message without requiring a restart.
  // Mirrors the established `im-channels:reload` IPC pattern. No-op when no
  // sessions exist (the common first-message scenario).
  try {
    invalidateImSessions()
  } catch (err) {
    console.error(
      `${LOG_TAG} invalidateImSessions failed (non-critical): ` +
        `err=${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Notify renderer + remote clients that this instance's config changed.
  // The Settings UI listens to this and patches its local state so the
  // owners list appears immediately, without the user needing to refresh.
  const updatePayload = {
    instanceId,
    instance: updatedInstance as unknown as Record<string, unknown>,
  }
  try {
    sendToRenderer('im-channels:instance-updated', updatePayload)
    broadcastToAll('im-channels:instance-updated', updatePayload)
  } catch (err) {
    console.error(
      `${LOG_TAG} instance-updated broadcast failed (non-critical): ` +
        `err=${err instanceof Error ? err.message : String(err)}`,
    )
  }

  console.log(
    `${LOG_TAG} Owner claimed: instanceId=${instanceId}, ` +
      `ownerPrefix=${ownerId.slice(0, 8)}`,
  )
  return true
}
