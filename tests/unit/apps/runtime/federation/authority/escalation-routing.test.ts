/**
 * Unit tests for authority/escalation-routing -- cross-person decision routing.
 *
 * member kind  → owner of the task originator (who dispatched the task);
 * lead/office  → office owner (earliest-joined node).
 * Backed by real in-memory TeamStore + FederationStore.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../../src/main/apps/team/migrations'
import { FederationStore } from '../../../../../../src/main/apps/federation/store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../../src/main/apps/federation/migrations'
import { resolveEscalationTarget } from '../../../../../../src/main/apps/runtime/federation/authority/escalation-routing'
import { SELF_NODE_ID, type Team, type TeamMember } from '../../../../../../src/shared/apps/team-types'
import type { OfficeNode } from '../../../../../../src/main/apps/federation/types'

const TEAM_ID = 'office-1'
const SPACE = 'space-1'
const NODE_OWNER = 'node-owner' // office creator/host, joined first
const NODE_B = 'node-b'
const LEAD = 'app-lead'
const ORIGINATOR_REMOTE = 'app-originator-remote'
const ORIGINATOR_LOCAL = 'app-originator-local'

function team(): Team {
  return {
    id: TEAM_ID,
    name: 'Office',
    owningSpaceId: SPACE,
    goal: 'g',
    leadAppId: LEAD,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function member(appId: string, ownerNodeId: string): TeamMember {
  return {
    teamId: TEAM_ID,
    appId,
    memberName: appId,
    role: 'r',
    isLead: appId === LEAD,
    aiProvisioned: false,
    addedAt: 1,
    ownerNodeId,
  }
}

function node(nodeId: string, displayName: string, joinedAt: number): OfficeNode {
  return {
    nodeId,
    officeId: TEAM_ID,
    identity: `id-${nodeId}`,
    displayName,
    joinedAt,
    lastSeen: joinedAt,
    status: 'online',
  }
}

describe('authority/escalation-routing', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let federationStore: FederationStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    store = new TeamStore(db)
    federationStore = new FederationStore(db)

    store.insertTeam(team())
    store.addMember(member(LEAD, SELF_NODE_ID))
    store.addMember(member(ORIGINATOR_REMOTE, NODE_B))
    store.addMember(member(ORIGINATOR_LOCAL, SELF_NODE_ID))

    federationStore.upsertNode(node(NODE_OWNER, 'Alice', 10))
    federationStore.upsertNode(node(NODE_B, 'Bob', 20))
  })

  afterEach(() => dbManager.closeAll())

  describe('member kind → task-originator owner (AC-7.5)', () => {
    it('routes to the remote originator’s owner node (positive)', () => {
      const out = resolveEscalationTarget({
        kind: 'member',
        teamId: TEAM_ID,
        taskOriginatorAppId: ORIGINATOR_REMOTE,
        store,
        federationStore,
      })
      expect(out.routedTo).toBe('task-originator-owner')
      expect(out.ownerNodeId).toBe(NODE_B)
      expect(out.displayName).toBe('Bob')
    })

    it('a locally-owned originator routes to self (no remote node id)', () => {
      const out = resolveEscalationTarget({
        kind: 'member',
        teamId: TEAM_ID,
        taskOriginatorAppId: ORIGINATOR_LOCAL,
        store,
        federationStore,
      })
      expect(out.routedTo).toBe('task-originator-owner')
      expect(out.ownerNodeId).toBe(SELF_NODE_ID)
      expect(out.displayName).toBeNull()
    })

    it('unknown originator → unresolved owner (negative)', () => {
      const out = resolveEscalationTarget({
        kind: 'member',
        teamId: TEAM_ID,
        taskOriginatorAppId: 'app-nonexistent',
        store,
        federationStore,
      })
      expect(out.ownerNodeId).toBeNull()
    })
  })

  describe('lead / office kind → office owner (AC-7.5)', () => {
    it('lead-level escalation routes to the office owner (earliest node)', () => {
      const out = resolveEscalationTarget({ kind: 'lead', teamId: TEAM_ID, store, federationStore })
      expect(out.routedTo).toBe('office-owner')
      expect(out.ownerNodeId).toBe(NODE_OWNER)
      expect(out.displayName).toBe('Alice')
    })

    it('office-level escalation routes to the office owner', () => {
      const out = resolveEscalationTarget({ kind: 'office', teamId: TEAM_ID, store, federationStore })
      expect(out.routedTo).toBe('office-owner')
      expect(out.ownerNodeId).toBe(NODE_OWNER)
    })

    it('no nodes known → unresolved owner (negative)', () => {
      federationStore.removeNode(TEAM_ID, NODE_OWNER)
      federationStore.removeNode(TEAM_ID, NODE_B)
      const out = resolveEscalationTarget({ kind: 'office', teamId: TEAM_ID, store, federationStore })
      expect(out.ownerNodeId).toBeNull()
      expect(out.displayName).toBeNull()
    })
  })
})
