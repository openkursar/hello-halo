import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ExecutionEnvironment } from '../../../../src/shared/apps/app-types'

const env = vi.hoisted(() => ({
  events: [] as string[], spaces: new Map<string, any>(), chats: vi.fn(), stopChats: vi.fn(), copy: vi.fn(),
  suspend: vi.fn(), memoryDrain: vi.fn(), memoryRelease: vi.fn(), send: vi.fn(), broadcast: vi.fn(), repoint: vi.fn(),
  beginTeam: vi.fn(), prepareTeam: vi.fn(), maintenance: vi.fn(), notifyTasks: vi.fn(),
}))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => env.spaces.get(id) ?? null,
  getHaloSpace: () => env.spaces.get('halo-temp'),
  getSpaceMemoryLayout: (id: string) => ({ type: 'space', spaceId: id }),
  getSpaceDir: (id: string) => { const space = env.spaces.get(id); return space?.isTemp ? join(space.path, 'artifacts') : space?.workingDir || space?.path },
}))
vi.mock('../../../../src/main/services/agent', () => ({ copyStoredSessions: env.copy, beginSpaceMaintenance: env.maintenance, countSpaceWorkspaceWork: () => 0, WorkingDirectoryUnavailableError: class extends Error {} }))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({ suspendMemoryConsolidation: env.suspend }))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({ countAppChats: env.chats, stopAndDrainAppChats: env.stopChats }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamService: () => undefined, getTeamStore: () => undefined }))
vi.mock('../../../../src/main/apps/runtime/team', () => ({ beginTeamWorkspaceChange: env.beginTeam, prepareTeamWorkspaceChange: env.prepareTeam }))
vi.mock('../../../../src/main/platform/task-state', () => ({ getTaskStateService: () => ({ repointAppConversations: env.repoint, notifyStateChanged: env.notifyTasks }) }))
vi.mock('../../../../src/main/apps/skill-discovery', () => ({ listAvailableSkills: () => [] }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: env.send }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: env.broadcast }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => undefined }))
vi.mock('../../../../src/main/apps/runtime/workspace-admission', async original => {
  const actual = await original<typeof import('../../../../src/main/apps/runtime/workspace-admission')>()
  return { ...actual, acquireAppWorkspaceChange: async (ids: Iterable<string>) => {
    const release = await actual.acquireAppWorkspaceChange(ids)
    env.events.push('hold-admission')
    return () => { env.events.push('release-admission'); release() }
  } }
})

import { changeAppDefaultSpace, previewAppSpaceChange, relocateAppWorkspace, repairLegacyAppWorkspaces } from '../../../../src/main/apps/runtime/space-change'
import { pendingWorkspaceChange } from '../../../../src/main/apps/runtime/workspace-admission'
import { deleteWorkspacePreservingPeople } from '../../../../src/main/apps/runtime/workspace-deletion'

let root: string
const pathFor = (space: string) => join(root, space)
const appRoot = (space: string) => join(pathFor(space), '.halo', 'apps', 'person')
function environment(spaceId: string): ExecutionEnvironment {
  return { spaceId, spacePath: pathFor(spaceId), workDir: pathFor(spaceId), memoryDir: appRoot(spaceId), mcpBindings: {} }
}
function fixture() {
  const app = { id: 'person', specId: 'person', spaceId: 'source', status: 'active', spec: { type: 'automation', name: 'Person', requires: { mcps: [{ id: 'declared' }] } }, dataPath: undefined as string | undefined }
  const rows = [environment('source'), environment('legacy')]
  const store = {
    listAppEnvironments: vi.fn(() => rows), listSessionEnvironments: vi.fn(() => [{ sessionKey: 'app-chat:person' }, { sessionKey: 'legacy-file:person:chat' }, { sessionKey: 'app-chat:person:local:direct:second' }]),
    listAppNativeSessionIds: vi.fn(() => ['run-native']), getDecisionCounts: vi.fn(() => ({ pending: 2 })),
    relocateAppEnvironments: vi.fn((_id: string, chat: ExecutionEnvironment, run: ExecutionEnvironment) => {
      env.events.push('commit-environments')
      rows.splice(0, rows.length, chat, run)
    }),
  }
  const manager = {
    getApp: vi.fn(() => app), listEffectiveMcpApps: vi.fn(() => [{ id: 'current-connection', specId: 'declared', spec: { name: 'Connection' }, status: 'active', spaceId: 'destination' }]),
    holdWorkspaceData: vi.fn(() => { env.events.push('hold-data'); return () => env.events.push('release-data') }),
    relocateAutomationData: vi.fn(async (_id: string, destination: string, options: { commitEnvironments: () => void }) => {
      env.events.push('transfer')
      expect(pendingWorkspaceChange('person')).toBeDefined()
      options.commitEnvironments()
      app.spaceId = destination
      app.dataPath = undefined
      return { fileCount: 3 }
    }),
    recoverDataRelocations: vi.fn(async () => [] as string[]), listLegacyDataAppIds: vi.fn(() => ['person']),
  }
  const runtime = {
    getAppState: vi.fn(() => ({ status: 'running', runningCount: 99 })), getAppWorkspaceWorkCount: vi.fn(() => 3),
    stopAndDrainAppRuns: vi.fn(async () => { env.events.push('stop-runs') }),
    syncAppSubscriptions: vi.fn(() => env.events.push('sync')),
  }
  return { app, rows, manager, store, runtime }
}

