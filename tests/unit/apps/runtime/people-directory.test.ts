import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import { buildPeopleDirectory } from '../../../../src/main/apps/runtime/people-directory'
import type { AppManagerService } from '../../../../src/main/apps/manager'
import type { AppRuntimeService } from '../../../../src/main/apps/runtime/types'

describe('bounded people directory', () => {
  let database: DatabaseManager
  let managerStore: AppManagerStore
  let activity: ActivityStore
  const memberships = [
    { appId: 'p000', teamId: 'team', teamName: 'Research', isSystemCoordinator: true },
    { appId: 'p001', teamId: 'team', teamName: 'Research', isSystemCoordinator: false },
  ]
  let manager: AppManagerService
  const runtime = { getDirectoryRuntimeSnapshot: () => ({ p001: { runningCount: 1, queued: false } }) } as unknown as AppRuntimeService
  beforeEach(() => {
    database = createDatabaseManager(':memory:')
    const db = database.getAppDatabase()
    database.runMigrations(db, 'app_manager', managerMigrations)
    database.runMigrations(db, 'app_runtime', migrations)
    managerStore = new AppManagerStore(db)
    activity = new ActivityStore(db)
    manager = {
      listPeopleDirectory: filter => managerStore.listPeopleDirectory(filter),
      listPersonIdsByStatus: statuses => managerStore.listPersonIdsByStatus(statuses),
    } as AppManagerService
    const insert = db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, user_config_json, status, installed_at)
      VALUES (?, ?, 'space', ?, ?, ?, 100)`)
    for (let index = 0; index < 150; index++) {
      const id = `p${String(index).padStart(3, '0')}`
      insert.run(id, id, JSON.stringify({ type: 'automation', name: id, description: 'A researcher', system_prompt: 'private prompt'.repeat(1000), i18n: { zh: { name: '研究员' } } }), '{"token":"secret-token"}', index === 149 ? 'uninstalled' : 'active')
    }
  })
  afterEach(() => database.closeAll())

  it('projects secret-free records with stable bounded pages and exact coordinator exclusion', () => {
    const page = buildPeopleDirectory(manager, activity, runtime, memberships, { limit: 24 })
    expect(page.total).toBe(148)
    expect(page.removedTotal).toBe(1)
    expect(page.items).toHaveLength(24)
    expect(page.items[0].id).toBe('p001')
    const next = buildPeopleDirectory(manager, activity, runtime, memberships, { offset: 24, limit: 24 })
    expect(next.items[0].id).toBe('p025')
    expect(buildPeopleDirectory(manager, activity, runtime, memberships, { limit: 1000 }).items).toHaveLength(100)
    expect(JSON.stringify(page)).not.toMatch(/secret-token|private prompt|system_prompt|userConfig/)
  })

  it('bounds home previews to three per type while preserving counts and display names', () => {
    const db = database.getAppDatabase()
    for (const type of ['skill', 'mcp']) for (let index = 0; index < 7; index++) {
      db.prepare(`INSERT INTO installed_apps(id, spec_id, spec_json, installed_at) VALUES (?, ?, ?, 200)`)
        .run(`${type}${index}`, `${type}${index}`, JSON.stringify({ type, name: 'canonical', display_name: 'Display', system_prompt: 'private', mcp_server: { env: { TOKEN: 'secret-token' } } }))
    }
    const home = managerStore.getStudioSummary('zh-CN', ['p000'])
    expect(home.automation.total).toBe(148)
    expect(home.automation.items).toHaveLength(3)
    expect(home.automation.items[0].name).toBe('研究员')
    expect(home.mcp).toMatchObject({ total: 7 })
    expect(home.mcp.items).toHaveLength(3)
    expect(home.mcp.items[0].name).toBe('Display')
    expect(home.skill.items).toHaveLength(3)
    expect(JSON.stringify(home)).not.toMatch(/secret-token|system_prompt|mcp_server/)
  })

  it('filters by team names, locale, pending work and removed status before pagination', () => {
    activity.insertEntry({ id: 'decision', appId: 'p001', runId: 'run', type: 'escalation', ts: 1, content: { summary: 'Choose' } })
    const page = buildPeopleDirectory(manager, activity, runtime, memberships, { q: 'Research', attention: true, teamId: 'team', language: 'zh' })
    expect(page.total).toBe(1)
    expect(page.items[0].name).toBe('研究员')
    expect(page.items[0].state).toMatchObject({ status: 'running', pendingDecisionCount: 1, runningCount: 1 })
    expect(page.items[0].state.blocked).toBeUndefined()
    expect(page.attentionTotal).toBe(1)
    expect(buildPeopleDirectory(manager, activity, runtime, memberships, { removed: true }).items.map(person => person.id)).toEqual(['p149'])
  })

  it('treats a stopped person as waiting on the owner, and a removed one as neither', () => {
    const db = database.getAppDatabase()
    db.prepare("UPDATE installed_apps SET status = 'error' WHERE id = 'p002'").run()
    db.prepare("UPDATE installed_apps SET status = 'needs_login' WHERE id = 'p003'").run()
    // A coordinator is absent from the directory, so it must not inflate the badge.
    db.prepare("UPDATE installed_apps SET status = 'error' WHERE id = 'p000'").run()
    const attention = buildPeopleDirectory(manager, activity, runtime, memberships, { attention: true })
    expect(attention.items.map(person => person.id)).toEqual(['p002', 'p003'])
    expect(attention.attentionTotal).toBe(2)
    expect(attention.items.map(person => person.state.blocked)).toEqual(['auto_disabled', 'needs_login'])
    expect(attention.items.map(person => person.state.status)).toEqual(['error', 'needs_login'])
    const removed = buildPeopleDirectory(manager, activity, runtime, memberships, { removed: true })
    expect(removed.items[0].state.blocked).toBeUndefined()
    expect(removed.items[0].state.status).toBe('paused')
  })

  it('uses a constant query count while page size grows and caps recent history', () => {
    for (let index = 0; index < 20; index++) activity.insertRun({ runId: `run${index}`, appId: 'p001', sessionKey: 'session', status: 'error', triggerType: 'manual', startedAt: index })
    const spy = vi.spyOn(database.getAppDatabase(), 'prepare')
    buildPeopleDirectory(manager, activity, runtime, memberships, { limit: 1 })
    const one = spy.mock.calls.length
    spy.mockClear()
    const page = buildPeopleDirectory(manager, activity, runtime, memberships, { limit: 100 })
    expect(spy.mock.calls.length).toBe(one)
    expect(one).toBeLessThanOrEqual(8)
    expect(page.items[0].state.consecutiveErrors).toBe(5)
    expect(activity.getDirectoryRecentRuns(['p001'])).toHaveLength(5)
    spy.mockRestore()
  })
})
