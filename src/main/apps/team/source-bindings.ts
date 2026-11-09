import type Database from 'better-sqlite3'
import { parseTeamSessionKey } from '../../../shared/apps/im-keys'
import { validCollaborationRequest } from './collaboration-requests'

/** Local source routing and authority snapshots; never part of an office record. */
export interface CollaborationSourceBinding {
  requestId: string
  sourceKey: string
  scopeKey: string
  ownerKey: string
  payload: Record<string, unknown>
  revoked: boolean
}

export interface CollaborationSourceBindings {
  bind(input: Omit<CollaborationSourceBinding, 'revoked'>, parentRequestId?: string): void
  get(requestId: string): CollaborationSourceBinding | null
  revokeRequest(requestId: string): number
  revokeSource(sourceKey: string): string[]
  revokeScope(scopeKey: string): string[]
  revokeOwner(ownerKey: string): string[]
}

export function createCollaborationSourceBindings(db: Database.Database): CollaborationSourceBindings {
  const read = db.prepare('SELECT request_id, source_key, scope_key, owner_key, payload_json, revoked FROM collaboration_source_bindings WHERE request_id = ?')
  const insert = db.prepare('INSERT INTO collaboration_source_bindings(request_id, source_key, scope_key, owner_key, payload_json) VALUES (?, ?, ?, ?, ?)')
  type Row = { request_id: string; source_key: string; scope_key: string; owner_key: string; payload_json: string; revoked: number }
  const requireId = (id: string) => { if (!validCollaborationRequest(id)) throw new Error('Invalid collaboration source request identity.') }
  const revoke = (column: 'source_key' | 'scope_key' | 'owner_key', value: string): string[] => db.transaction(() => {
    const rows = db.prepare(`SELECT request_id FROM collaboration_source_bindings WHERE revoked = 0 AND ${column} = ?`).all(value) as Array<{ request_id: string }>
    db.prepare(`UPDATE collaboration_source_bindings SET revoked = 1, payload_json = '{}' WHERE ${column} = ? AND (revoked = 0 OR payload_json != '{}')`).run(value)
    return rows.map(row => row.request_id)
  })()
  return {
    bind(input, parentRequestId) {
      requireId(input.requestId)
      if (parentRequestId !== undefined) {
        requireId(parentRequestId)
        const parent = parseTeamSessionKey(input.sourceKey)
        if (!parent || !input.requestId.startsWith(`${parentRequestId}/`) || input.ownerKey !== parent.appId
          || input.scopeKey !== `team:${parent.teamId}:${parent.epochId}` || input.payload.parentRequestId !== parentRequestId) {
          throw new Error('An internal source must belong to its parent member request.')
        }
      }
      const payload = JSON.stringify(input.payload)
      const ancestors = input.requestId.split('/')
      ancestors.pop()
      while (ancestors.length) {
        const ancestor = read.get(ancestors.join('/')) as Row | undefined
        if (ancestor && (ancestor.revoked || (parentRequestId === undefined && (ancestor.source_key !== input.sourceKey || ancestor.owner_key !== input.ownerKey)))) {
          throw new Error('A collaboration branch cannot replace or revive its source authority.')
        }
        ancestors.pop()
      }
      const existing = read.get(input.requestId) as Row | undefined
      if (existing) {
        if (existing.revoked || existing.source_key !== input.sourceKey || existing.scope_key !== input.scopeKey || existing.owner_key !== input.ownerKey || existing.payload_json !== payload) {
          throw new Error('A collaboration request cannot replace its original source or authority.')
        }
        return
      }
      insert.run(input.requestId, input.sourceKey, input.scopeKey, input.ownerKey, payload)
    },
    get(requestId) {
      requireId(requestId)
      const parts = requestId.split('/')
      while (parts.length) {
        const row = read.get(parts.join('/')) as Row | undefined
        if (row) return { requestId: row.request_id, sourceKey: row.source_key, scopeKey: row.scope_key, ownerKey: row.owner_key, payload: JSON.parse(row.payload_json), revoked: row.revoked !== 0 }
        parts.pop()
      }
      return null
    },
    revokeRequest(requestId) {
      requireId(requestId)
      const prefix = `${requestId}/`
      return db.prepare("UPDATE collaboration_source_bindings SET revoked = 1, payload_json = '{}' WHERE (revoked = 0 OR payload_json != '{}') AND (request_id = ? OR substr(request_id, 1, ?) = ?)")
        .run(requestId, prefix.length, prefix).changes
    },
    revokeSource: source => revoke('source_key', source),
    revokeScope: scope => revoke('scope_key', scope),
    revokeOwner: owner => revoke('owner_key', owner),
  }
}
