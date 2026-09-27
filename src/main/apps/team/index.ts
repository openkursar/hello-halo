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
import { reconcileCoordinatorIdentity } from './coordinator-identity'
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
  MemberFieldUpdate,
  TaskPatch,
  TeamCheck,
  TeamCheckSchedule,
  TeamCheckView,
  TeamDelegatedPolicy,
  UpdateTeamMemberInput,
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

/**
 * How long the owner's record of borrowed work is kept.
 *
 * Long enough to answer "what has this team been doing with my computer" after
 * a break — a month covers a holiday — and short enough that an office running
 * for years does not carry every command it ever ran.
 */
const TOOL_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

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

  // The record of borrowed work is for review, not for keeping. Pruned once at
  // startup rather than on every write: it is read by a person opening a panel,
  // so nothing depends on the cutoff being exact, and a periodic sweep would
  // buy precision nobody can perceive at the cost of a timer that runs forever.
  try {
    const dropped = store.pruneToolAudit(Date.now() - TOOL_AUDIT_RETENTION_MS)
    if (dropped > 0) console.log(`[TeamStore] Pruned ${dropped} tool-audit rows past retention`)
  } catch (error) {
    // A record that cannot be trimmed is still a usable record.
    console.error('[TeamStore] Tool-audit prune failed:', (error as Error).message)
  }

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
  openArtifact?: TeamServiceDeps['openArtifact']
  proposeMembersFromGoal?: TeamServiceDeps['proposeMembersFromGoal']
  getTriggerSync?: TeamServiceDeps['getTriggerSync']
  // Federation egress hooks: roster/membership/lifecycle mutations are projected
  // to office peers by the injected federation layer (the service itself imports
  // no federation). Optional — absent in a non-federated build.
  onRosterMutated?: TeamServiceDeps['onRosterMutated']
  onMemberProfileChanged?: TeamServiceDeps['onMemberProfileChanged']
  onRunStateChanged?: TeamServiceDeps['onRunStateChanged']
  onMemberRemoved?: TeamServiceDeps['onMemberRemoved']
  onOfficeDissolved?: TeamServiceDeps['onOfficeDissolved']
  getPendingEscalations?: TeamServiceDeps['getPendingEscalations']
  describeChatKey?: TeamServiceDeps['describeChatKey']
  getViewerIdentity?: TeamServiceDeps['getViewerIdentity']
  getConversationMember?: TeamServiceDeps['getConversationMember']
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
    openArtifact: deps.openArtifact,
    proposeMembersFromGoal: deps.proposeMembersFromGoal ?? proposeMembersViaSdk,
    getTriggerSync: deps.getTriggerSync,
    onRosterMutated: deps.onRosterMutated,
    onMemberProfileChanged: deps.onMemberProfileChanged,
    onRunStateChanged: deps.onRunStateChanged,
    onMemberRemoved: deps.onMemberRemoved,
    onOfficeDissolved: deps.onOfficeDissolved,
    getPendingEscalations: deps.getPendingEscalations,
    describeChatKey: deps.describeChatKey,
    getViewerIdentity: deps.getViewerIdentity,
    getConversationMember: deps.getConversationMember,
  })
  serviceInstance = service
  reconcileCoordinatorIdentity(deps.store, deps.appManager)

  const duration = performance.now() - start
  console.log(`[TeamService] Initialized in ${duration.toFixed(1)}ms`)
  return service
}

export function shutdownTeamService(): void {
  serviceInstance = null
  console.log('[TeamService] Shutdown complete')
}
