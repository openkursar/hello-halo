/**
 * apps/manager -- Public API
 *
 * App lifecycle management: install, configure, pause, resume, uninstall.
 *
 * This is the data/persistence layer for App management. It does NOT execute
 * Apps, trigger scheduling, or call Agents. Those responsibilities belong
 * to apps/runtime, which consumes this module's AppManagerService interface.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initAppManager } from '../apps/manager'
 *   import type { DatabaseManager } from '../platform/store'
 *
 *   const appManager = await initAppManager({ db })
 *
 * Usage in consuming modules:
 *
 *   import type { AppManagerService, InstalledApp } from '../apps/manager'
 *
 *   function activate(appManager: AppManagerService, appId: string) {
 *     const app = appManager.getApp(appId)
 *     if (!app) throw new Error('App not found')
 *     // ...
 *   }
 */

import { join } from 'path'
import type { DatabaseManager } from '../../platform/store'
import { getSpace } from '../../services/space.service'
import { getHaloDir } from '../../foundation/config.service'
import { AppManagerStore } from './store'
import { createAppManagerService } from './service'
import { MIGRATION_NAMESPACE, migrations } from './migrations'
import type { AppManagerService } from './types'

// Re-export types for consumers
export type {
  AppManagerService,
  InstalledApp,
  AppStatus,
  RunOutcome,
  AppListFilter,
  StatusChangeHandler,
  Unsubscribe,
  UninstallOptions,
  UpgradeStrategy,
  DeleteAppOptions,
} from './types'

// Re-export helpers
export { isBuiltinApp } from './types'

// Re-export error types
export {
  AppNotFoundError,
  AppAlreadyInstalledError,
  InvalidStatusTransitionError,
  SpaceNotFoundError,
  BuiltinAppProtectedError,
} from './errors'

// Re-export the built-in loader entry point so bootstrap can wire it up
export { loadBuiltinApps, countBuiltinAppsOnDisk } from './builtin-loader'

// ============================================
// Module State
// ============================================

let managerInstance: AppManagerService | null = null

/**
 * Get the current App Manager singleton.
 * Returns null if initAppManager() has not yet been called.
 */
export function getAppManager(): AppManagerService | null {
  return managerInstance
}

// ============================================
// Initialization
// ============================================

/** Dependencies required to initialize the App Manager */
interface InitAppManagerDeps {
  /** DatabaseManager from platform/store */
  db: DatabaseManager
}

/**
 * Initialize the App Manager module.
 *
 * 1. Gets the app-level database from DatabaseManager
 * 2. Runs schema migrations (installed_apps table)
 * 3. Creates the store and service instances
 * 4. Returns the AppManagerService interface
 *
 * This function must be called after initStore() and initAppSpec() in the
 * bootstrap sequence (Phase 2 per architecture doc 8B.4).
 *
 * @param deps - Injected dependencies
 * @returns Initialized AppManagerService
 */
export async function initAppManager(
  deps: InitAppManagerDeps
): Promise<AppManagerService> {
  const start = performance.now()
  console.log('[AppManager] Initializing...')

  // Get the app-level database
  const appDb = deps.db.getAppDatabase()

  // Run migrations
  deps.db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)

  // Create the store (prepared statements on the database)
  const store = new AppManagerStore(appDb)

  const getSpacePath = (spaceId: string): string | null => {
    const space = getSpace(spaceId)
    if (!space) return null
    // For halo-temp, skills must go into artifacts/ — that's the Claude SDK workDir.
    // For regular spaces, workingDir (if set) or path is the project root.
    if (space.isTemp) return join(space.path, 'artifacts')
    return space.workingDir || space.path
  }

  // App work directories always use space.path directly so they match the path
  // the runtime uses when reading/writing memory (execute.ts: getSpace().path).
  // halo-temp's artifacts/ offset is only relevant for skill file sync.
  const getAppDataPath = (spaceId: string): string | null => {
    const space = getSpace(spaceId)
    if (!space) return null
    return space.path
  }

  // Create the service with injected dependencies
  const service = createAppManagerService({
    store,
    getSpacePath,
    getAppDataPath,
    getGlobalAppDir: () => getHaloDir(),
  })

  managerInstance = service

  // Garbage collect stale uninstalled apps on startup (async, non-blocking)
  // Default retention: 30 days
  try {
    const pruned = service.pruneUninstalledApps()
    if (pruned > 0) {
      console.log(`[AppManager] Pruned ${pruned} stale uninstalled apps on startup`)
    }
  } catch (err) {
    console.warn('[AppManager] Failed to prune uninstalled apps:', err)
  }

  const duration = performance.now() - start
  console.log(`[AppManager] Initialized in ${duration.toFixed(1)}ms`)

  return service
}

/**
 * Shutdown the App Manager module.
 *
 * Currently a no-op -- all state is in SQLite (managed by platform/store)
 * and in-memory event handlers (garbage collected).
 *
 * Exists to satisfy the bootstrap shutdown contract.
 */
export async function shutdownAppManager(): Promise<void> {
  managerInstance = null
  console.log('[AppManager] Shutdown complete')
}
