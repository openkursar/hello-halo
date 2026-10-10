/**
 * Unit tests for resolveVersionMismatchDetail (apps/runtime/federation/manager).
 *
 * Given a TeamStore and a peer's reported protocol version — the only two
 * inputs a VERSION_INCOMPATIBLE join-reject/grant-mismatch actually carries —
 * decides which side is behind and, when it is the team's current host,
 * resolves that person's display name from the last-synced roster. The
 * function takes the store explicitly, so this needs no coordinator, socket,
 * or FederationManager instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'

function testHome(): string {
  return (globalThis as { __HALO_TEST_DIR__?: string }).__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

// Own the electron mock to add the safeStorage stub manager.ts's import graph
// needs (the global setup omits it) — mirrors manager-ws.test.ts.
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      const dir = testHome()
      if (name === 'userData') return path.join(dir, '.halo')
      return dir
    },
    getAppPath: () => path.join(testHome(), 'app'),
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { resolveVersionMismatchDetail } from '../../../../../src/main/apps/runtime/federation/manager'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/main/apps/runtime/federation/protocol-m2'

const OFFICE = 'office-vm-1'
const HOST_NODE = 'host-node-x'

describe('resolveVersionMismatchDetail', () => {
  let dbManager: DatabaseManager
  let teamStore: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    teamStore = new TeamStore(db)

    const now = Date.now()
    teamStore.insertTeam({
      id: OFFICE, name: 'Office', owningSpaceId: 'space-a', goal: 'g',
      leadAppId: null, memberSourcing: 'manual', collabMode: 'free',
      escalationRouting: 'user', status: 'running', currentEpochId: null,
      createdAt: now, updatedAt: now, hostNodeId: HOST_NODE,
    })
    teamStore.addMember({
      teamId: OFFICE, appId: 'app-host-owner', memberName: 'host-owner', role: 'Writer',
      isLead: false, aiProvisioned: false, addedAt: now,
      ownerNodeId: HOST_NODE, origin: 'remote', ownerDisplayName: 'Alice',
    })
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  it('is undefined when the peer reported no version at all (predates the pv field)', () => {
    expect(resolveVersionMismatchDetail(teamStore, OFFICE, undefined)).toBeUndefined()
  })

  it('is undefined when the versions actually match (gate should not have rejected)', () => {
    expect(resolveVersionMismatchDetail(teamStore, OFFICE, FEDERATION_PROTOCOL_VERSION)).toBeUndefined()
  })

  it('direction is self when the peer reports a NEWER version than this node', () => {
    expect(resolveVersionMismatchDetail(teamStore, OFFICE, FEDERATION_PROTOCOL_VERSION + 1))
      .toEqual({ direction: 'self' })
  })

  it('direction is peer and names the host owner when the peer reports an OLDER version', () => {
    expect(resolveVersionMismatchDetail(teamStore, OFFICE, FEDERATION_PROTOCOL_VERSION - 1))
      .toEqual({ direction: 'peer', peerName: 'Alice' })
  })

  it('direction is peer with a null name when the roster has no owner name for the host node', () => {
    teamStore.insertTeam({
      id: 'office-no-name', name: 'Office2', owningSpaceId: 'space-b', goal: 'g',
      leadAppId: null, memberSourcing: 'manual', collabMode: 'free',
      escalationRouting: 'user', status: 'running', currentEpochId: null,
      createdAt: Date.now(), updatedAt: Date.now(), hostNodeId: 'host-node-y',
    })
    expect(resolveVersionMismatchDetail(teamStore, 'office-no-name', FEDERATION_PROTOCOL_VERSION - 1))
      .toEqual({ direction: 'peer', peerName: null })
  })

  it('direction is peer with a null name when this node has no roster for the office at all', () => {
    expect(resolveVersionMismatchDetail(teamStore, 'office-never-synced', FEDERATION_PROTOCOL_VERSION - 1))
      .toEqual({ direction: 'peer', peerName: null })
  })
})
