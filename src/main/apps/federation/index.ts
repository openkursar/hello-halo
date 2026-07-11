/**
 * apps/federation -- Public API
 *
 * Persistence foundation for office federation. Owns the app_federation
 * migration namespace, the federation tables, and the store singleton;
 * re-exports types for consumers.
 */

import type { DatabaseManager } from '../../platform/store'
import { FederationStore } from './store'
import { AuthorityStore } from './authority-store'
import { MIGRATION_NAMESPACE, migrations } from './migrations'

export type {
  FederationStore,
  OfficeNode,
  OfficeCredentialRecord,
  OfficeScope,
  OfficeNodeRow,
  OfficeCredentialRow,
  AuthorityStore,
  AuthorityState,
  AuthorityStatePatch,
  ReplicationLogEntry,
  ReplicationOpName,
} from './types'
export { DEFAULT_OFFICE_SCOPE } from './types'
export { AuthorityStore as AuthorityStoreImpl } from './authority-store'

export { MIGRATION_NAMESPACE, migrations } from './migrations'

// ── Module State ──

let storeInstance: FederationStore | null = null
let authorityStoreInstance: AuthorityStore | null = null

export function getFederationStore(): FederationStore | null {
  return storeInstance
}

/** Null until initFederationStore has run. */
export function getAuthorityStore(): AuthorityStore | null {
  return authorityStoreInstance
}

// ── Initialization ──

interface InitFederationStoreDeps {
  db: DatabaseManager
}

export function initFederationStore(deps: InitFederationStoreDeps): FederationStore {
  const start = performance.now()
  console.log('[FederationStore] Initializing...')

  const appDb = deps.db.getAppDatabase()
  deps.db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)

  const store = new FederationStore(appDb)
  storeInstance = store
  authorityStoreInstance = new AuthorityStore(appDb)

  const duration = performance.now() - start
  console.log(`[FederationStore] Initialized in ${duration.toFixed(1)}ms`)

  return store
}

export function shutdownFederationStore(): void {
  storeInstance = null
  authorityStoreInstance = null
  console.log('[FederationStore] Shutdown complete')
}
