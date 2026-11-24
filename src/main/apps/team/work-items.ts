import type Database from 'better-sqlite3'
import type { TeamEpoch, TeamWorkItem } from '../../../shared/apps/team-types'

interface TaskColumns {
  id: string
  team_id: string
  started_at: number
  task_status?: TeamWorkItem['status'] | null
  task_title?: string | null
  task_created_by?: string | null
  task_entry_app_id?: string | null
  task_updated_at?: number | null
}

export function workItemFromRow(row: TaskColumns): TeamWorkItem | undefined {
  if (!row.task_status) return undefined
  return { id: row.id, teamId: row.team_id, createdAt: row.started_at,
    title: row.task_title ?? null, status: row.task_status,
    createdBy: row.task_created_by ?? null, entryAppId: row.task_entry_app_id ?? null,
    updatedAt: row.task_updated_at ?? row.started_at }
}

const statements = new WeakMap<Database.Database, { read: Database.Statement; write: Database.Statement }>()
function queries(db: Database.Database) {
  let cached = statements.get(db)
  if (!cached) {
    cached = {
      read: db.prepare('SELECT * FROM team_epochs WHERE id = ?'),
      write: db.prepare(`UPDATE team_epochs SET task_status = @status, task_title = @title,
        task_created_by = COALESCE(task_created_by, @createdBy),
        task_entry_app_id = COALESCE(@entryAppId, task_entry_app_id), task_updated_at = @updatedAt
        WHERE id = @id AND team_id = @teamId AND (task_updated_at IS NULL OR task_updated_at <= @updatedAt)`),
    }
    statements.set(db, cached)
  }
  return cached
}

export function readWorkItem(db: Database.Database, epochId: string): TeamWorkItem | undefined {
  const row = queries(db).read.get(epochId) as TaskColumns | undefined
  return row ? workItemFromRow(row) : undefined
}

export function applyWorkItem(db: Database.Database, epoch: TeamEpoch): void {
  let item = epoch.workItem
  if (item && (item.teamId !== epoch.teamId || item.id !== epoch.id || !['open', 'completed'].includes(item.status) || !Number.isFinite(item.updatedAt))) {
    console.warn('[TeamStore] Ignored invalid replicated task state', { teamId: epoch.teamId, epochId: epoch.id })
    item = undefined
  }
  if (!item && readWorkItem(db, epoch.id)) return
  queries(db).write.run(item ? { ...item, entryAppId: item.entryAppId ?? null } : {
    id: epoch.id, teamId: epoch.teamId, title: epoch.title ?? null,
    status: epoch.endReason === 'completed' ? 'completed' : 'open',
    createdBy: null, entryAppId: null, updatedAt: epoch.startedAt,
  })
}

export function updateWorkItem(db: Database.Database, epochId: string, patch: Partial<Pick<TeamWorkItem, 'title' | 'status' | 'createdBy' | 'entryAppId'>>): void {
  const current = readWorkItem(db, epochId)
  if (!current) throw new Error(`Task not found for execution: ${epochId}`)
  if (Object.entries(patch).every(([key, value]) => current[key as keyof TeamWorkItem] === value)) return
  queries(db).write.run({ ...current, ...patch, updatedAt: Math.max(Date.now(), current.updatedAt + 1) })
}
