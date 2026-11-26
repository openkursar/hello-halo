import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeToolSkillSync } from '../../../../src/main/apps/skills/tool-skills'
import { Emitter } from '../../../../src/main/platform/event'
import { CliToolStore, type CliToolSkill } from '../../../../src/main/services/cli-tools'
import { removeTree, writePackage } from '../../services/cli-tools/helpers'

const firstTool = 'com.example.tool'
const described = (text: string) => `Companion skill for the tool command-line tool. ${text}`
const secondTool = 'com.example.other'
let dir: string

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'halo-tool-skill-sync-')) })
afterEach(() => { removeTree(dir) })

function setup() {
  const store = new CliToolStore({ root: join(dir, 'cli'), runtimePath: process.execPath, runtimeNodeVersion: process.versions.node })
  const managed = new Map<string, CliToolSkill>()
  const stampPath = join(dir, 'stamp')
  const readSnapshot = vi.fn(() => store.readCurrentToolSkills())
  const upsert = vi.fn(async (skill: CliToolSkill) => { managed.set(skill.toolId, skill) })
  const remove = vi.fn(async (id: string) => { managed.delete(id) })
  const listManagedIds = vi.fn(() => [...managed.keys()])
  const start = () => subscribeToolSkillSync({ stampPath, onDidChange: store.onDidChangeCurrentTools, readSnapshot, upsert, remove, listManagedIds })
  const add = (description: string, version = '1.0.0', id = firstTool) => store.importPackage(writePackage(dir, {
    id, version, manifest: { description },
  }), { source: 'user-import' })
  return { store, managed, stampPath, readSnapshot, upsert, remove, listManagedIds, start, add }
}

describe('static CLI skill sync', () => {
  it('coalesces events, updates only changed skills, and removes a disabled or deleted tool', async () => {
    const { store, managed, readSnapshot, start, upsert, remove, add } = setup()
    const sync = start()
    try {
      await add('First tool')
      await add('Second tool', '1.0.0', secondTool)
      expect(readSnapshot).not.toHaveBeenCalled()
      await sync.afterPrepare(store.preparedCurrentToolsRevision)
      expect(readSnapshot).toHaveBeenCalledTimes(1)
      expect(upsert).toHaveBeenCalledTimes(2)
      const original = managed.get(firstTool)!
      await add('Updated first tool', '2.0.0')
      await store.setDisabled(secondTool, true)
      await vi.waitFor(() => expect(managed.get(firstTool)?.description).toBe(described('Updated first tool')))
      expect(readSnapshot).toHaveBeenCalledTimes(2)
      expect(upsert).toHaveBeenCalledTimes(3)
      expect(managed.get(firstTool)).toEqual({ ...original, description: described('Updated first tool') })
      expect(remove.mock.calls).toEqual([[secondTool]])
      await store.removeTool(firstTool)
      await vi.waitFor(() => expect(managed.has(firstTool)).toBe(false))
      expect(remove.mock.calls).toEqual([[secondTool], [firstTool]])
    } finally {
      await sync.dispose()
    }
  })

  it('reads only the stamp header on unchanged restart and never calls the lifecycle', async () => {
    const { store, stampPath, readSnapshot, listManagedIds, start, upsert, remove, add } = setup()
    const sync = start()
    await add('First tool')
    await sync.afterPrepare(store.preparedCurrentToolsRevision)
    await sync.dispose()
    const stamp = await readFile(stampPath, 'utf8')
    const restarted = start()
    try {
      await restarted.afterPrepare(store.preparedCurrentToolsRevision)
      expect(await readFile(stampPath, 'utf8')).toBe(stamp)
      expect(readSnapshot).toHaveBeenCalledTimes(1)
      expect(listManagedIds).toHaveBeenCalledTimes(1)
      expect(upsert).toHaveBeenCalledTimes(1)
      expect(remove).not.toHaveBeenCalled()
    } finally {
      await restarted.dispose()
    }
  })

  it('recovers a partially applied update even if the tool set returns to an earlier content snapshot', async () => {
    const { store, managed, stampPath, start, upsert, add } = setup()
    const sync = start()
    await add('First tool')
    const originalRevision = store.preparedCurrentToolsRevision
    await sync.afterPrepare(originalRevision)
    await sync.dispose()

    const interrupted = start()
    await add('Second tool', '2.0.0')
    upsert.mockImplementationOnce(async skill => {
      managed.set(skill.toolId, skill)
      throw new Error('Interrupted after installing the skill')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await interrupted.afterPrepare(store.preparedCurrentToolsRevision)
      expect(await readFile(stampPath, 'utf8')).toBe('pending\n')
      expect(managed.get(firstTool)?.description).toBe(described('Second tool'))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Reconciliation failed'), expect.anything())
    } finally {
      warning.mockRestore()
      await interrupted.dispose()
    }

    await store.activateVersion(firstTool, '1.0.0')
    expect(store.preparedCurrentToolsRevision).not.toBe(originalRevision)
    const restarted = start()
    try {
      await restarted.afterPrepare(store.preparedCurrentToolsRevision)
      expect(managed.get(firstTool)?.description).toBe(described('First tool'))
      expect(await readFile(stampPath, 'utf8')).not.toBe('pending\n')
    } finally {
      await restarted.dispose()
    }
  })

  it('subscribes before reconciliation and drains a newer event that arrives during a write', async () => {
    const changed = new Emitter<string>()
    let revision = 'first'
    let release!: () => void
    const upsert = vi.fn(() => Promise.resolve())
    upsert.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const sync = subscribeToolSkillSync({
      stampPath: join(dir, 'stamp'),
      onDidChange: changed.event,
      readSnapshot: async () => ({ revision, skills: [{
        toolId: firstTool, fingerprint: revision,
        describe: async () => ({ toolId: firstTool, installId: 'a1b2c3', name: 'cli-example', description: revision, body: '' }),
      }] }),
      upsert, remove: async () => {}, listManagedIds: () => [firstTool],
    })
    try {
      const initial = sync.afterPrepare(revision)
      await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
      revision = 'second'
      changed.fire(revision)
      release()
      await initial
      await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(2))
    } finally {
      release?.()
      await sync.dispose()
    }
  })
})
