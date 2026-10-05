/**
 * Unit tests for platform/task-state
 *
 * Tests:
 * - Store CRUD: unseen -> read transitions, keep/remove, space cascade
 * - Expiry sweep (grace-period cutoff)
 * - Service-level guard: listed digital-human sessions persist, channel sessions do not
 * - Rows of conversations that no longer exist are refused and pruned
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TaskStateStore } from '../../../../src/main/platform/task-state/store'
import { createTaskStateService } from '../../../../src/main/platform/task-state/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/platform/task-state/migrations'
import type { TaskStateService } from '../../../../src/main/platform/task-state/service'

describe('TaskStateStore', () => {
  let dbManager: DatabaseManager
  let store: TaskStateStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TaskStateStore(db)
  })

  it('upsertUnseen creates an unseen row', () => {
    store.upsertUnseen('conv-1', 'space-1', 'My Conversation', 1000)
    const rows = store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      conversationId: 'conv-1',
      spaceId: 'space-1',
      title: 'My Conversation',
      state: 'unseen',
      originalStatus: 'completed-unseen',
      readAt: null,
      kept: false,
    })
  })

  it('upsertRead transitions a row to read with the given originalStatus', () => {
    store.upsertUnseen('conv-1', 'space-1', 'Title', 1000)
    store.upsertRead('conv-1', 'space-1', 'Title', 'completed-unseen', 2000)

    const rows = store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'read',
      originalStatus: 'completed-unseen',
      readAt: 2000,
      kept: false,
    })
  })

  it('upsertRead can create a row directly (live-error path never has an unseen row first)', () => {
    store.upsertRead('conv-err', 'space-1', 'Errored', 'error', 5000)
    const rows = store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'read', originalStatus: 'error', readAt: 5000 })
  })

  it('setKept is a no-op on an unseen row', () => {
    store.upsertUnseen('conv-1', 'space-1', 'Title', 1000)
    store.setKept('conv-1', true)
    expect(store.list()[0].kept).toBe(false)
  })

  it('setKept flips the kept flag on a read row', () => {
    store.upsertRead('conv-1', 'space-1', 'Title', 'completed-unseen', 1000)
    store.setKept('conv-1', true)
    expect(store.list()[0].kept).toBe(true)
  })

  it('remove deletes the row', () => {
    store.upsertUnseen('conv-1', 'space-1', 'Title', 1000)
    store.remove('conv-1')
    expect(store.list()).toHaveLength(0)
  })

  it('deleteIdAndChildren removes the id and its ":"-scoped children only', () => {
    store.upsertUnseen('app-chat:a1', 'space-1', 'A', 1000)
    store.upsertUnseen('app-chat:a1:local:direct:s1', 'space-1', 'A', 1000)
    store.upsertUnseen('app-chat:a10', 'space-1', 'B', 1000)
    store.deleteIdAndChildren('app-chat:a1')

    expect(store.list().map(r => r.conversationId)).toEqual(['app-chat:a10'])
  })

  it('deleteAllInSpace only removes rows for that space', () => {
    store.upsertUnseen('conv-1', 'space-a', 'A', 1000)
    store.upsertUnseen('conv-2', 'space-b', 'B', 1000)
    store.deleteAllInSpace('space-a')

    const rows = store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].conversationId).toBe('conv-2')
  })

  it('deleteExpiredRead removes only non-kept read rows past the grace period', () => {
    const now = Date.now()
    store.upsertRead('expired', 'space-1', 'Expired', 'completed-unseen', now - 120_000)
    store.upsertRead('fresh', 'space-1', 'Fresh', 'completed-unseen', now - 1_000)
    store.upsertRead('expired-but-kept', 'space-1', 'Kept', 'completed-unseen', now - 120_000)
    store.setKept('expired-but-kept', true)
    store.upsertUnseen('still-unseen', 'space-1', 'Unseen', now)

    const removed = store.deleteExpiredRead(60_000)

    expect(removed).toBe(1)
    const remainingIds = store.list().map(r => r.conversationId).sort()
    expect(remainingIds).toEqual(['expired-but-kept', 'fresh', 'still-unseen'])
  })

  it('a second upsertUnseen call replaces the prior row instead of duplicating it', () => {
    store.upsertUnseen('conv-1', 'space-1', 'First title', 1000)
    store.upsertUnseen('conv-1', 'space-1', 'Second title', 2000)

    const rows = store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Second title')
  })
})

describe('TaskStateService', () => {
  let dbManager: DatabaseManager
  let store: TaskStateStore
  let service: TaskStateService
  let gone: Set<string>

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TaskStateStore(db)
    gone = new Set()
    service = createTaskStateService(store, (conversationId) => gone.has(conversationId))
  })

  it('persists the digital-human sessions listed beside conversations', () => {
    service.markUnseen('app-chat:some-app-id', 'space-1', '')
    service.markUnseen('app-chat:some-app-id:local:direct:abc', 'space-1', '')
    expect(service.list().map(row => row.conversationId).sort()).toEqual([
      'app-chat:some-app-id',
      'app-chat:some-app-id:local:direct:abc',
    ])
  })

  it('never persists IM, HTTP or team channel sessions', () => {
    service.markUnseen('app-chat:some-app-id:wecom:direct:user1', 'space-1', '')
    service.markUnseen('app-chat:some-app-id:team:team1:epoch1', 'space-1', '')
    service.markRead('app-chat:some-app-id:http:direct:x', 'space-1', '', 'error')
    expect(service.list()).toHaveLength(0)
  })

  it('markUnseen/markRead/setKept/remove round-trip through list()', () => {
    service.markUnseen('conv-1', 'space-1', 'Title')
    expect(service.list()).toHaveLength(1)

    service.markRead('conv-1', 'space-1', 'Title', 'completed-unseen')
    expect(service.list()[0].state).toBe('read')

    service.setKept('conv-1', true)
    expect(service.list()[0].kept).toBe(true)

    service.remove('conv-1')
    expect(service.list()).toHaveLength(0)
  })

  it('a report for a conversation that no longer exists drops its row instead', () => {
    service.markUnseen('conv-1', 'space-1', 'Title')
    gone.add('conv-1')

    service.markUnseen('conv-1', 'space-1', 'Title')
    expect(service.list()).toHaveLength(0)

    service.markRead('conv-1', 'space-1', 'Title', 'completed-unseen')
    expect(service.list()).toHaveLength(0)
  })

  it('pruneGone removes only rows of conversations that no longer exist', () => {
    service.markUnseen('conv-1', 'space-1', 'One')
    service.markRead('conv-2', 'space-1', 'Two', 'error')
    service.markUnseen('conv-3', 'space-1', 'Three')
    gone.add('conv-1').add('conv-2')

    expect(service.pruneGone()).toBe(2)
    expect(service.list().map(row => row.conversationId)).toEqual(['conv-3'])
    expect(service.pruneGone()).toBe(0)
  })

  it('dispose() stops the sweep timer without throwing', () => {
    expect(() => service.dispose()).not.toThrow()
  })
})
