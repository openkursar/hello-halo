import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveReportFile } from '../../../../src/main/apps/runtime/report-output'

let root: string
let workspace: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'halo-report-')))
  workspace = join(root, 'work')
  await mkdir(workspace)
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('report file selection', () => {
  it('keeps a regular workspace file in place, including an empty one', async () => {
    await writeFile(join(workspace, 'plan.md'), '')
    await expect(resolveReportFile('plan.md', workspace)).resolves.toBe(join(workspace, 'plan.md'))
  })
  it('does not import files from outside the current workspace', async () => {
    const outside = join(root, 'notes.md')
    await writeFile(outside, 'ordinary fixture')
    await expect(resolveReportFile(outside, workspace)).rejects.toThrow(join(workspace, 'outputs'))
    expect(await readdir(workspace)).toEqual([])
  })
  it('does not register an unavailable workspace, missing file or directory', async () => {
    await expect(resolveReportFile('plan.md')).rejects.toThrow('inline')
    await expect(resolveReportFile('missing', workspace)).rejects.toThrow('could not be located')
    await expect(resolveReportFile(workspace, workspace)).rejects.toThrow('not a readable file')
  })
  it('honors the permission of the current turn', async () => {
    const file = join(workspace, 'plan.md')
    await writeFile(file, 'draft')
    const refuse = vi.fn(() => 'This turn cannot share the file.')
    await expect(resolveReportFile('plan.md', workspace, refuse)).rejects.toThrow('cannot share')
    expect(refuse).toHaveBeenCalledWith(file)
  })
})
