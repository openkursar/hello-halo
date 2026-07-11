/**
 * Unit tests for FederationStore: office_nodes/office_credentials CRUD and the
 * app_federation migration run. Uses :memory: databases for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../src/main/apps/federation/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/federation/migrations'
import type {
  OfficeNode,
  OfficeCredentialRecord,
  OfficeScope,
} from '../../../../src/main/apps/federation/types'

const OFFICE_A = 'office-a'
const OFFICE_B = 'office-b'

function makeNode(overrides?: Partial<OfficeNode>): OfficeNode {
  const now = Date.now()
  return {
    nodeId: 'node-1',
    officeId: OFFICE_A,
    identity: 'identity-1',
    displayName: 'Alice',
    joinedAt: now,
    lastSeen: now,
    status: 'online',
    advertisedUrl: null,
    ...overrides,
  }
}

function makeScope(overrides?: Partial<OfficeScope>): OfficeScope {
  return {
    visibility: 'full',
    contactable: 'all',
    discoverable: true,
    canReinvite: true,
    ...overrides,
  }
}

function makeCredential(overrides?: Partial<OfficeCredentialRecord>): OfficeCredentialRecord {
  return {
    jti: 'jti-1',
    officeId: OFFICE_A,
    identity: 'identity-1',
    scope: makeScope(),
    exp: null,
    issuedAt: Date.now(),
    revoked: false,
    ...overrides,
  }
}

describe('FederationStore', () => {
  let dbManager: DatabaseManager
  let store: FederationStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new FederationStore(db)
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  describe('migrations', () => {
    it('uses the dedicated app_federation namespace', () => {
      expect(MIGRATION_NAMESPACE).toBe('app_federation')
    })

    it('creates both federation tables', () => {
      const db = dbManager.getAppDatabase()
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as { name: string }[]
      const names = rows.map(r => r.name)
      for (const t of ['office_nodes', 'office_credentials']) {
        expect(names).toContain(t)
      }
    })


    it('is idempotent when run twice', () => {
      const db = dbManager.getAppDatabase()
      expect(() => dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)).not.toThrow()
    })

    it('v4 rebuild preserves existing office_nodes rows', () => {
      const mgr = createDatabaseManager(':memory:')
      const db = mgr.getAppDatabase()
      mgr.runMigrations(db, MIGRATION_NAMESPACE, migrations.slice(0, 3))
      db.prepare(`
        INSERT INTO office_nodes (node_id, office_id, identity, display_name, joined_at, last_seen, status)
          VALUES ('n1', 'office-a', 'id-1', 'Alice', 100, 200, 'online')
      `).run()

      mgr.runMigrations(db, MIGRATION_NAMESPACE, migrations)

      const migrated = new FederationStore(db)
      expect(migrated.getNode('office-a', 'n1')).toMatchObject({
        nodeId: 'n1',
        officeId: 'office-a',
        displayName: 'Alice',
        joinedAt: 100,
        lastSeen: 200,
        status: 'online',
      })
      mgr.closeAll()
    })
  })

  describe('office_nodes', () => {
    it('round-trips a node through upsert/getNode', () => {
      const node = makeNode()
      store.upsertNode(node)
      expect(store.getNode(node.officeId, node.nodeId)).toEqual(node)
    })

    it('returns null for a missing node', () => {
      expect(store.getNode(OFFICE_A, 'nope')).toBeNull()
    })

    it('upsert overwrites an existing node by (office_id, node_id)', () => {
      store.upsertNode(makeNode({ displayName: 'Alice', status: 'online' }))
      store.upsertNode(makeNode({ displayName: 'Alice (renamed)', status: 'offline' }))
      const back = store.getNode(OFFICE_A, 'node-1')!
      expect(back.displayName).toBe('Alice (renamed)')
      expect(back.status).toBe('offline')
    })

    it('keeps per-office rows for the same node id (host + joiner roles coexist)', () => {
      store.upsertNode(makeNode({ joinedAt: 1, status: 'online' }))
      store.upsertNode(makeNode({ officeId: OFFICE_B, joinedAt: 2000, status: 'suspect' }))

      expect(store.getNode(OFFICE_A, 'node-1')!.status).toBe('online')
      expect(store.getNode(OFFICE_B, 'node-1')!.status).toBe('suspect')
      expect(store.listNodesByOffice(OFFICE_A).map(n => n.nodeId)).toEqual(['node-1'])
      expect(store.listNodesByOffice(OFFICE_B).map(n => n.nodeId)).toEqual(['node-1'])
    })

    it('lists nodes by office ordered by joined_at ascending', () => {
      store.upsertNode(makeNode({ nodeId: 'n-late', joinedAt: 3000 }))
      store.upsertNode(makeNode({ nodeId: 'n-early', joinedAt: 1000 }))
      store.upsertNode(makeNode({ nodeId: 'n-mid', joinedAt: 2000 }))
      store.upsertNode(makeNode({ nodeId: 'n-other-office', officeId: OFFICE_B, joinedAt: 500 }))

      const ids = store.listNodesByOffice(OFFICE_A).map(n => n.nodeId)
      expect(ids).toEqual(['n-early', 'n-mid', 'n-late'])
    })

    it('transitions node status and refreshes last_seen via setNodeStatus', () => {
      store.upsertNode(makeNode({ status: 'online', lastSeen: 1000 }))
      store.setNodeStatus(OFFICE_A, 'node-1', 'offline', 5000)
      const back = store.getNode(OFFICE_A, 'node-1')!
      expect(back.status).toBe('offline')
      expect(back.lastSeen).toBe(5000)
    })

    it('scopes status writes to the addressed office only', () => {
      store.upsertNode(makeNode({ joinedAt: 1, status: 'online', lastSeen: 1000 }))
      store.upsertNode(makeNode({ officeId: OFFICE_B, joinedAt: 2, status: 'online', lastSeen: 1000 }))
      store.setNodeStatus(OFFICE_B, 'node-1', 'offline', 5000)

      expect(store.getNode(OFFICE_A, 'node-1')!.status).toBe('online')
      expect(store.getNode(OFFICE_B, 'node-1')!.status).toBe('offline')
    })

    it('touchNode refreshes last_seen without changing status', () => {
      store.upsertNode(makeNode({ status: 'online', lastSeen: 1000 }))
      store.touchNode(OFFICE_A, 'node-1', 7000)
      const back = store.getNode(OFFICE_A, 'node-1')!
      expect(back.status).toBe('online')
      expect(back.lastSeen).toBe(7000)
    })

    it('removes a node', () => {
      store.upsertNode(makeNode())
      expect(store.removeNode(OFFICE_A, 'node-1')).toBe(true)
      expect(store.getNode(OFFICE_A, 'node-1')).toBeNull()
      expect(store.removeNode(OFFICE_A, 'node-1')).toBe(false)
    })
  })

  describe('office_credentials', () => {
    it('round-trips a credential including the scope overlay', () => {
      const cred = makeCredential({
        exp: 9999,
        scope: makeScope({ visibility: 'readonly', contactable: 'lead-only', discoverable: false, canReinvite: false }),
      })
      store.insertCredential(cred)
      expect(store.getCredential(cred.jti)).toEqual(cred)
    })

    it('returns null for a missing credential', () => {
      expect(store.getCredential('nope')).toBeNull()
    })

    it('enforces unique jti', () => {
      store.insertCredential(makeCredential({ jti: 'dup' }))
      expect(() => store.insertCredential(makeCredential({ jti: 'dup' }))).toThrow()
    })

    it('revokes a credential and reflects it in isRevoked', () => {
      store.insertCredential(makeCredential({ jti: 'c1' }))
      expect(store.isRevoked('c1')).toBe(false)
      expect(store.revokeCredential('c1')).toBe(true)
      expect(store.isRevoked('c1')).toBe(true)
      expect(store.getCredential('c1')!.revoked).toBe(true)
    })

    it('revokeCredential returns false for an unknown jti', () => {
      expect(store.revokeCredential('ghost')).toBe(false)
    })

    it('isRevoked is false for an unknown jti', () => {
      expect(store.isRevoked('ghost')).toBe(false)
    })

    it('lists credentials by office ordered by issued_at, scoped per office', () => {
      store.insertCredential(makeCredential({ jti: 'c-late', issuedAt: 3000 }))
      store.insertCredential(makeCredential({ jti: 'c-early', issuedAt: 1000 }))
      store.insertCredential(makeCredential({ jti: 'c-other', officeId: OFFICE_B, issuedAt: 500 }))

      const ids = store.listCredentialsByOffice(OFFICE_A).map(c => c.jti)
      expect(ids).toEqual(['c-early', 'c-late'])
    })
  })
})
