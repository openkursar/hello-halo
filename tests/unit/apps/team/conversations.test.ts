/**
 * Unit tests for the office-shared conversation + run-outcome data layer:
 *   - migration v9 columns (title / outcome)
 *   - conversation epoch lookups (open list, per-chat get, deterministic tie-break)
 *   - rename + outcome stamping on seal
 *   - idempotent whole-row epoch replication (upsertEpoch)
 *
 * Uses :memory: databases for speed and isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import type { Team, TeamEpoch } from '../../../../src/main/apps/team/types'
import { nativeConversationChatKey, memberChatKey } from '../../../../src/shared/apps/im-keys'

const SPACE = 'space-a'

function makeTeam(overrides?: Partial<Team>): Team {
  const now = Date.now()
  return {
    id: 'team-1',
    name: 'Research Team',
    owningSpaceId: SPACE,
    goal: 'Build a competitor brief',
    leadAppId: 'lead-app',
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: now,
    updatedAt: now,
    hostNodeId: null,
    ...overrides,
  }
}

function makeConversationEpoch(id: string, chatKey: string, overrides?: Partial<TeamEpoch>): TeamEpoch {
  return {
    id,
    teamId: 'team-1',
    startedAt: Date.now(),
    endedAt: null,
    endReason: null,
    summary: null,
    lifecycle: 'conversation',
    chatKey,
    title: null,
    outcome: null,
    ...overrides,
  }
}

describe('team store — conversations + outcomes (migration v9)', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    store.insertTeam(makeTeam())
  })

  afterEach(() => { dbManager.closeAll() })

  it('migration v9 adds title + outcome columns (round-trip)', () => {
    const e = makeConversationEpoch('c1', nativeConversationChatKey('u1'), { title: 'Weekly plan' })
    store.insertEpoch(e)
    const read = store.getEpochById('c1')
    expect(read?.title).toBe('Weekly plan')
    expect(read?.outcome).toBeNull()
    expect(read?.lifecycle).toBe('conversation')
  })

  it('lists ALL open conversation epochs, newest first', () => {
    store.insertEpoch(makeConversationEpoch('c1', nativeConversationChatKey('u1'), { startedAt: 1000 }))
    store.insertEpoch(makeConversationEpoch('c2', nativeConversationChatKey('u2'), { startedAt: 2000 }))
    // A sealed conversation is excluded from the open list.
    store.insertEpoch(makeConversationEpoch('c3', nativeConversationChatKey('u3'), { startedAt: 500, endedAt: 1500, endReason: 'stopped' }))
    const open = store.listOpenConversationEpochs('team-1')
    expect(open.map(e => e.id)).toEqual(['c2', 'c1'])
  })

  it('getOpenConversationEpoch resolves by chatKey and is deterministic on ties', () => {
    const key = memberChatKey('member-app')
    // Two open epochs for the same chatKey with the SAME startedAt — every node
    // must pick the same canonical row (id DESC tie-break).
    store.insertEpoch(makeConversationEpoch('aaa', key, { startedAt: 5000 }))
    store.insertEpoch(makeConversationEpoch('zzz', key, { startedAt: 5000 }))
    expect(store.getOpenConversationEpoch('team-1', key)?.id).toBe('zzz')
  })

  it('conversation epochs never shadow the run epoch pointer', () => {
    store.insertEpoch(makeConversationEpoch('c1', nativeConversationChatKey('u1')))
    // No RUN epoch open → getCurrentEpochForTeam stays null despite open conversations.
    expect(store.getCurrentEpochForTeam('team-1')).toBeNull()
    store.insertEpoch({
      id: 'run1', teamId: 'team-1', startedAt: Date.now(), endedAt: null,
      endReason: null, summary: null, lifecycle: 'run', chatKey: null,
    })
    expect(store.getCurrentEpochForTeam('team-1')?.id).toBe('run1')
  })

  it('renameEpoch sets and clears the title', () => {
    store.insertEpoch(makeConversationEpoch('c1', nativeConversationChatKey('u1')))
    store.renameEpoch('c1', 'Q3 planning')
    expect(store.getEpochById('c1')?.title).toBe('Q3 planning')
    store.renameEpoch('c1', null)
    expect(store.getEpochById('c1')?.title).toBeNull()
  })

  it('endEpoch stamps the outcome classification', () => {
    store.insertEpoch({
      id: 'run1', teamId: 'team-1', startedAt: Date.now(), endedAt: null,
      endReason: null, summary: null, lifecycle: 'run', chatKey: null,
    })
    store.endEpoch('run1', Date.now(), 'completed', 'done', 'output')
    const e = store.getEpochById('run1')
    expect(e?.outcome).toBe('output')
    expect(e?.endReason).toBe('completed')
  })

  it('upsertEpoch applies a replicated row idempotently (later write wins)', () => {
    const row = makeConversationEpoch('c1', nativeConversationChatKey('u1'), { title: 'A' })
    // First delivery inserts.
    store.upsertEpoch(row)
    expect(store.getEpochById('c1')?.title).toBe('A')
    // A later write (rename) overwrites in place; a re-delivery of the same row
    // is a no-op, never a duplicate/constraint error.
    store.upsertEpoch({ ...row, title: 'B' })
    store.upsertEpoch({ ...row, title: 'B' })
    expect(store.getEpochById('c1')?.title).toBe('B')
    expect(store.listOpenConversationEpochs('team-1').length).toBe(1)
  })

  it('upsertEpoch can seal a replicated run epoch with its outcome', () => {
    const run: TeamEpoch = {
      id: 'run1', teamId: 'team-1', startedAt: Date.now(), endedAt: null,
      endReason: null, summary: null, lifecycle: 'run', chatKey: null, outcome: null,
    }
    store.upsertEpoch(run)
    expect(store.getCurrentEpochForTeam('team-1')?.id).toBe('run1')
    store.upsertEpoch({ ...run, endedAt: Date.now(), endReason: 'completed', outcome: 'no_action' })
    expect(store.getCurrentEpochForTeam('team-1')).toBeNull()
    expect(store.getEpochById('run1')?.outcome).toBe('no_action')
  })
})
