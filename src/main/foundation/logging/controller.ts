/**
 * Logging Controller — Central Orchestrator
 *
 * Single source of truth for Developer Mode state. When toggled, this module
 * orchestrates all logging transports:
 *
 *   1. Global log level  — switches electron-log file transport between
 *      'info' and 'debug', so all console.debug() calls across the main
 *      process are either written to main.log or silently dropped.
 *
 *   2. HTTP request/response logging — toggles the dedicated http-raw.log
 *      transport via setHttpLogging().
 *
 *   3. SDK logging — bumps halo-sdk.log between 'info' and 'debug'
 *      via setSdkLogLevel().
 *
 * Adding a new logging transport:
 *   1. Create a new <name>-transport.ts in this directory.
 *   2. Expose a setLevel/setEnabled function.
 *   3. Call it from applyDeveloperMode() below.
 *   No additional config subscriptions needed — this module is the only
 *   subscriber for the developerMode config field.
 *
 * Controlled by: Settings > Advanced > Developer Mode
 * Config field: config.agent.developerMode
 */

import log from 'electron-log/main.js'
import { getConfig, onAgentConfigChange } from '../config.service'
import { setHttpLogging } from './http-transport'
import { setSdkLogLevel } from './sdk-transport'

let _enabled = false

/**
 * Whether Developer Mode is currently active.
 * O(1) in-memory check — safe for hot paths.
 */
export function isDeveloperMode(): boolean {
  return _enabled
}

/**
 * Apply Developer Mode state change across all logging transports.
 * Idempotent — no-op if state is unchanged.
 */
function applyDeveloperMode(enabled: boolean): void {
  if (_enabled === enabled) return
  _enabled = enabled

  // Always log the transition at info level (visible regardless of mode)
  console.log(`[Logging] Developer Mode ${enabled ? 'ENABLED' : 'DISABLED'} — file log level: ${enabled ? 'debug' : 'info'}`)

  // 1. Global log level (main.log)
  log.transports.file.level = enabled ? 'debug' : 'info'

  // 2. HTTP request/response logging (dedicated http-raw.log)
  setHttpLogging(enabled)

  // 3. SDK logging level (dedicated halo-sdk.log)
  setSdkLogLevel(enabled ? 'debug' : 'info')
}

// ============================================================================
// Self-registration — runs at module load time
// ============================================================================

// Initialize via applyDeveloperMode to avoid duplicating logic (DRY).
// Force apply by temporarily setting _enabled to opposite of initial state.
const initialState = getConfig().agent?.developerMode ?? false
_enabled = !initialState  // ensure applyDeveloperMode doesn't short-circuit
applyDeveloperMode(initialState)

// Single config subscription for all logging transports
onAgentConfigChange((agent) => {
  applyDeveloperMode(agent?.developerMode ?? false)
})
