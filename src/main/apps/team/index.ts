/**
 * apps/team -- Public API
 *
 * Persistence + service layer for Digital Teams. Owns team tables, store
 * singleton, and service singleton; re-exports types for consumers.
 */

import type { DatabaseManager } from '../../platform/store'
import { TeamStore } from './store'
import { MIGRATION_NAMESPACE, migrations } from './migrations'
import { createTeamService, proposeMembersViaSdk } from './service'
import type { TeamService, TeamServiceDeps } from './service'
import type { AppManagerService } from '../manager'
import type { TeamRuntime } from '../runtime/team'

// Re-exports for consumers.
export type {
  TeamStore,
  Team,
  TeamMember,
  TeamEdge,
  BlackboardTask,
  BlackboardFinding,
  TeamEpoch,
  TeamStatus,
  TaskStatus,
  EpochEndReason,
  MemberSourcing,
  CollabMode,
  EscalationRouting,
  TeamFieldUpdate,
  TaskPatch,
} from './types'

export type { TeamService, TeamServiceDeps } from './service'
export type { TeamArtifactGroup, TeamArtifact } from '../../../shared/apps/team-types'

export { MIGRATION_NAMESPACE, migrations } from './migrations'

// ── Module State ──

let storeInstance: TeamStore | null = null
let serviceInstance: TeamService | null = null

export function getTeamStore(): TeamStore | null {
  return storeInstance
}

export function getTeamService(): TeamService | null {
  return serviceInstance
}

// ── Initialization ──

interface InitTeamStoreDeps {
  db: DatabaseManager
}

export function initTeamStore(deps: InitTeamStoreDeps): TeamStore {
  const start = performance.now()
  console.log('[TeamStore] Initializing...')

  const appDb = deps.db.getAppDatabase()
  deps.db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)

  const store = new TeamStore(appDb)
  storeInstance = store

  const duration = performance.now() - start
  console.log(`[TeamStore] Initialized in ${duration.toFixed(1)}ms`)

  return store
}

export function shutdownTeamStore(): void {
  storeInstance = null
  console.log('[TeamStore] Shutdown complete')
}

// ── Team Service Initialization ──

interface InitTeamServiceDeps {
  store: TeamStore
  appManager: AppManagerService
  getRuntime: () => TeamRuntime | null
  spaces: TeamServiceDeps['spaces']
  listArtifacts: TeamServiceDeps['listArtifacts']
  proposeMembersFromGoal?: TeamServiceDeps['proposeMembersFromGoal']
  getTriggerSync?: TeamServiceDeps['getTriggerSync']
}

export function initTeamService(deps: InitTeamServiceDeps): TeamService {
  const start = performance.now()
  console.log('[TeamService] Initializing...')

  const service = createTeamService({
    store: deps.store,
    appManager: deps.appManager,
    getRuntime: deps.getRuntime,
    spaces: deps.spaces,
    listArtifacts: deps.listArtifacts,
    proposeMembersFromGoal: deps.proposeMembersFromGoal ?? proposeMembersViaSdk,
    getTriggerSync: deps.getTriggerSync,
  })
  serviceInstance = service

  const duration = performance.now() - start
  console.log(`[TeamService] Initialized in ${duration.toFixed(1)}ms`)
  return service
}

export function shutdownTeamService(): void {
  serviceInstance = null
  console.log('[TeamService] Shutdown complete')
}
