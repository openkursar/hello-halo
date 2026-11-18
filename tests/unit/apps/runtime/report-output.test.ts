/**
 * Unit tests for apps/runtime/report-output
 *
 * A reported file must end up somewhere the Artifact panel and
 * `/api/artifacts/content` can reach, which means inside the space directory.
 *
 * Where the boundary itself is tested: tests/unit/services/space-scope.test.ts
 *
 * Core invariants:
 * - A file already inside the space is left where it is
 * - A file outside is copied in, and the returned path points at the copy
 * - A copy never overwrites an existing file with the same basename
 * - A path that is not a regular file is passed through untouched
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const SPACE_ID = 'space-under-test'
let spaceDir = ''

vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (id: string) => (id === SPACE_ID ? spaceDir : ''),
}))

import { reclaimReportedFile } from '../../../../src/main/apps/runtime/report-output'

let testRoot = ''
let outsideDir = ''

beforeEach(() => {
  testRoot = join(tmpdir(), `halo-report-output-${randomUUID().slice(0, 8)}`)
  mkdirSync(testRoot, { recursive: true })
  // tmpdir() is a symlink on macOS; the module returns realpaths, so the
  // fixtures have to be expressed in the same terms to be comparable.
  testRoot = realpathSync(testRoot)
  spaceDir = join(testRoot, 'space')
  outsideDir = join(testRoot, 'outside')
  mkdirSync(spaceDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
})

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true })
})

describe('reclaimReportedFile', () => {
  it('leaves a file that is already inside the space', async () => {
    const inside = join(spaceDir, 'plan.md')
    writeFileSync(inside, '# plan')

    const result = await reclaimReportedFile(inside, SPACE_ID)

    expect(dirname(result)).not.toContain('outputs')
    expect(readFileSync(result, 'utf-8')).toBe('# plan')
    expect(existsSync(inside)).toBe(true)
  })

  it('copies a file from outside the space into outputs/', async () => {
    const outside = join(outsideDir, 'plan.md')
    writeFileSync(outside, '# plan')

    const result = await reclaimReportedFile(outside, SPACE_ID)

    expect(result).not.toBe(outside)
    expect(basename(result)).toBe('plan.md')
    expect(dirname(result)).toBe(join(spaceDir, 'outputs'))
    expect(readFileSync(result, 'utf-8')).toBe('# plan')
  })

  it('does not overwrite an earlier copy with the same basename', async () => {
    const first = join(outsideDir, 'plan.md')
    const second = join(outsideDir, 'nested', 'plan.md')
    mkdirSync(dirname(second), { recursive: true })
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')

    const firstResult = await reclaimReportedFile(first, SPACE_ID)
    const secondResult = await reclaimReportedFile(second, SPACE_ID)

    expect(secondResult).not.toBe(firstResult)
    expect(readFileSync(firstResult, 'utf-8')).toBe('first')
    expect(readFileSync(secondResult, 'utf-8')).toBe('second')
  })

  it('resolves a relative path against the space directory', async () => {
    mkdirSync(join(spaceDir, 'notes'), { recursive: true })
    writeFileSync(join(spaceDir, 'notes', 'plan.md'), '# plan')

    const result = await reclaimReportedFile('notes/plan.md', SPACE_ID)

    expect(readFileSync(result, 'utf-8')).toBe('# plan')
    expect(dirname(result)).toBe(join(spaceDir, 'notes'))
  })

  it('passes through a directory unchanged', async () => {
    const result = await reclaimReportedFile(outsideDir, SPACE_ID)

    expect(result).toBe(outsideDir)
    expect(existsSync(join(spaceDir, 'outputs'))).toBe(false)
  })

  it('passes through a missing file unchanged', async () => {
    const missing = join(outsideDir, 'gone.md')

    expect(await reclaimReportedFile(missing, SPACE_ID)).toBe(missing)
  })

  it('passes through when the space is unknown', async () => {
    const outside = join(outsideDir, 'plan.md')
    writeFileSync(outside, '# plan')

    expect(await reclaimReportedFile(outside, 'nope')).toBe(outside)
    expect(await reclaimReportedFile(outside, undefined)).toBe(outside)
  })
})
