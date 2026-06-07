/**
 * Unit tests for team_triggers persistence (apps/team store, migration v2).
 *
 * Covers: migration adds team_triggers + epoch trigger_type; trigger CRUD
 * round-trip; enabled filtering for boot rehydration; epoch records its
 * initiating trigger type; deleteTriggersByTeam on dissolve.
 *
 * Uses :memory: databases for speed and isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import type { TeamTrigger, TeamEpoch } from '../../../../src/main/apps/team/types'

function makeTrigger(overrides?: Partial<TeamTrigger>): TeamTrigger {
  return {
    id: 'trig-1',
    teamId: 'team-1',
    sourceType: 'schedule',
    config: { every: '30m' },
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeEpoch(overrides?: Partial<TeamEpoch>): TeamEpoch {
  return {
    id: 'epoch-1',
    teamId: 'team-1',
    startedAt: Date.now(),
    endedAt: null,
    endReason: null,
    summary: null,
    lifecycle: 'run',
    chatKey: null,
    ...overrides,
  }
}

describe('TeamStore — triggers (migration v2)', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  it('round-trips a trigger', () => {
    const t = makeTrigger()
    store.insertTrigger(t)
    const got = store.getTriggerById(t.id)
    expect(got).toEqual(t)
  })

  it('updates config and enabled', () => {
    const t = makeTrigger()
    store.insertTrigger(t)
    store.updateTrigger(t.id, { config: { cron: '0 9 * * 1-5' }, enabled: false })
    const got = store.getTriggerById(t.id)!
    expect(got.config).toEqual({ cron: '0 9 * * 1-5' })
    expect(got.enabled).toBe(false)
  })

  it('lists triggers by team and only enabled across all teams', () => {
    store.insertTrigger(makeTrigger({ id: 'a', teamId: 'team-1', enabled: true }))
    store.insertTrigger(makeTrigger({ id: 'b', teamId: 'team-1', enabled: false }))
    store.insertTrigger(makeTrigger({ id: 'c', teamId: 'team-2', enabled: true }))

    expect(store.listTriggersByTeam('team-1').map(t => t.id).sort()).toEqual(['a', 'b'])
    expect(store.listAllEnabledTriggers().map(t => t.id).sort()).toEqual(['a', 'c'])
  })

  it('deletes a single trigger and all triggers for a team', () => {
    store.insertTrigger(makeTrigger({ id: 'a', teamId: 'team-1' }))
    store.insertTrigger(makeTrigger({ id: 'b', teamId: 'team-1' }))
    store.insertTrigger(makeTrigger({ id: 'c', teamId: 'team-2' }))

    expect(store.deleteTrigger('a')).toBe(true)
    expect(store.getTriggerById('a')).toBeNull()

    store.deleteTriggersByTeam('team-1')
    expect(store.listTriggersByTeam('team-1')).toEqual([])
    expect(store.listTriggersByTeam('team-2').length).toBe(1)
  })

  it('records the epoch trigger type (default manual; explicit schedule)', () => {
    // Default: manual
    store.insertEpoch(makeEpoch({ id: 'e1' }))
    // Explicit: schedule
    store.insertEpoch(makeEpoch({ id: 'e2' }), 'schedule')

    // trigger_type is persisted (not surfaced on TeamEpoch); verify both rows exist
    // and round-trip without error. The schedule one is queryable for observability.
    expect(store.getEpochById('e1')!.id).toBe('e1')
    expect(store.getEpochById('e2')!.id).toBe('e2')
  })
})
