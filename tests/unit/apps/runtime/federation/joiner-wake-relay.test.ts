/**
 * Regression: a JOINER's outbound wake must be addressed to the office
 * AUTHORITY (the star's relay hub), not to the target member's owner node.
 *
 * The ctrl feed applies entries by target label and the authority is the only
 * peer consuming a joiner's ctrl feed — an owner-labeled entry for another
 * joiner is consumed-but-ignored at the authority and never reaches the owner
 * (a silently lost joiner→joiner message; the authority relays wakes onward via
 * runOrForwardWakeOnHost). Asserted at the durable outbox: the published ctrl
 * entry's payload.target is the authority node.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import {
  initFederationStore,
  shutdownFederationStore,
  getFeedStore,
} from '../../../../../src/main/apps/federation'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { createFederationManager, type FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { feedIdKey } from '../../../../../src/main/apps/runtime/federation/log/types'
import type { SerializedWakeRequest } from '../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-relay'
const NODE_SELF = 'node-joiner-self'
const NODE_HOST = 'node-authority-host'
const NODE_OWNER = 'node-other-joiner'
const MEMBER = 'app-other-member'

describe('joiner wake relay addressing', () => {
  let dbManager: DatabaseManager
  let manager: FederationManager

  beforeEach(async () => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    initFederationStore({ db: dbManager }) // runs app_federation migrations + global feed store
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    const federationStore = new FederationStore(db)
    const teamStore = new TeamStore(db)

    // Shadow office on the joiner: hosted elsewhere, target member owned by a
    // THIRD node (the joiner→joiner dispatch shape).
    const now = Date.now()
    teamStore.insertTeam({
      id: OFFICE,
      name: 'relay office',
      owningSpaceId: 'space-1',
      goal: 'g',
      leadAppId: null,
      memberSourcing: 'manual',
      collabMode: 'structured',
      escalationRouting: 'user',
      status: 'idle',
      currentEpochId: null,
      createdAt: now,
      updatedAt: now,
      hostNodeId: NODE_HOST,
    })
    teamStore.addMember({
      teamId: OFFICE,
      appId: MEMBER,
      memberName: 'Other',
      role: 'analyst',
      isLead: false,
      aiProvisioned: false,
      addedAt: now,
      ownerNodeId: NODE_OWNER,
      origin: 'remote',
    })

    manager = createFederationManager({
      hostSend: () => false,
      hostListOfficeClients: () => [],
      federationStore,
      teamStore,
      verifyCredential: () => null,
      getLocalNodeId: () => NODE_SELF,
    })
    // Register the joined office; the WS client cannot connect (dead endpoint),
    // which is irrelevant here — the ctrl feed publish is durable-outbox-first.
    await manager.joinOffice({
      officeId: OFFICE,
      serverUrl: 'http://127.0.0.1:1',
      credentialToken: 't',
      selfContext: { officeId: OFFICE, selfNodeId: NODE_SELF },
      bringMembers: [],
    })
  })

  afterEach(() => {
    manager.stopAll()
    shutdownFederationStore()
    dbManager.closeAll()
  })

  it('credits a self-labeled upstream ack to the authority (delivery accounting)', () => {
    manager.sendWakeToMember({
      officeId: OFFICE,
      ownerNodeId: NODE_OWNER,
      request: { appId: MEMBER, spaceId: 's', message: 'hi', conversationId: 'c' } as unknown as SerializedWakeRequest,
      correlationId: 'corr-ack',
    })
    const feedStore = getFeedStore()!
    const ownCtrlKey = feedIdKey({ officeId: OFFICE, author: NODE_SELF, kind: 'ctrl' })
    const seq = feedStore.getMaxSeq(OFFICE, ownCtrlKey)

    // The authority's ack arrives over the joined office's single upstream leg,
    // which labels inbound frames with THIS node's id. Delivery accounting
    // (deliveredUpTo / the give-up backstop) queries by the authority's REAL id,
    // so the router must normalize the label — otherwise every joiner-published
    // wake is falsely declared undeliverable at the backstop.
    manager.deliverInbound(OFFICE, {
      kind: 'feed-ack',
      officeId: OFFICE,
      feedKey: ownCtrlKey,
      ackedSeq: seq,
    } as unknown as Parameters<FederationManager['deliverInbound']>[1])
    expect(feedStore.getPeerCursor(OFFICE, ownCtrlKey, NODE_HOST)).toBe(seq)
  })

  it('publishes the ctrl wake addressed to the authority, not the final owner', () => {
    const sent = manager.sendWakeToMember({
      officeId: OFFICE,
      ownerNodeId: NODE_OWNER,
      request: { appId: MEMBER, spaceId: 's', message: 'hi', conversationId: 'c' } as unknown as SerializedWakeRequest,
      correlationId: 'corr-relay',
    })
    expect(sent).toBe(true)

    const feedStore = getFeedStore()!
    const ownCtrlKey = feedIdKey({ officeId: OFFICE, author: NODE_SELF, kind: 'ctrl' })
    const entries = feedStore.listAfter(OFFICE, ownCtrlKey, 0, 10)
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('wake')
    expect((entries[0].payload as { target: string }).target).toBe(NODE_HOST)
  })
})
