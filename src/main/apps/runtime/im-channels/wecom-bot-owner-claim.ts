/**
 * apps/runtime/im-channels -- WeCom Bot Owner Auto-Claim
 *
 * One-shot owner-binding helper, scoped to the WeCom Intelligent Bot
 * scan-auth (QR-code) onboarding flow.
 *
 * Why this exists:
 *   The WeCom Intelligent Bot scan-auth protocol returns only bot credentials
 *   (`botid` + `secret`); it never surfaces the scanning user's identity.
 *   This is anomalous compared to other IM platforms (Feishu / DingTalk /
 *   Slack / Telegram OAuth, etc.), which return the authorizing user as a
 *   first-class part of the auth response. Because of this gap, scan-auth
 *   instances are persisted with `permissionEnabled: true`, `owners: []`,
 *   and `pendingOwnerClaim: true` — and the first inbound message in WeCom
 *   binds its sender as the owner (the bot is only visible to its creator,
 *   so "first sender == creator" holds by protocol).
 *
 * Scope:
 *   This helper is wecom-bot specific. Manual-config (paste botid+secret)
 *   instances and other providers do not set `pendingOwnerClaim` and never
 *   execute this code path.
 *
 * Concurrency:
 *   Idempotent. A second concurrent inbound finds `pendingOwnerClaim` already
 *   cleared and returns early. The check + write run on Node.js's single
 *   event loop with no `await` between read and conditional, so there is no
 *   double-claim window.
 *
 * Persistence + WS continuity:
 *   The flag lives at the top level of `ImChannelInstanceConfig`, NOT inside
 *   the provider config bag, so `ImChannelManager.configEqual` ignores it.
 *   Likewise `owners` is a top-level field. Result: writing both fields
 *   triggers an `applyConfig` snapshot refresh (so the next dispatch reads
 *   the new values) but does NOT tear down the WebSocket connection — the
 *   inbound message that triggered the claim continues uninterrupted.
 */

import { getConfig, saveConfig } from '../../../foundation/config.service'
import { invalidateImSessions } from '../../../services/agent/session-manager'
import { sendToRenderer } from '../../../foundation/window.service'
import { broadcastToAll } from '../../../http/websocket'
import { getActiveImChannelManager } from './index'
import { dispatchInboundMessage } from '../dispatch-inbound'

// ============================================
// Logging
// ============================================

const LOG_TAG = '[WecomOwnerClaim]'

// ============================================
// Public API
// ============================================

/**
 * If the given wecom-bot instance is in `pendingOwnerClaim` state, bind the
 * supplied sender as its sole owner and clear the flag.
 *
 * On a successful claim this helper performs four side-effects in order:
 *   1. Persist the updated instance to `config.json` via `saveConfig`.
 *   2. Refresh the `ImChannelManager` snapshot via `applyConfig` (no WS
 *      reconnect — `configEqual` ignores both `pendingOwnerClaim` and
 *      `owners`, which are top-level fields outside the provider bag).
 *   3. Invalidate any IM agent sessions that may have been created with
 *      stale permission context (defense-in-depth — mirrors the
 *      `im-channels:reload` IPC handler's behavior). No-op when no
 *      sessions exist (typical first-message case).
 *   4. Broadcast `im-channels:instance-updated` to both Electron renderer
 *      and remote WebSocket clients so the Settings UI reflects the new
 *      `owners` list without manual refresh.
 *
 * Returns `true` when a claim write was performed, `false` otherwise (already
 * claimed, instance missing, sender empty, or persistence error). Callers
 * use the return value to decide whether to show a one-time welcome message
 * — the authoritative config state is also reachable via
 * `ImChannelManager.getInstanceConfig` after this returns.
 *
 * Caller contract:
 *   - Only invoke for wecom-bot instances (the helper double-checks `type`
 *     defensively and no-ops otherwise).
 *   - Must be awaited before forwarding the inbound to `dispatch-inbound`,
 *     so the permission resolution there sees the updated owners list.
 *
 * @param instanceId - IM channel instance ID (matches ImChannelInstanceConfig.id)
 * @param ownerId    - Platform-side userid of the first message sender
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

  // Defensive scope check — this helper is wecom-bot specific.
  if (current.type !== 'wecom-bot') {
    return false
  }

  // Idempotency: not pending → no-op. Handles both "already claimed by a
  // concurrent inbound" and "manually configured owners (user took control)".
  if (!current.pendingOwnerClaim) {
    return false
  }

  // Compose the updated instance. We deliberately replace `owners` (rather
  // than append) because scan-auth bots are single-owner by protocol.
  const updatedInstance = {
    ...current,
    owners: [ownerId],
    pendingOwnerClaim: false,
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
  // configEqual ignores `pendingOwnerClaim` and `owners` (both top-level,
  // not part of the provider config bag), so no WS reconnect occurs.
  const manager = getActiveImChannelManager()
  if (manager) {
    try {
      manager.applyConfig(updated, (iid, appId, msg, reply) => {
        dispatchInboundMessage(msg, reply, appId, iid)
      })
    } catch (err) {
      console.error(
        `${LOG_TAG} applyConfig refresh failed: instanceId=${instanceId}, ` +
          `err=${err instanceof Error ? err.message : String(err)}`,
      )
      // Persistence already succeeded, so subsequent inbound messages will
      // still resolve correctly on the next manager reload — only the
      // current message may transiently see the stale snapshot. Don't fail
      // the claim for this.
    }
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
