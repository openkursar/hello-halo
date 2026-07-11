/**
 * term-state — tenure persistence + EPOCH_STALE gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { AuthorityStore } from '../../../../../../src/main/apps/federation/authority-store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../../src/main/apps/federation/migrations'
import { createTermState } from '../../../../../../src/main/apps/runtime/federation/authority/term-state'

const OFFICE = 'office-term'

describe('term-state', () => {
  let dbm: DatabaseManager
  let store: AuthorityStore

  beforeEach(() => {
    dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, FED_NS, fedMigrations)
    store = new AuthorityStore(db)
  })
  afterEach(() => dbm.closeAll())

  it('defaults to term 0 / null authority and persists bumps', () => {
    const ts = createTermState({ store, officeId: OFFICE })
    expect(ts.getTerm()).toBe(0)
    expect(ts.getAuthorityNodeId()).toBeNull()

    const t = ts.bumpTerm('node-a')
    expect(t).toBe(1)
    expect(ts.getTerm()).toBe(1)
    expect(ts.getAuthorityNodeId()).toBe('node-a')

    // A fresh facade over the same store reads the persisted state.
    const ts2 = createTermState({ store, officeId: OFFICE })
    expect(ts2.getTerm()).toBe(1)
    expect(ts2.getAuthorityNodeId()).toBe('node-a')
  })

  it('classifyTerm gates stale / ahead / ok', () => {
    const ts = createTermState({ store, officeId: OFFICE })
    ts.setAuthority('node-a', 5)
    expect(ts.classifyTerm(4)).toBe('stale')
    expect(ts.classifyTerm(5)).toBe('ok')
    expect(ts.classifyTerm(6)).toBe('ahead')
  })

  it('water marks are monotonic (never retreat)', () => {
    const ts = createTermState({ store, officeId: OFFICE })
    ts.setCommittedSeq(10)
    ts.setCommittedSeq(5) // ignored
    expect(ts.getCommittedSeq()).toBe(10)
    ts.setAppliedSeq(20)
    ts.setAppliedSeq(15) // ignored
    expect(ts.getAppliedSeq()).toBe(20)
    ts.setRosterEpoch(3)
    ts.setRosterEpoch(2) // ignored
    expect(ts.getRosterEpoch()).toBe(3)
  })

  it('setAuthority never moves the tenure backwards', () => {
    const ts = createTermState({ store, officeId: OFFICE })
    ts.setAuthority('node-a', 4)
    ts.setAuthority('node-b', 2) // lower term ignored
    expect(ts.getTerm()).toBe(4)
    expect(ts.getAuthorityNodeId()).toBe('node-a')
  })
})
