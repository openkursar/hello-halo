/**
 * Unit tests for services/space-scope
 *
 * The space directory is the boundary between "the user can open this" and
 * "the user will never find this". Core invariants:
 * - Paths inside the space, including its symlinked form, are in scope
 * - An unknown space puts nothing in scope
 * - A sibling directory sharing a name prefix with the space is not in scope
 * - Only user-facing write tools aimed outside the space produce a warning
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const SPACE_ID = 'space-under-test'
let spaceDir = ''

vi.mock('../../../src/main/services/space.service', () => ({
  getSpaceDir: (id: string) => (id === SPACE_ID ? spaceDir : ''),
}))

import {
  getOutputDir,
  isInsideSpace,
  logWriteOutsideSpace,
} from '../../../src/main/services/space-scope'

let testRoot = ''

beforeEach(() => {
  testRoot = join(tmpdir(), `halo-space-scope-${randomUUID().slice(0, 8)}`)
  mkdirSync(testRoot, { recursive: true })
  testRoot = realpathSync(testRoot)
  spaceDir = join(testRoot, 'space')
  mkdirSync(spaceDir, { recursive: true })
})

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('getOutputDir', () => {
  it('points at the outputs subdirectory of the space', () => {
    expect(getOutputDir(SPACE_ID)).toBe(join(spaceDir, 'outputs'))
  })

  it('returns an empty path for an unknown space', () => {
    expect(getOutputDir('nope')).toBe('')
    expect(getOutputDir(undefined)).toBe('')
  })
})

describe('isInsideSpace', () => {
  it('accepts the space directory and its descendants', () => {
    expect(isInsideSpace(spaceDir, SPACE_ID)).toBe(true)
    expect(isInsideSpace(join(spaceDir, 'a', 'b.md'), SPACE_ID)).toBe(true)
  })

  it('rejects a sibling whose name starts with the space name', () => {
    expect(isInsideSpace(`${spaceDir}-other/file.md`, SPACE_ID)).toBe(false)
  })

  it('accepts the space reached through a symlinked parent', () => {
    const linked = join(testRoot, 'link')
    symlinkSync(spaceDir, linked)
    spaceDir = linked

    expect(isInsideSpace(join(linked, 'file.md'), SPACE_ID)).toBe(true)
    expect(isInsideSpace(join(realpathSync(linked), 'file.md'), SPACE_ID)).toBe(true)
  })

  it('puts nothing in scope for an unknown space', () => {
    expect(isInsideSpace(spaceDir, 'nope')).toBe(false)
    expect(isInsideSpace(spaceDir, undefined)).toBe(false)
  })
})

describe('logWriteOutsideSpace', () => {
  const silenceWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
  let warn: ReturnType<typeof silenceWarn>

  beforeEach(() => {
    warn = silenceWarn()
  })

  it('warns about a Write aimed outside the space', () => {
    logWriteOutsideSpace('Write', { file_path: join(testRoot, 'elsewhere.md') }, SPACE_ID, '[T]')

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('elsewhere.md')
  })

  it('stays quiet for a Write inside the space', () => {
    logWriteOutsideSpace('Write', { file_path: join(spaceDir, 'plan.md') }, SPACE_ID, '[T]')

    expect(warn).not.toHaveBeenCalled()
  })

  it('treats a relative path as relative to the space', () => {
    logWriteOutsideSpace('Write', { file_path: 'notes/plan.md' }, SPACE_ID, '[T]')

    expect(warn).not.toHaveBeenCalled()
  })

  it('ignores tools that are not user-facing writes', () => {
    logWriteOutsideSpace('Edit', { file_path: join(testRoot, 'elsewhere.md') }, SPACE_ID, '[T]')
    logWriteOutsideSpace('Read', { file_path: join(testRoot, 'elsewhere.md') }, SPACE_ID, '[T]')

    expect(warn).not.toHaveBeenCalled()
  })

  it('stays quiet when the space is unknown or the input has no path', () => {
    logWriteOutsideSpace('Write', { file_path: join(testRoot, 'x.md') }, 'nope', '[T]')
    logWriteOutsideSpace('Write', {}, SPACE_ID, '[T]')

    expect(warn).not.toHaveBeenCalled()
  })
})
