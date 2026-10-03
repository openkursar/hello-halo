/**
 * Numbered log archives: rotation shifts .1 → .N, drops the oldest, and
 * retires the single `.old` archive left by the default rotation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createNumberedArchiveFn, archivePath } from '../../../src/main/foundation/logging/rotation'

let dir: string
let logPath: string

function fileFor(path: string) {
  return {
    path,
    clear: () => { throw new Error('clear should not be needed') },
    crop: () => { throw new Error('crop should not be needed') },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'halo-log-rotation-'))
  logPath = join(dir, 'main.log')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createNumberedArchiveFn', () => {
  it('keeps at most N archives, newest first', () => {
    const archive = createNumberedArchiveFn(3)
    for (let generation = 1; generation <= 5; generation++) {
      writeFileSync(logPath, `generation ${generation}`)
      archive(fileFor(logPath))
    }

    expect(readFileSync(archivePath(logPath, 1), 'utf8')).toBe('generation 5')
    expect(readFileSync(archivePath(logPath, 2), 'utf8')).toBe('generation 4')
    expect(readFileSync(archivePath(logPath, 3), 'utf8')).toBe('generation 3')
    expect(existsSync(archivePath(logPath, 4))).toBe(false)
    expect(existsSync(logPath)).toBe(false)
  })

  it('removes the legacy .old archive', () => {
    writeFileSync(join(dir, 'main.old.log'), 'legacy')
    writeFileSync(logPath, 'current')

    createNumberedArchiveFn(5)(fileFor(logPath))

    expect(readdirSync(dir).sort()).toEqual(['main.1.log'])
  })

  it('crops instead of throwing when the rename fails', () => {
    let croppedTo = 0
    const archive = createNumberedArchiveFn(5)
    archive({ path: join(dir, 'missing.log'), clear: () => true, crop: (bytes) => { croppedTo = bytes } })
    expect(croppedTo).toBeGreaterThan(0)
  })
})
