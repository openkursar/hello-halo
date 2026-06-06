/**
 * platform/store -- Public API
 *
 * SQLite persistence foundation for the Halo platform layer.
 * This is the lowest module in the dependency chain: scheduler,
 * apps/manager, and apps/runtime all depend on this module for database access.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initStore } from '../platform/store'
 *
 *   const db = await initStore()
 *   const scheduler = await initScheduler({ db })
 *   // ...
 *
 * Usage in consuming modules:
 *
 *   import type { DatabaseManager, Migration } from '../platform/store'
 *
 *   const migrations: Migration[] = [
 *     {
 *       version: 1,
 *       description: 'Create scheduler_jobs table',
 *       up(db) {
 *         db.exec(`CREATE TABLE scheduler_jobs (...)`)
 *       }
 *     }
 *   ]
 *
 *   function initScheduler({ db }: { db: DatabaseManager }) {
 *     const appDb = db.getAppDatabase()
 *     db.runMigrations(appDb, 'scheduler', migrations)
 *     // ... use appDb for queries
 *   }
 */

import { join } from 'path'
import { getHaloDir } from '../../foundation/config.service'
import { createDatabaseManager } from './database-manager'
import type { DatabaseManager, Migration } from './types'

// Re-export types for consumers
export type { DatabaseManager, Migration }

// Re-export createDatabaseManager for testing with :memory: databases
export { createDatabaseManager }

/** Name of the application-level database file. */
const APP_DB_FILENAME = 'halo.db'

/**
 * Initialize the platform store module.
 *
 * Creates and returns a DatabaseManager configured for the Halo data directory.
 * The app-level database is located at `{haloDir}/halo.db`.
 *
 * This function must be called first in the platform initialization sequence
 * (bootstrap Phase 3), before any other platform or apps module.
 *
 * @returns A configured DatabaseManager instance.
 */
export async function initStore(): Promise<DatabaseManager> {
  const start = performance.now()

  const haloDir = getHaloDir()
  const appDbPath = join(haloDir, APP_DB_FILENAME)

  console.log(`[Store] Initializing store at: ${appDbPath}`)

  const manager = createDatabaseManager(appDbPath)

  // Eagerly open the app database to verify it works at startup time.
  // This catches corruption/permission issues early, before other modules
  // try to use the database.
  manager.getAppDatabase()

  const duration = performance.now() - start
  console.log(`[Store] Store initialized in ${duration.toFixed(1)}ms`)

  return manager
}

/**
 * Shutdown the platform store module.
 *
 * Closes all open database connections. Should be called during
 * app.on('before-quit') via the bootstrap cleanup sequence.
 *
 * @param manager - The DatabaseManager instance to shut down.
 */
export async function shutdownStore(manager: DatabaseManager): Promise<void> {
  console.log('[Store] Shutting down store...')
  manager.closeAll()
  console.log('[Store] Store shutdown complete')
}