beforeEach(() => {
  vi.clearAllMocks()
  env.events.length = 0
  env.spaces.clear()
  root = mkdtempSync(join(tmpdir(), 'halo-workspace-change-'))
  for (const id of ['source', 'destination', 'legacy', 'halo-temp']) {
    mkdirSync(pathFor(id), { recursive: true })
    env.spaces.set(id, { id, name: id, path: pathFor(id), isTemp: id === 'halo-temp' })
  }
  mkdirSync(join(appRoot('source'), 'runs'), { recursive: true })
  writeFileSync(join(appRoot('source'), 'memory.md'), 'known memory')
  writeFileSync(join(appRoot('source'), 'runs', '_session-ids.json'), JSON.stringify({ chat: 'chat-native', other: { sessionId: 'structured-native' }, old: { legacySessionId: 'legacy-native' } }))
  env.chats.mockReturnValue(4)
  env.stopChats.mockImplementation(async () => { env.events.push('stop-chats') })
  env.memoryDrain.mockImplementation(async () => { env.events.push('drain-memory') })
  env.memoryRelease.mockImplementation(() => env.events.push('release-memory'))
  env.suspend.mockImplementation(() => { env.events.push('suspend-memory'); return { drain: env.memoryDrain, release: env.memoryRelease } })
  env.copy.mockImplementation(async () => { env.events.push('copy-native') })
  env.send.mockImplementation(() => env.events.push('notify-renderer'))
  env.broadcast.mockImplementation(() => env.events.push('notify-web'))
  env.repoint.mockImplementation(() => env.events.push('commit-tasks'))
  env.notifyTasks.mockImplementation(() => env.events.push('notify-tasks'))
  env.maintenance.mockImplementation(() => { env.events.push('hold-space'); return { stopAndDrain: async () => {}, release: () => env.events.push('release-space') } })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('workspace change orchestration', () => {
  it('previews counts and retained conversations without admission, stopping or creating data', () => {
    const deps = fixture()
    const before = readdirSync(root, { recursive: true }).sort()
    const memory = readFileSync(join(appRoot('source'), 'memory.md'), 'utf8')
    const preview = previewAppSpaceChange(deps as never, 'person', 'destination')
    expect(preview).toMatchObject({ activeRunCount: 3, activeChatCount: 4, pendingDecisionCount: 2, retainedSessionCount: 2 })
    expect(env.events).toEqual([])
    expect(pendingWorkspaceChange('person')).toBeUndefined()
    expect(deps.manager.holdWorkspaceData).not.toHaveBeenCalled()
    expect(deps.manager.relocateAutomationData).not.toHaveBeenCalled()
    expect(deps.runtime.stopAndDrainAppRuns).not.toHaveBeenCalled()
    expect(env.stopChats).not.toHaveBeenCalled()
    expect(env.copy).not.toHaveBeenCalled()
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before)
    expect(readFileSync(join(appRoot('source'), 'memory.md'), 'utf8')).toBe(memory)
    expect(existsSync(appRoot('destination'))).toBe(false)
  })

  it('holds admission through stops, memory drain, selective native carry and transactional environment commit', async () => {
    const deps = fixture()
    await changeAppDefaultSpace(deps as never, 'person', 'destination')
    expect(env.events).toEqual(['hold-admission', 'hold-data', 'suspend-memory', 'stop-runs', 'stop-chats', 'drain-memory', 'copy-native', 'copy-native', 'transfer', 'commit-environments', 'commit-tasks', 'notify-tasks', 'sync', 'notify-renderer', 'notify-web', 'release-memory', 'release-data', 'release-admission'])
    expect(env.beginTeam).not.toHaveBeenCalled()
    expect(env.copy.mock.calls.map(call => call.slice(0, 3))).toEqual([[pathFor('source'), pathFor('destination'), undefined], [pathFor('legacy'), pathFor('destination'), undefined]])
    for (const call of env.copy.mock.calls) expect([...call[3]].sort()).toEqual(['chat-native', 'legacy-native', 'run-native', 'structured-native'])
    expect(deps.manager.relocateAutomationData.mock.calls[0].slice(0, 2)).toEqual(['person', 'destination'])
    expect(deps.store.relocateAppEnvironments).toHaveBeenCalledWith('person', expect.objectContaining({ spaceId: 'destination', memoryDir: appRoot('destination'), mcpBindings: { declared: 'current-connection' } }), expect.objectContaining({ spaceId: 'destination', memoryDir: appRoot('destination') }), undefined)
    expect(deps.rows.every(row => row.spaceId === 'destination')).toBe(true)
    expect(env.repoint).toHaveBeenCalledWith('person', 'destination')
    expect(env.send).toHaveBeenCalledWith('app:list_changed', { appId: 'person', change: 'updated' })
    expect(env.broadcast).toHaveBeenCalledWith('app:list_changed', { appId: 'person', change: 'updated' })
    expect(pendingWorkspaceChange('person')).toBeUndefined()
  })

  it('asks the store to announce only conversations that were in a deleted workspace', async () => {
    const deps = fixture()
    await relocateAppWorkspace(deps as never, 'person', 'destination', pathFor('source'))
    expect(deps.store.relocateAppEnvironments).toHaveBeenCalledWith('person', expect.anything(), expect.anything(), { kind: 'deleted', fromSpacePath: pathFor('source') })
  })

  it('does not start memory drain or transfer until both running work drains finish', async () => {
    const deps = fixture()
    let runsDone!: () => void
    let chatsDone!: () => void
    const runs = new Promise<void>(resolve => { runsDone = resolve })
    const chats = new Promise<void>(resolve => { chatsDone = resolve })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    deps.runtime.stopAndDrainAppRuns.mockImplementationOnce(async () => { started(); await runs })
    env.stopChats.mockImplementationOnce(async () => { await chats })
    const moving = changeAppDefaultSpace(deps as never, 'person', 'destination')
    try {
      await ready
      expect(env.memoryDrain).not.toHaveBeenCalled()
      expect(deps.manager.relocateAutomationData).not.toHaveBeenCalled()
      runsDone()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(env.stopChats).toHaveBeenCalledWith('person')
      expect(env.memoryDrain).not.toHaveBeenCalled()
      expect(env.copy).not.toHaveBeenCalled()
    } finally {
      runsDone()
      chatsDone()
      await moving
    }
    expect(env.memoryDrain).toHaveBeenCalledOnce()
    expect(deps.manager.relocateAutomationData).toHaveBeenCalledOnce()
  })

  it.each(['runs', 'chats', 'memory', 'native', 'transfer', 'callback', 'task-callback'])('releases every acquired hold and emits no success after %s failure', async failure => {
    const deps = fixture()
    const error = new Error(`${failure} failed`)
    if (failure === 'runs') deps.runtime.stopAndDrainAppRuns.mockRejectedValueOnce(error)
    if (failure === 'chats') env.stopChats.mockRejectedValueOnce(error)
    if (failure === 'memory') env.memoryDrain.mockRejectedValueOnce(error)
    if (failure === 'native') env.copy.mockRejectedValueOnce(error)
    if (failure === 'transfer') deps.manager.relocateAutomationData.mockRejectedValueOnce(error)
    if (failure === 'callback') deps.store.relocateAppEnvironments.mockImplementationOnce(() => { throw error })
    if (failure === 'task-callback') env.repoint.mockImplementationOnce(() => { throw error })
    await expect(changeAppDefaultSpace(deps as never, 'person', 'destination')).rejects.toBe(error)
    expect(env.events.slice(-3)).toEqual(['release-memory', 'release-data', 'release-admission'])
    expect(pendingWorkspaceChange('person')).toBeUndefined()
    expect(deps.runtime.syncAppSubscriptions).not.toHaveBeenCalled()
    expect(env.notifyTasks).not.toHaveBeenCalled()
    expect(env.send).not.toHaveBeenCalled()
    expect(env.broadcast).not.toHaveBeenCalled()
    expect(deps.app.spaceId).toBe('source')
    if (!['transfer', 'callback', 'task-callback'].includes(failure)) expect(deps.manager.relocateAutomationData).not.toHaveBeenCalled()
  })

  it('keeps all data and releases holds when session bindings cannot be read safely', async () => {
    const deps = fixture()
    writeFileSync(join(appRoot('source'), 'runs', '_session-ids.json'), '{invalid')
    await expect(changeAppDefaultSpace(deps as never, 'person', 'destination')).rejects.toThrow()
    expect(env.events.slice(-3)).toEqual(['release-memory', 'release-data', 'release-admission'])
    expect(deps.manager.relocateAutomationData).not.toHaveBeenCalled()
    expect(env.copy).not.toHaveBeenCalled()
    expect(readFileSync(join(appRoot('source'), 'memory.md'), 'utf8')).toBe('known memory')
    expect(env.send).not.toHaveBeenCalled()
  })

  it('releases early holds when the destination project is missing, without stopping work', async () => {
    const deps = fixture()
    env.spaces.get('destination').workingDir = join(root, 'missing-project')
    await expect(changeAppDefaultSpace(deps as never, 'person', 'destination')).rejects.toThrow()
    expect(env.events).toEqual(['hold-admission', 'hold-data', 'release-data', 'release-admission'])
    expect(env.stopChats).not.toHaveBeenCalled()
    expect(deps.manager.relocateAutomationData).not.toHaveBeenCalled()
    expect(pendingWorkspaceChange('person')).toBeUndefined()
  })

  it('repairs same-space legacy data rather than treating it as a no-op', async () => {
    const deps = fixture()
    deps.app.spaceId = 'destination'
    deps.app.dataPath = appRoot('source')
    await changeAppDefaultSpace(deps as never, 'person', 'destination')
    expect(deps.manager.relocateAutomationData).toHaveBeenCalledOnce()
    expect(deps.manager.relocateAutomationData.mock.calls[0][2]).toEqual(expect.objectContaining({ sources: expect.arrayContaining([{ path: appRoot('source'), spaceId: 'source' }]) }))
    expect(deps.app.dataPath).toBeUndefined()
    expect(deps.rows.every(row => row.spaceId === 'destination')).toBe(true)
  })

  it('uses the current destination when a legacy source directory and its workspace are gone', async () => {
    const deps = fixture()
    deps.app.spaceId = 'destination'
    const missingSource = join(root, 'deleted-source', '.halo', 'apps', 'person')
    deps.app.dataPath = missingSource
    env.spaces.delete('source')
    rmSync(pathFor('source'), { recursive: true })
    await changeAppDefaultSpace(deps as never, 'person', 'destination')
    expect(deps.manager.relocateAutomationData).toHaveBeenCalledWith('person', 'destination', expect.objectContaining({ sources: expect.arrayContaining([expect.objectContaining({ path: missingSource })]) }))
    expect(deps.rows.every(row => row.spaceId === 'destination')).toBe(true)
  })

  it('serializes actual move and deletion entry points globally, including unrelated people', async () => {
    const deps = fixture()
    let start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    let finish!: () => void
    const blocked = new Promise<void>(resolve => { finish = resolve })
    deps.runtime.stopAndDrainAppRuns.mockImplementationOnce(async () => { start(); await blocked })
    const moving = changeAppDefaultSpace(deps as never, 'person', 'destination')
    await started
    const deleteDeps = {
      manager: { listApps: vi.fn(() => []), holdWorkspaceData: vi.fn(() => () => {}) },
      store: { listAppIdsPinnedInSpace: vi.fn(() => []) }, runtime: {},
    }
    const remove = vi.fn(async () => true)
    const deleting = deleteWorkspacePreservingPeople(deleteDeps as never, 'legacy', remove)
    await Promise.resolve()
    await Promise.resolve()
    expect(env.maintenance).not.toHaveBeenCalled()
    expect(deleteDeps.manager.holdWorkspaceData).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    finish()
    await moving
    await expect(deleting).resolves.toBe(true)
    expect(env.events.indexOf('hold-space')).toBeGreaterThan(env.events.indexOf('release-admission'))
    expect(remove).toHaveBeenCalledOnce()
  })

  it('repairs legacy environments before runtime activation without success events or live-work stops', async () => {
    const deps = fixture()
    deps.app.spaceId = 'destination'
    deps.app.dataPath = appRoot('source')
    deps.manager.relocateAutomationData.mockImplementationOnce(async (_id, destination, options) => {
      env.events.push('transfer')
      options.commitEnvironments()
      deps.app.spaceId = destination
      deps.app.dataPath = undefined
      return { fileCount: 1 }
    })
    await repairLegacyAppWorkspaces(deps as never)
    expect(deps.manager.recoverDataRelocations).toHaveBeenCalledOnce()
    expect(deps.rows.every(row => row.spaceId === 'destination')).toBe(true)
    expect(deps.runtime.stopAndDrainAppRuns).not.toHaveBeenCalled()
    expect(env.stopChats).not.toHaveBeenCalled()
    expect(env.send).not.toHaveBeenCalled()
    expect(env.broadcast).not.toHaveBeenCalled()
    expect(env.prepareTeam).not.toHaveBeenCalled()
  })
})
