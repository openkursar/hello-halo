/**
 * End-to-end against the real native watcher: a space whose root is reached
 * through a symlink keeps delivering events under the root the space knows.
 *
 * Before the fix the OS-reported canonical path reached the ignore matcher as a
 * `../`-relative path, which threw inside the subscription callback and took
 * the worker down on every event.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProcessedFsEvent } from '../../../../src/shared/protocol/file-watcher.protocol'
import {
  startWatcher,
  stopAll,
  setOnEventsCallback,
  setOnErrorCallback,
} from '../../../../src/worker/file-watcher/watcher'

let tmp = ''

afterEach(async () => {
  await stopAll()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('watcher on a symlinked root', () => {
  it('delivers a created file under the symlinked root without errors', async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'halo-symlink-root-')))
    const real = join(tmp, 'real')
    mkdirSync(real)
    const link = join(tmp, 'link')
    symlinkSync(real, link)

    const events: ProcessedFsEvent[] = []
    const errors: string[] = []
    setOnEventsCallback((_spaceId, batch) => { events.push(...batch) })
    setOnErrorCallback((_spaceId, error) => { errors.push(error) })

    await startWatcher('symlink-space', link)
    writeFileSync(join(real, 'created.txt'), 'hello')

    const deadline = Date.now() + 8000
    while (!events.some(e => e.relativePath === 'created.txt') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }

    expect(errors).toEqual([])
    const created = events.find(e => e.relativePath === 'created.txt')
    expect(created?.filePath).toBe(join(link, 'created.txt'))
  }, 15000)
})
