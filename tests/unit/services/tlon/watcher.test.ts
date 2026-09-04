/**
 * Tlon Watcher Unit Tests
 *
 * @parcel/watcher is mocked (no real filesystem watchers); the ingest module
 * is mocked to observe scan scheduling. Covers subscription keying, debounce,
 * status gating, and lifecycle cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { getTestDir } from '../../setup'

type WatchCallback = (err: Error | null, events: Array<{ type: string; path: string }>) => void

const subscriptions = new Map<string, { cb: WatchCallback; unsubscribe: ReturnType<typeof vi.fn> }>()
const subscribeMock = vi.fn(async (dir: string, cb: WatchCallback, _options?: { ignore?: string[] }) => {
  const unsubscribe = vi.fn(async () => {
    subscriptions.delete(dir)
  })
  subscriptions.set(dir, { cb, unsubscribe })
  return { unsubscribe }
})

vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: (dir: string, cb: WatchCallback, options?: { ignore?: string[] }) =>
      subscribeMock(dir, cb, options),
  },
}))

const enqueueFiles = vi.fn()
const processQueue = vi.fn(async () => {})
const rebuildIndexMd = vi.fn()
vi.mock('../../../../src/main/services/tlon/ingest', () => ({
  enqueueFiles: (...args: unknown[]) => enqueueFiles(...args),
  processQueue: (...args: unknown[]) => processQueue(...args),
  rebuildIndexMd: (...args: unknown[]) => rebuildIndexMd(...args),
}))

import {
  _resetTlonRegistry,
  createKB,
  getKB,
  updateKB,
  addRawFiles,
} from '../../../../src/main/services/tlon/service'
import {
  startWatchersForKB,
  stopWatchersForKB,
  startLinkedDirWatch,
  stopLinkedDirWatch,
  initTlonWatchers,
  shutdownTlon,
} from '../../../../src/main/services/tlon/watcher'
import { getKBRawDir } from '../../../../src/main/services/tlon/paths'
import { initializeApp } from '../../../../src/main/foundation/config.service'

function makeScratchDir(): string {
  const dir = path.join(getTestDir(), 'scratch-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('Tlon Watcher', () => {
  beforeEach(async () => {
    _resetTlonRegistry()
    subscriptions.clear()
    await initializeApp()
  })

  afterEach(async () => {
    // createKB auto-starts watchers via a fire-and-forget dynamic import;
    // settle it, then tear everything down so no handles leak across tests.
    await vi.dynamicImportSettled()
    vi.useRealTimers()
    await shutdownTlon()
  })

  async function createKbAndSettle(name: string, linkedDirs?: Array<{ path: string; label: string }>) {
    const kb = createKB({ name, linkedDirs })
    // Let createKB's automatic startWatchersForKB finish before the test acts.
    await vi.dynamicImportSettled()
    return kb
  }

  describe('subscription keying', () => {
    it('watches raw/ and every linked dir, once per key', async () => {
      const linked = makeScratchDir()
      const kb = await createKbAndSettle('Watch', [{ path: linked, label: 'docs' }])

      expect(subscriptions.has(getKBRawDir(kb.id))).toBe(true)
      expect(subscriptions.has(linked)).toBe(true)
      const callsAfterCreate = subscribeMock.mock.calls.length

      // Re-starting is a no-op thanks to key dedupe.
      await startWatchersForKB(kb.id)
      expect(subscribeMock.mock.calls.length).toBe(callsAfterCreate)
    })

    it('skips a linked path that no longer exists', async () => {
      const kb = await createKbAndSettle('Missing')
      await startLinkedDirWatch(kb.id, {
        id: 'l1',
        path: path.join(getTestDir(), 'does-not-exist'),
        label: 'gone',
        watching: true,
      })
      expect(subscriptions.has(path.join(getTestDir(), 'does-not-exist'))).toBe(false)
    })

    it('does not watch a paused KB', async () => {
      const kb = await createKbAndSettle('Paused')
      await stopWatchersForKB(kb.id)
      updateKB(kb.id, { status: 'paused' })
      await startWatchersForKB(kb.id)
      expect(subscriptions.has(getKBRawDir(kb.id))).toBe(false)
    })

    it('refuses to subscribe to a disk root', async () => {
      const kb = await createKbAndSettle('Root')
      const root = path.parse(process.cwd()).root
      await startLinkedDirWatch(kb.id, { id: 'r1', path: root, label: 'root', watching: true })
      expect(subscriptions.has(root)).toBe(false)
    })

    it('subscribes with a native ignore list for dependency and VCS dirs', async () => {
      const linked = makeScratchDir()
      await createKbAndSettle('Ignore', [{ path: linked, label: 'docs' }])

      const call = subscribeMock.mock.calls.find(c => c[0] === linked)
      expect(call).toBeDefined()
      expect(call![2]).toEqual(
        expect.objectContaining({
          ignore: expect.arrayContaining([
            path.join(linked, 'node_modules'),
            path.join(linked, '.git'),
          ]),
        })
      )
    })

    it('does not watch a linked dir marked watching=false', async () => {
      const linked = makeScratchDir()
      const kb = await createKbAndSettle('NoWatch', [{ path: linked, label: 'off' }])
      const entry = getKB(kb.id)
      if (!entry) throw new Error('KB missing')
      entry.linkedDirs[0].watching = false

      await stopWatchersForKB(kb.id)
      await startWatchersForKB(kb.id)
      expect(subscriptions.has(linked)).toBe(false)
      expect(subscriptions.has(getKBRawDir(kb.id))).toBe(true)
    })
  })

  describe('stopWatchersForKB', () => {
    it('unsubscribes raw and linked handles for that KB only', async () => {
      const linked = makeScratchDir()
      const kbA = await createKbAndSettle('A', [{ path: linked, label: 'l' }])
      const kbB = await createKbAndSettle('B')

      const rawA = subscriptions.get(getKBRawDir(kbA.id))!
      const linkedA = subscriptions.get(linked)!

      await stopWatchersForKB(kbA.id)
      expect(rawA.unsubscribe).toHaveBeenCalled()
      expect(linkedA.unsubscribe).toHaveBeenCalled()
      expect(subscriptions.has(getKBRawDir(kbB.id))).toBe(true)

      // Handles were released — a restart subscribes again.
      await startWatchersForKB(kbA.id)
      expect(subscriptions.has(getKBRawDir(kbA.id))).toBe(true)
    })

    it('stopLinkedDirWatch removes only that link', async () => {
      const linked = makeScratchDir()
      const kb = await createKbAndSettle('L')
      const link = { id: 'link-1', path: linked, label: 'l', watching: true }
      await startLinkedDirWatch(kb.id, link)
      expect(subscriptions.has(linked)).toBe(true)

      await stopLinkedDirWatch(kb.id, link)
      expect(subscriptions.has(linked)).toBe(false)
      expect(subscriptions.has(getKBRawDir(kb.id))).toBe(true)
    })
  })

  describe('debounced scan', () => {
    it('a burst of change events triggers exactly one enqueue+process after the debounce', async () => {
      const kb = await createKbAndSettle('Debounce')
      const scratch = makeScratchDir()
      fs.writeFileSync(path.join(scratch, 'new.md'), 'fresh doc')
      addRawFiles(kb.id, [path.join(scratch, 'new.md')])

      vi.useFakeTimers()
      const { cb } = subscriptions.get(getKBRawDir(kb.id))!
      cb(null, [{ type: 'create', path: 'new.md' }])
      cb(null, [{ type: 'update', path: 'new.md' }])
      cb(null, [{ type: 'update', path: 'new.md' }])

      expect(processQueue).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)

      expect(enqueueFiles).toHaveBeenCalledTimes(1)
      expect(enqueueFiles).toHaveBeenCalledWith(
        kb.id,
        expect.arrayContaining([expect.objectContaining({ sourcePath: 'new.md', sourceType: 'raw' })])
      )
      expect(processQueue).toHaveBeenCalledTimes(1)
      expect(processQueue).toHaveBeenCalledWith(kb.id)
    })

    it('does not scan when the KB is paused or has no candidates', async () => {
      const kb = await createKbAndSettle('NoScan')
      vi.useFakeTimers()
      const { cb } = subscriptions.get(getKBRawDir(kb.id))!

      // No candidate files at all.
      cb(null, [{ type: 'update', path: 'x' }])
      await vi.advanceTimersByTimeAsync(500)
      expect(processQueue).not.toHaveBeenCalled()

      // Candidates exist but the KB is paused.
      fs.writeFileSync(path.join(getKBRawDir(kb.id), 'doc.md'), 'content')
      updateKB(kb.id, { status: 'paused' })
      cb(null, [{ type: 'create', path: 'doc.md' }])
      await vi.advanceTimersByTimeAsync(500)
      expect(processQueue).not.toHaveBeenCalled()
    })

    it('ignores watcher errors', async () => {
      const kb = await createKbAndSettle('Err')
      fs.writeFileSync(path.join(getKBRawDir(kb.id), 'doc.md'), 'content')
      vi.useFakeTimers()
      const { cb } = subscriptions.get(getKBRawDir(kb.id))!
      cb(new Error('watch failed'), [])
      await vi.advanceTimersByTimeAsync(500)
      expect(processQueue).not.toHaveBeenCalled()
    })
  })

  describe('lifecycle', () => {
    it('initTlonWatchers refreshes index.md and watches every active KB', async () => {
      const kbActive = await createKbAndSettle('Active')
      const kbPaused = await createKbAndSettle('Inactive')
      updateKB(kbPaused.id, { status: 'paused' })
      await shutdownTlon()
      rebuildIndexMd.mockClear()

      await initTlonWatchers()
      expect(rebuildIndexMd).toHaveBeenCalledWith(kbActive.id)
      expect(rebuildIndexMd).not.toHaveBeenCalledWith(kbPaused.id)
      expect(subscriptions.has(getKBRawDir(kbActive.id))).toBe(true)
      expect(subscriptions.has(getKBRawDir(kbPaused.id))).toBe(false)
    })

    it('shutdownTlon unsubscribes everything and clears state for a restart', async () => {
      const linked = makeScratchDir()
      const kb = await createKbAndSettle('Shutdown', [{ path: linked, label: 'l' }])
      const handles = [subscriptions.get(getKBRawDir(kb.id))!, subscriptions.get(linked)!]

      await shutdownTlon()
      for (const h of handles) {
        expect(h.unsubscribe).toHaveBeenCalled()
      }
      expect(subscriptions.size).toBe(0)

      await startWatchersForKB(kb.id)
      expect(subscriptions.has(getKBRawDir(kb.id))).toBe(true)
    })
  })
})
