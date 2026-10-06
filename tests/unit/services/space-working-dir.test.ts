/**
 * A space's working directory can be pointed at another existing folder: the
 * record and meta.json change and survive a reload, the space's own data stays
 * put, and Halo never creates a folder or touches the default space.
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
  _resetSpaceRegistry,
  _resetActivityState,
} from '../../../src/main/services/space.service'
import { initializeApp, getHaloDir } from '../../../src/main/foundation/config.service'

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
})
