import type Database from 'better-sqlite3'
import type { TeamStopController } from '../../../shared/apps/team-types'

export interface CollaborationRequests {
  current(source: string): string | null
  assignment(source: string): { requestId: string; controller?: Omit<TeamStopController, 'requestId'> } | null
  begin(source: string, id: string): void
  inherit(source: string, id: string): void
  track(source: string, id: string, controller?: Omit<TeamStopController, 'requestId'>): void
  associate(source: string, id: string): void
  cancelled(id: string): boolean
  cancel(id: string): void
  cancelSource(source: string): void
  reserve(id: string, limit: number): boolean
  forget(source: string): void
}

export function validCollaborationRequest(id: string): boolean {
  return id.length <= 8192 && id.split('/').length <= 128 && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(id)
}

export function createCollaborationRequests(db: Database.Database): CollaborationRequests {
  const head = db.prepare('SELECT request_id AS id, controller_app_id AS controllerAppId, controller_origin AS controllerOrigin FROM collaboration_request_heads WHERE source_key = ?')
  const get = db.prepare('SELECT cancelled FROM collaboration_requests WHERE id = ?')
  const insert = db.prepare('INSERT OR IGNORE INTO collaboration_requests(id, budget_id) VALUES (?, ?)')
  const bindSource = db.prepare('INSERT OR IGNORE INTO collaboration_request_sources(source_key, request_id) VALUES (?, ?)')
  const setHead = db.prepare('INSERT INTO collaboration_request_heads(source_key, request_id, controller_app_id, controller_origin) VALUES (?, ?, ?, ?) ON CONFLICT(source_key) DO UPDATE SET request_id = excluded.request_id, controller_app_id = excluded.controller_app_id, controller_origin = excluded.controller_origin')
  const reserve = db.prepare('UPDATE collaboration_requests SET used = used + 1 WHERE id = ? AND used < ? AND cancelled = 0')
  const cancel = db.prepare('UPDATE collaboration_requests SET cancelled = 1 WHERE id = ?')
  const compact = db.prepare('DELETE FROM collaboration_requests WHERE id >= ? AND id < ?')
  const cancelBranch = (id: string) => {
    cancel.run(id)
    // The retained ancestor rejects every delayed descendant after restart.
    compact.run(`${id}/`, `${id}0`)
  }
  const requireId = (id: string) => { if (!validCollaborationRequest(id)) throw new Error('Invalid collaboration request identity.') }
  const inherit = (_source: string, id: string) => {
    requireId(id)
    const root = id.split('/')[0]
    insert.run(root, root)
    insert.run(id, root)
  }
  const cancelled = (id: string) => {
    requireId(id)
    let prefix = ''
    for (const part of id.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part
      if ((get.get(prefix) as { cancelled: number } | undefined)?.cancelled) return true
    }
    return false
  }
  return {
    current: source => (head.get(source) as { id: string } | undefined)?.id ?? null,
    begin: db.transaction((source, id) => { inherit(source, id); bindSource.run(source, id); setHead.run(source, id, null, null) }),
    assignment(source) {
      const row = head.get(source) as { id: string; controllerAppId: string | null; controllerOrigin: TeamStopController['origin'] | null } | undefined
      return row ? { requestId: row.id, ...(row.controllerAppId ? { controller: { appId: row.controllerAppId, origin: row.controllerOrigin ?? undefined } } : {}) } : null
    },
    associate: db.transaction((source, id) => { inherit(source, id); bindSource.run(source, id) }),
    track: db.transaction((source, id, controller) => {
      inherit(source, id); bindSource.run(source, id)
      const previous = head.get(source) as { id: string; controllerAppId: string | null; controllerOrigin: string | null } | undefined
      if (previous?.id === id) return
      setHead.run(source, id, controller?.appId ?? previous?.controllerAppId ?? null,
        controller ? controller.origin ?? null : previous?.controllerOrigin ?? null)
    }),
    inherit,
    cancelled,
    cancel: db.transaction(id => { inherit('', id); cancelBranch(id) }),
    cancelSource: db.transaction(source => {
      const requests = db.prepare('SELECT request_id FROM collaboration_request_sources WHERE source_key = ? ORDER BY request_id').all(source) as Array<{ request_id: string }>
      for (const { request_id: id } of requests) {
        if (!cancelled(id)) cancelBranch(id)
      }
      db.prepare('DELETE FROM collaboration_request_sources WHERE source_key = ?').run(source)
    }),
    reserve: db.transaction((id, limit) => {
      if (cancelled(id)) return false
      return reserve.run(id.split('/')[0], limit).changes === 1
    }),
    forget(source) {
      db.prepare('DELETE FROM collaboration_request_heads WHERE source_key = ?').run(source)
      // Cancellation records remain fences for durable messages still in flight.
    },
  }
}
