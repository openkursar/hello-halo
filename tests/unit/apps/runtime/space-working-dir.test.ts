/**
 * When a space's folder changes, the environments its digital humans pinned —
 * chat sessions, team seats and runs that can be continued — follow it; other
 * spaces' do not. A digital human chat whose folder is gone fails with an
 * error that names the folder, so the chat can offer to change it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const spaces = vi.hoisted(() => new Set<string>())
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => (spaces.has(id) ? { id } : null),
  getSpaceDir: () => '',
}))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations, MIGRATION_NAMESPACE as MANAGER_NS } from '../../../../src/main/apps/manager/migrations'
import { migrations as runtimeMigrations, MIGRATION_NAMESPACE as RUNTIME_NS } from '../../../../src/main/apps/runtime/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import { validateExecutionEnvironment } from '../../../../src/main/apps/runtime/execution-environment'
import { WorkingDirectoryUnavailableError, workingDirErrorDetail } from '../../../../src/main/services/agent'
import type { ExecutionEnvironment } from '../../../../src/shared/apps/app-types'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'halo-space-workdir-'))
  spaces.clear()
  spaces.add('space-a')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function environment(spaceId: string, workDir: string): ExecutionEnvironment {
  return { spaceId, spacePath: `/halo/spaces/${spaceId}`, workDir, memoryDir: `/halo/apps/person`, mcpBindings: {} }
}

describe('pinned environments follow the space’s folder', () => {
  function storeWithApp(): ActivityStore {
    const db = createDatabaseManager(':memory:')
    const appDb = db.getAppDatabase()
    db.runMigrations(appDb, MANAGER_NS, managerMigrations)
    db.runMigrations(appDb, RUNTIME_NS, runtimeMigrations)
    appDb.prepare(`
      INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
      VALUES ('person', 'person', 'space-a', '{}', 'active', '{}', '{}', '{"granted":[],"denied":[]}', 0)
    `).run()
    return new ActivityStore(appDb)
  }

  it('re-points chat sessions, team seats and runs of that space only', () => {
    const store = storeWithApp()
    store.pinSessionEnvironment('app-chat:person', 'person', environment('space-a', '/old/a'))
    store.pinSessionEnvironment('app-chat:person:wecom-bot:group:g-1', 'person', environment('space-a', '/older/a'))
    store.pinSessionEnvironment('team-environment:person:team-1', 'person', environment('space-a', '/old/a'))
    store.pinSessionEnvironment('app-chat:person:local:direct:other', 'person', environment('space-b', '/old/b'))
    store.insertRun({ runId: 'run-a', appId: 'person', sessionKey: 'sk-a', status: 'ok', triggerType: 'manual', startedAt: 1, environment: environment('space-a', '/old/a') })
    store.insertRun({ runId: 'run-b', appId: 'person', sessionKey: 'sk-b', status: 'ok', triggerType: 'manual', startedAt: 1, environment: environment('space-b', '/old/b') })

    expect(store.listSpaceWorkDirs('space-a').sort()).toEqual(['/old/a', '/older/a'])
    expect(store.repointSpaceWorkDir('space-a', '/new/a')).toBe(4)

    expect(store.getSessionEnvironment('app-chat:person')).toEqual(environment('space-a', '/new/a'))
    expect(store.getSessionEnvironment('app-chat:person:wecom-bot:group:g-1')?.workDir).toBe('/new/a')
    expect(store.getSessionEnvironment('team-environment:person:team-1')?.workDir).toBe('/new/a')
    expect(store.getRun('run-a')?.environment?.workDir).toBe('/new/a')
    expect(store.getSessionEnvironment('app-chat:person:local:direct:other')?.workDir).toBe('/old/b')
    expect(store.getRun('run-b')?.environment?.workDir).toBe('/old/b')
    expect(store.listSpaceWorkDirs('space-a')).toEqual(['/new/a'])
  })
})

describe('a digital human chat whose folder is gone', () => {
  it('fails with the folder and its space, which the chat turns into a change-folder offer', () => {
    const memory = join(root, 'memory')
    const storage = join(root, 'storage')
    mkdirSync(memory)
    mkdirSync(storage)
    const missing = join(root, 'redirected-desktop', 'project')

    let thrown: unknown
    try {
      validateExecutionEnvironment({ ...environment('space-a', missing), spacePath: storage, memoryDir: memory })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(WorkingDirectoryUnavailableError)
    expect(workingDirErrorDetail(thrown, 'fallback')).toEqual({
      errorType: 'working_dir_unavailable',
      workDirIssue: { spaceId: 'space-a', workDir: missing },
    })
    // The message travels on (a team lead's report, a run's memory summary);
    // the owner's local path stays in the field and the log.
    expect((thrown as Error).message).not.toContain('redirected-desktop')
  })

  it('keeps the plain message when what is missing is Halo’s own history or memory', () => {
    const workDir = join(root, 'work')
    mkdirSync(workDir)

    expect(() => validateExecutionEnvironment({ ...environment('space-a', workDir), spacePath: join(root, 'gone'), memoryDir: workDir }))
      .toThrow('The original history or memory is unavailable. Restore it before continuing.')
    expect(workingDirErrorDetail(new Error('anything else'), 'space-a')).toBeUndefined()
  })
})
