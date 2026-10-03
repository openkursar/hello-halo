/**
 * Host fan-out costs. The host consumes each joiner's ctrl feed through one
 * subscription: routine inbound traffic (heartbeats, acks, stream batches) must
 * not send the joiner a fresh feed-subscribe per frame; a (re)join restarts the
 * stream explicitly. A broadcast is handed to the transport once for all clients
 * (serialized once), and only droppable frames may be skipped for a slow client.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { initFederationStore, shutdownFederationStore } from '../../../../../src/main/apps/federation'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { createFederationManager, type FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'
import type { FederationMessage, JoinRequest } from '../../../../../src/main/apps/runtime/federation'

const OFFICE = 'office-echo'
const HOST = 'node-host'
const JOINER = 'node-joiner'
const CLIENT = 'client-joiner'
const TOKEN = 'token'

describe('host inbound does not echo a feed-subscribe per frame', () => {
  let dbManager: DatabaseManager
  let manager: FederationManager
  let toJoiner: FederationMessage[]

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    initFederationStore({ db: dbManager })
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    toJoiner = []
    manager = createFederationManager({
      hostSend: (clientId, frame) => {
        if (clientId === CLIENT) toJoiner.push(frame)
        return true
      },
      hostListOfficeClients: () => [CLIENT],
      federationStore: new FederationStore(db),
      teamStore: new TeamStore(db),
      verifyCredential: (token) => (token === TOKEN ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null),
      getLocalNodeId: () => HOST,
      getSessionIdentity: () => JOINER,
    })
    manager.hostOffice(OFFICE)
  })

  afterEach(() => {
    manager.stopAll()
    shutdownFederationStore()
    dbManager.closeAll()
  })

  const subscribes = () => toJoiner.filter((f) => f.kind === 'feed-subscribe').length

  function join(): void {
    const request: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: JOINER,
      identityId: 'id-joiner',
      displayName: 'Joiner',
      credentialToken: TOKEN,
      bringMembers: [],
    }
    manager.handleHostInbound({ clientId: CLIENT, officeId: OFFICE, frame: request })
  }

  it('subscribes on join, then stays quiet across heartbeats, and restarts on a rejoin', () => {
    join()
    expect(subscribes()).toBe(1)
    for (let i = 0; i < 30; i++) {
      manager.handleHostInbound({
        clientId: CLIENT,
        officeId: OFFICE,
        frame: { kind: 'heartbeat', officeId: OFFICE, fromNode: JOINER, ts: i },
      })
    }
    expect(subscribes()).toBe(1)
    join()
    expect(subscribes()).toBe(2)
  })
})

describe('host broadcasts are serialized once for all clients', () => {
  let dbManager: DatabaseManager
  let manager: FederationManager

  afterEach(() => {
    manager.stopAll()
    shutdownFederationStore()
    dbManager.closeAll()
  })

  it('hands every broadcast to the many-client sender once, control frames never droppable', () => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    initFederationStore({ db: dbManager })
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    const many: Array<{ clients: readonly string[]; kind: string; droppable: boolean }> = []
    const single: string[] = []
    manager = createFederationManager({
      hostSend: (_clientId, frame) => {
        single.push(frame.kind)
        return true
      },
      hostSendMany: (clients, frame, opts) => {
        many.push({ clients, kind: frame.kind, droppable: opts.droppable })
        return []
      },
      hostListOfficeClients: () => [CLIENT, 'client-2', 'client-3'],
      federationStore: new FederationStore(db),
      teamStore: new TeamStore(db),
      verifyCredential: (token) => (token === TOKEN ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null),
      getLocalNodeId: () => HOST,
      getSessionIdentity: () => JOINER,
    })
    manager.hostOffice(OFFICE)
    manager.handleHostInbound({
      clientId: CLIENT,
      officeId: OFFICE,
      frame: { kind: 'join-request', officeId: OFFICE, fromNode: JOINER, identityId: 'id', displayName: 'J', credentialToken: TOKEN, bringMembers: [] },
    })
    const roster = many.find((m) => m.kind === 'roster')
    expect(roster?.clients).toEqual([CLIENT, 'client-2', 'client-3'])
    expect(many.filter((m) => m.kind !== 'feed-advertise').every((m) => m.droppable === false)).toBe(true)
    expect(single).not.toContain('roster')
    expect(single).not.toContain('presence-update')
  })
})
