/**
 * Apps bridge — dependency-inversion seam for the services tier.
 *
 * The Apps layer sits ABOVE services in the dependency DAG
 * (`apps -> services -> platform -> foundation`). A handful of services
 * (the agent engine, space service) legitimately need app data at runtime
 * — the installed MCP apps for a space, the in-process "Halo Apps" MCP
 * server, and notification when MCP apps change. Importing `apps/*` from
 * `services/*` would invert the layer direction.
 *
 * Instead, services depend on this bridge (same tier), and the Apps layer
 * registers its concrete implementations at startup via `registerAppBridge`
 * (a downward call). This mirrors the IM-channel manager accessor pattern
 * in `apps/runtime/im-channels/index.ts`.
 *
 * Type-only imports from `apps/*` are erased at compile time and create no
 * runtime edge, so they are used freely here to keep the surface typed.
 */

import type { AppManagerService } from '../apps/manager'

/** Handler invoked when MCP apps change. `spaceId === null` = global change. */
export type McpAppsChangeHandler = (spaceId: string | null) => void

interface AppBridgeImpl {
  getAppManager: () => AppManagerService | null
  createHaloAppsMcpServer: (spaceId: string) => unknown
  onMcpAppsChange: (handler: McpAppsChangeHandler) => () => void
}

let impl: AppBridgeImpl | null = null

/**
 * Wire the Apps layer into the services tier. Called once by
 * `apps/runtime` during startup, before any agent session is created or
 * any space is deleted.
 */
export function registerAppBridge(bridge: AppBridgeImpl): void {
  impl = bridge
}

/**
 * The installed-app manager, or null when the Apps layer has not been
 * wired yet (e.g. very early startup, or in unit tests that don't boot
 * the Apps runtime). Callers already null-check this.
 */
export function getAppManager(): AppManagerService | null {
  return impl?.getAppManager() ?? null
}

/**
 * Build the in-process "Halo Apps" MCP server for a space, or null when
 * the Apps layer has not been wired. Returning null simply omits the
 * `halo-apps` MCP server from the session's tool set.
 */
export function createHaloAppsMcpServer(spaceId: string): unknown {
  return impl ? impl.createHaloAppsMcpServer(spaceId) : null
}

/**
 * Subscribe to MCP-apps changes. No-op (returns a no-op unsubscribe) when
 * the Apps layer has not been wired yet.
 */
export function onMcpAppsChange(handler: McpAppsChangeHandler): () => void {
  if (!impl) return () => {}
  return impl.onMcpAppsChange(handler)
}
