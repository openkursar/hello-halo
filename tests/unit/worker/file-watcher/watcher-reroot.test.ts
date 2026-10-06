/**
 * Against the real native watcher: what the worker does for `reroot-space` —
 * stop, then start at the new folder — leaves the space watching the new
 * folder only, even when the old folder's watcher was still starting.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProcessedFsEvent } from '../../../../src/shared/protocol/file-watcher.protocol'
import {
  startWatcher,
  stopWatcher,
  stopAll,
  setOnEventsCallback,
  setOnErrorCallback,
} from '../../../../src/worker/file-watcher/watcher'

let tmp = ''

afterEach(async () => {
  await stopAll()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
}

describe.skipIf(process.platform === 'win32')('rerooting a space’s watcher', () => {
  it('watches only the new folder, even when the old one was still starting', async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'halo-reroot-')))
    const oldRoot = join(tmp, 'old')
    const newRoot = join(tmp, 'new')
    mkdirSync(oldRoot)
    mkdirSync(newRoot)
    const events: ProcessedFsEvent[] = []
    const errors: string[] = []
    setOnEventsCallback((_spaceId, batch) => { events.push(...batch) })
    setOnErrorCallback((_spaceId, error) => { errors.push(error) })

    const stillStarting = startWatcher('space', oldRoot)
    await stopWatcher('space')
    await startWatcher('space', newRoot)
    await stillStarting

    writeFileSync(join(newRoot, 'in-new.txt'), 'hello')
    writeFileSync(join(oldRoot, 'in-old.txt'), 'hello')
    await waitFor(() => events.some(e => e.relativePath === 'in-new.txt'), 8000)
    // Give a late event from the old folder the same chance to show up.
    await new Promise(r => setTimeout(r, 500))

    expect(errors).toEqual([])
    expect(events.find(e => e.relativePath === 'in-new.txt')?.filePath).toBe(join(newRoot, 'in-new.txt'))
    expect(events.some(e => e.filePath.startsWith(oldRoot))).toBe(false)
  }, 15000)
})
