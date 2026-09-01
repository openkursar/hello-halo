/**
 * apps/runtime/im-channels -- Public API
 *
 * Multi-instance IM channel management.
 * Provides ImChannelManager + built-in provider registration.
 *
 * Module-level accessor pattern (mirrors im-session-registry):
 *   - runtime/index.ts calls setActiveImChannelManager() after creating the manager
 *   - dispatch-inbound.ts imports getActiveImChannelManager() to look up fileCapability
 *   - This avoids circular imports (dispatch-inbound ← runtime/index ← dispatch-inbound)
 */

export { ImChannelManager } from './manager'
export { WecomBotProvider } from './wecom-bot.provider'
export { WeixinIlinkBotProvider } from './weixin-ilink.provider'

import { cleanupWecomTempFiles } from './wecom-bot.provider'
import { cleanupWeixinIlinkTempFiles } from './weixin-ilink.provider'
import type { ImChannelManager } from './manager'

/**
 * Remove stale temp files for all IM channel providers.
 *
 * Each provider manages its own temp directory; this is the single call site
 * for bootstrap — it knows nothing about individual provider paths.
 * Add a new provider's cleanup here when it downloads media to disk.
 */
export function cleanupImChannelTempFiles(): void {
  cleanupWecomTempFiles()
  cleanupWeixinIlinkTempFiles()
  // Future: cleanupFeishuTempFiles(), cleanupDingTalkTempFiles()
}

// ============================================
// Module-level accessor (avoids circular imports)
// ============================================

let _activeManager: ImChannelManager | null = null

/**
 * Set the active ImChannelManager instance.
 * Called by runtime/index.ts immediately after creating the manager.
 */
export function setActiveImChannelManager(manager: ImChannelManager | null): void {
  _activeManager = manager
}

/**
 * Get the active ImChannelManager instance.
 * Returns null before runtime initialization or after shutdown.
 * Used by dispatch-inbound.ts to resolve fileCapability without circular imports.
 */
export function getActiveImChannelManager(): ImChannelManager | null {
  return _activeManager
}
