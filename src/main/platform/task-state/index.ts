/**
 * task-state -- Public API
 *
 * Persists conversation task-panel bookkeeping (completed-but-unseen,
 * post-view grace period) that previously lived only in renderer memory.
 * See types.ts for the state machine this module tracks.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initTaskState } from '../platform/task-state'
 *   const taskState = await initTaskState({ db })
 */

import type { DatabaseManager } from '../store'
import { TaskStateStore } from './store'
import { createTaskStateService } from './service'
import { MIGRATION_NAMESPACE, migrations } from './migrations'
import type { TaskStateService } from './service'

export type { TaskStateService } from './service'
export type { ConversationTaskState } from './types'

let serviceInstance: TaskStateService | null = null

/**
 * Get the current task-state service singleton.
 * Returns null if initTaskState() has not yet been called.
 */
export function getTaskStateService(): TaskStateService | null {
  return serviceInstance
}

interface InitTaskStateDeps {
  db: DatabaseManager
}

export async function initTaskState(deps: InitTaskStateDeps): Promise<TaskStateService> {
  const appDb = deps.db.getAppDatabase()
  deps.db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)

  const store = new TaskStateStore(appDb)
  const service = createTaskStateService(store)
  serviceInstance = service

  console.log('[TaskState] Initialized')
  return service
}
