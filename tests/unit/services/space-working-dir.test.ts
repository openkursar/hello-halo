/**
 * A space's working directory can be pointed at another existing folder: the
 * record and meta.json change and survive a reload, the space's own data stays
 * put, and Halo never creates a folder or touches the default space. A write
 * that fails changes nothing, and the folders Halo and the engine keep their
 * own data in are refused.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

import {
  createSpace,
  getHaloSpace,
  getSpace,
  getSpaceDir,
  setSpaceWorkingDir,
  workingDirProblem,
  workingDirChangeProblem,
  _resetSpaceRegistry,
  _resetActivityState,
} from '../../../src/main/services/space.service'
import { initializeApp, getHaloDir, getSpacesDir, resolveClaudeConfigDir } from '../../../src/main/foundation/config.service'

function folder(name: string): string {
  const dir = path.join(getHaloDir(), '..', `workdir-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('setSpaceWorkingDir', () => {
  beforeEach(async () => {
    _resetSpaceRegistry()
    _resetActivityState()
    await initializeApp()
  })

  it('points the space at the new folder, in the record and meta.json, across a reload', () => {
    const before = folder('before')
    const after = folder('after')
    const space = createSpace({ name: 'Project', icon: 'folder', customPath: before })

    const updated = setSpaceWorkingDir(space.id, after)

    expect(updated?.workingDir).toBe(after)
    expect(getSpaceDir(space.id)).toBe(after)
    const meta = JSON.parse(fs.readFileSync(path.join(space.path, '.halo', 'meta.json'), 'utf8'))
    expect(meta.workingDir).toBe(after)
    expect(meta.name).toBe('Project')

    _resetSpaceRegistry()
    expect(getSpace(space.id)?.workingDir).toBe(after)
    // Halo's own data for the space did not move.
    expect(getSpace(space.id)?.path).toBe(space.path)
  })

  it('gives a space in the default location a folder of its own', () => {
    const chosen = folder('chosen')
    const space = createSpace({ name: 'Default location', icon: 'folder' })
    expect(getSpaceDir(space.id)).toBe(space.path)

    setSpaceWorkingDir(space.id, chosen)

    expect(getSpaceDir(space.id)).toBe(chosen)
  })

  it('refuses a folder that is missing, not a folder, or not a full path — creating nothing', () => {
    const space = createSpace({ name: 'Project', icon: 'folder', customPath: folder('kept') })
    const missing = path.join(getHaloDir(), '..', 'never-created')
    const file = path.join(folder('holder'), 'notes.txt')
    fs.writeFileSync(file, 'x')

    expect(() => setSpaceWorkingDir(space.id, missing)).toThrow('That folder does not exist.')
    expect(fs.existsSync(missing)).toBe(false)
    expect(() => setSpaceWorkingDir(space.id, file)).toThrow('That is not a folder.')
    expect(() => setSpaceWorkingDir(space.id, 'relative/folder')).toThrow('Choose a folder by its full path.')
    expect(getSpace(space.id)?.workingDir).toBe(folder('kept'))
    expect(workingDirProblem(folder('fine'))).toBeNull()
  })

  it('leaves the default space and unknown spaces alone', () => {
    const halo = getHaloSpace()

    expect(setSpaceWorkingDir(halo.id, folder('elsewhere'))).toBeNull()
    expect(setSpaceWorkingDir('no-such-space', folder('elsewhere'))).toBeNull()
    expect(getSpaceDir(halo.id)).not.toBe(folder('elsewhere'))
  })

  it('changes nothing when meta.json cannot be written', () => {
    const before = folder('before')
    const space = createSpace({ name: 'Project', icon: 'folder', customPath: before })
    const metaPath = path.join(space.path, '.halo', 'meta.json')
    const metaBefore = fs.readFileSync(metaPath, 'utf8')
    // A folder where the new meta.json is staged makes the write fail.
    fs.mkdirSync(`${metaPath}.tmp`)

    expect(() => setSpaceWorkingDir(space.id, folder('after'))).toThrow()

    expect(getSpaceDir(space.id)).toBe(before)
    expect(fs.readFileSync(metaPath, 'utf8')).toBe(metaBefore)
    _resetSpaceRegistry()
    expect(getSpaceDir(space.id)).toBe(before)
  })

  it('refuses a space whose own data went with its folder, saying why', () => {
    const before = folder('before')
    const space = createSpace({ name: 'Project', icon: 'folder', customPath: before })
    fs.rmSync(path.join(space.path, '.halo'), { recursive: true })

    expect(workingDirChangeProblem(space.id, folder('after'))).toMatch(/no longer there/)
    expect(() => setSpaceWorkingDir(space.id, folder('after'))).toThrow(/no longer there/)
    expect(getSpaceDir(space.id)).toBe(before)
  })

  it('refuses folders where Halo and the engine keep their data, but takes the space’s own data folder', () => {
    const space = createSpace({ name: 'Project', icon: 'folder', customPath: folder('before') })
    const engineFolder = path.join(resolveClaudeConfigDir(), 'projects')
    fs.mkdirSync(engineFolder, { recursive: true })

    expect(workingDirProblem(getHaloDir())).toBe('That folder holds Halo’s own data. Choose a project folder.')
    expect(() => setSpaceWorkingDir(space.id, getSpacesDir())).toThrow('That folder holds Halo’s own data.')
    expect(() => setSpaceWorkingDir(space.id, engineFolder)).toThrow('That folder holds Halo’s own data.')

    setSpaceWorkingDir(space.id, space.path)
    expect(getSpaceDir(space.id)).toBe(space.path)
  })
})
