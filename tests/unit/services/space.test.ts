/**
 * Space Service Unit Tests
 *
 * Tests for workspace/space management service.
 * Covers space creation, listing, and stats calculation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// Lets a test make the index rename fail, the way a file held open by another
// process (an antivirus scan on Windows) fails it.
const renameFault = vi.hoisted(() => ({ failures: 0, code: 'EPERM' }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (renameFault.failures > 0 && String(to).endsWith('spaces-index.json')) {
      renameFault.failures--
      throw Object.assign(new Error(`${renameFault.code}: operation not permitted, rename`), { code: renameFault.code })
    }
    return actual.renameSync(from, to)
  }
  return { ...actual, renameSync, default: { ...actual, renameSync } }
})

import {
  getHaloSpace,
  listSpaces,
  createSpace,
  getSpace,
  getSpaceWithPreferences,
  getSpaceDir,
  setSpaceWorkingDir,
  deleteSpace,
  getAllSpacePaths,
  touchSpaceActivity,
  flushSpaceActivity,
  reorderSpaces,
  updateSpace,
  _resetSpaceRegistry,
  _resetActivityState
} from '../../../src/main/services/space.service'
import { initializeApp, getHaloDir, getSpacesDir, getTempSpacePath } from '../../../src/main/foundation/config.service'

describe('Space Service', () => {
  beforeEach(async () => {
    // Reset the module-level registry so each test gets a fresh load from the new testDir
    _resetSpaceRegistry()
    _resetActivityState()
    renameFault.failures = 0
    renameFault.code = 'EPERM'
    await initializeApp()
  })

  describe('getHaloSpace', () => {
    it('should return the Halo temp space', async () => {
      const haloSpace = getHaloSpace()

      expect(haloSpace.id).toBe('halo-temp')
      expect(haloSpace.name).toBe('Halo')
      expect(haloSpace.isTemp).toBe(true)
      expect(haloSpace.icon).toBe('sparkles')
    })

    it('should have valid path', async () => {
      const haloSpace = getHaloSpace()

      expect(haloSpace.path).toBeTruthy()
      expect(fs.existsSync(haloSpace.path)).toBe(true)
    })

  })

  describe('listSpaces', () => {
    it('should return empty array when no custom spaces exist', async () => {
      const spaces = listSpaces()

      expect(Array.isArray(spaces)).toBe(true)
      expect(spaces.length).toBe(0)
    })

    it('should include created spaces', async () => {
      // Create a test space
      await createSpace({
        name: 'Test Project',
        icon: 'folder'
      })

      const spaces = listSpaces()

      expect(spaces.length).toBe(1)
      expect(spaces[0].name).toBe('Test Project')
    })
  })

  describe('createSpace', () => {
    it('should create a new space in default directory', async () => {
      const space = await createSpace({
        name: 'My Project',
        icon: 'code'
      })

      expect(space.id).toBeTruthy()
      expect(space.name).toBe('My Project')
      expect(space.icon).toBe('code')
      expect(space.isTemp).toBe(false)
      expect(fs.existsSync(space.path)).toBe(true)
    })

    it('should create .halo directory inside space', async () => {
      const space = await createSpace({
        name: 'Test Space',
        icon: 'folder'
      })

      const haloDir = path.join(space.path, '.halo')
      expect(fs.existsSync(haloDir)).toBe(true)
    })

    it('should create meta.json with space info', async () => {
      const space = await createSpace({
        name: 'Meta Test',
        icon: 'star'
      })

      const metaPath = path.join(space.path, '.halo', 'meta.json')
      expect(fs.existsSync(metaPath)).toBe(true)

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      expect(meta.name).toBe('Meta Test')
      expect(meta.icon).toBe('star')
      expect(meta.id).toBe(space.id)
    })

    it('should handle custom path', async () => {
      const customPath = path.join(getTempSpacePath(), 'custom-project')
      fs.mkdirSync(customPath, { recursive: true })

      const space = await createSpace({
        name: 'Custom Path Space',
        icon: 'folder',
        customPath
      })

      // Since the refactor, spaces are stored centrally under getSpacesDir()/{id}/.
      // customPath is stored as workingDir (the agent's working directory), not space.path.
      expect(space.path).toContain(getSpacesDir())
      expect((space as any).workingDir).toBe(customPath)
      expect(fs.existsSync(path.join(space.path, '.halo', 'meta.json'))).toBe(true)
    })
  })

  describe('getSpace', () => {
    it('should return space by id', async () => {
      const created = await createSpace({
        name: 'Get Test',
        icon: 'folder'
      })

      const space = getSpace(created.id)

      expect(space).toBeDefined()
      expect(space?.id).toBe(created.id)
      expect(space?.name).toBe('Get Test')
    })

    it('should return null/undefined for non-existent id', async () => {
      const space = getSpace('non-existent-id')
      expect(space).toBeFalsy() // null or undefined
    })

    it('should return Halo space for halo-temp id', async () => {
      const space = getSpace('halo-temp')

      expect(space).toBeDefined()
      expect(space?.id).toBe('halo-temp')
      expect(space?.isTemp).toBe(true)
    })
  })

  describe('deleteSpace', () => {
    it('should delete space and its .halo directory', async () => {
      const space = await createSpace({
        name: 'Delete Test',
        icon: 'folder'
      })

      const haloDir = path.join(space.path, '.halo')
      expect(fs.existsSync(haloDir)).toBe(true)

      await deleteSpace(space.id)

      // .halo should be deleted, but space directory may remain (for custom paths)
      expect(fs.existsSync(haloDir)).toBe(false)
    })

    it('should not allow deleting Halo temp space', async () => {
      // deleteSpace may return false or throw for temp space
      try {
        const result = await deleteSpace('halo-temp')
        // If it returns without throwing, result should be false
        expect(result).toBeFalsy()
      } catch {
        // Expected to throw for temp space
        expect(true).toBe(true)
      }
    })

    it('fails and keeps the space when the index cannot be written, also after a restart', async () => {
      const space = await createSpace({ name: 'Locked', icon: 'folder' })
      renameFault.failures = Infinity

      expect(await deleteSpace(space.id)).toBe(false)
      expect(listSpaces().map(s => s.id)).toContain(space.id)
      expect(fs.existsSync(path.join(space.path, '.halo'))).toBe(true)

      renameFault.failures = 0
      _resetSpaceRegistry()
      expect(listSpaces().map(s => s.id)).toContain(space.id)
    })

    it('waits out a briefly locked index without blocking, then deletes', async () => {
      const space = await createSpace({ name: 'Briefly locked', icon: 'folder' })
      renameFault.failures = 2
      let otherWorkRan = false
      setTimeout(() => { otherWorkRan = true }, 0)

      expect(await deleteSpace(space.id)).toBe(true)
      expect(otherWorkRan).toBe(true)
      expect(renameFault.failures).toBe(0)
      _resetSpaceRegistry()
      expect(listSpaces().map(s => s.id)).not.toContain(space.id)
      expect(fs.existsSync(space.path)).toBe(false)
    })

    it('gives up on a lock that outlasts the retries, and a later try succeeds', async () => {
      const space = await createSpace({ name: 'Long locked', icon: 'folder' })
      renameFault.failures = 5

      expect(await deleteSpace(space.id)).toBe(false)
      expect(renameFault.failures).toBe(0)
      expect(listSpaces().map(s => s.id)).toContain(space.id)

      expect(await deleteSpace(space.id)).toBe(true)
    })
  })

  describe('deletion impact', () => {
    function registerLegacyProject(projectDir: string) {
      const id = 'legacy-project'
      const entry = {
        path: projectDir, name: 'Legacy project', icon: 'folder', sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }
      fs.mkdirSync(path.join(projectDir, '.halo'), { recursive: true })
      fs.writeFileSync(path.join(projectDir, '.halo', 'meta.json'), JSON.stringify({ id, ...entry }))
      fs.writeFileSync(path.join(getHaloDir(), 'spaces-index.json'), JSON.stringify({ version: 3, spaces: { [id]: entry } }))
      _resetSpaceRegistry()
      return id
    }

    it('reports and removes the working files of a default centralized space', async () => {
      const space = await createSpace({ name: 'Centralized project', icon: 'folder' })
      const file = path.join(space.path, 'work.txt')
      fs.writeFileSync(file, 'Centralized working file')

      expect(getSpaceWithPreferences(space.id)?.deletionEffect).toBe('workspace-files')
      expect(getSpace(space.id)?.deletionEffect).toBeUndefined()
      expect(fs.readFileSync(path.join(getHaloDir(), 'spaces-index.json'), 'utf8')).not.toContain('deletionEffect')
      expect(fs.readFileSync(path.join(space.path, '.halo', 'meta.json'), 'utf8')).not.toContain('deletionEffect')
      expect(await deleteSpace(space.id)).toBe(true)
      expect(fs.existsSync(space.path)).toBe(false)
      expect(fs.existsSync(file)).toBe(false)
    })

    it('reports data-only deletion when centralized records point to an external project', async () => {
      const projectDir = path.join(globalThis.__HALO_TEST_DIR__, 'external-project')
      fs.mkdirSync(projectDir, { recursive: true })
      const file = path.join(projectDir, 'work.txt')
      fs.writeFileSync(file, 'External working file')
      const space = await createSpace({ name: 'External project', icon: 'folder', customPath: projectDir })
      const storedFile = path.join(space.path, 'previous-work.txt')
      fs.writeFileSync(storedFile, 'A file retained with the workspace data')

      expect(getSpaceWithPreferences(space.id)?.deletionEffect).toBe('halo-data-only')
      expect(await deleteSpace(space.id)).toBe(true)
      expect(fs.existsSync(space.path)).toBe(false)
      expect(fs.existsSync(storedFile)).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).toBe('External working file')
    })

    it('preserves a legacy project without a workingDir field while removing its Halo data', async () => {
      const projectDir = path.join(globalThis.__HALO_TEST_DIR__, 'legacy-project')
      const id = registerLegacyProject(projectDir)
      const file = path.join(projectDir, 'work.txt')
      fs.writeFileSync(file, 'Legacy working file')

      expect(getSpace(id)?.workingDir).toBeUndefined()
      expect(getSpaceWithPreferences(id)?.deletionEffect).toBe('halo-data-only')
      expect(await deleteSpace(id)).toBe(true)
      expect(fs.existsSync(path.join(projectDir, '.halo'))).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).toBe('Legacy working file')
    })

    it('reports working-file deletion when workingDir points back to the centralized data directory', async () => {
      const space = await createSpace({ name: 'Own working folder', icon: 'folder' })
      const file = path.join(space.path, 'work.txt')
      fs.writeFileSync(file, 'Working file in the data directory')
      const updated = await setSpaceWorkingDir(space.id, space.path)

      expect(updated?.workingDir).toBe(space.path)
      expect(updated?.deletionEffect).toBe('workspace-files')
      expect(getSpaceWithPreferences(space.id)?.deletionEffect).toBe('workspace-files')
      expect(await deleteSpace(space.id)).toBe(true)
      expect(fs.existsSync(file)).toBe(false)
    })

    it('does not treat an external directory sharing the spaces prefix as centralized storage', async () => {
      const projectDir = `${getSpacesDir()}-archive`
      const id = registerLegacyProject(projectDir)
      const file = path.join(projectDir, 'work.txt')
      fs.writeFileSync(file, 'Prefix-sibling working file')

      expect(getSpaceWithPreferences(id)?.deletionEffect).toBe('halo-data-only')
      expect(await deleteSpace(id)).toBe(true)
      expect(fs.existsSync(path.join(projectDir, '.halo'))).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).toBe('Prefix-sibling working file')
    })
  })

  describe('index write failures', () => {
    it('a space whose creation cannot be recorded is not created', async () => {
      expect(listSpaces()).toHaveLength(0) // registry loaded, as at app start
      renameFault.failures = Infinity
      await expect(createSpace({ name: 'Unrecorded', icon: 'folder' })).rejects.toThrow()
      expect(listSpaces()).toHaveLength(0)
      expect(fs.readdirSync(getSpacesDir())).toHaveLength(0)
    })

    it('a rename that cannot be recorded is undone', async () => {
      const space = await createSpace({ name: 'Before', icon: 'folder' })
      renameFault.failures = Infinity
      expect(await updateSpace(space.id, { name: 'After' })).toBeNull()
      expect(getSpace(space.id)?.name).toBe('Before')
    })

    it('a write error that is not a lock fails at once', async () => {
      expect(listSpaces()).toHaveLength(0) // registry loaded, as at app start
      renameFault.code = 'ENOSPC'
      renameFault.failures = 1
      await expect(createSpace({ name: 'Disk full', icon: 'folder' })).rejects.toThrow('ENOSPC')
      expect(renameFault.failures).toBe(0)
      expect(listSpaces()).toHaveLength(0)
    })

    it('activity that cannot be recorded is written by the next flush', async () => {
      const space = await createSpace({ name: 'Busy', icon: 'folder' })
      renameFault.failures = Infinity
      touchSpaceActivity(space.id)
      renameFault.failures = 0
      flushSpaceActivity()
      _resetSpaceRegistry()
      expect(getSpace(space.id)?.lastActiveAt).toBeTruthy()
    })
  })

  describe('getAllSpacePaths', () => {
    it('should include temp space path', async () => {
      const paths = getAllSpacePaths()
      const tempPath = getTempSpacePath()

      expect(paths).toContain(tempPath)
    })

    it('should include created space paths', async () => {
      const space = await createSpace({
        name: 'Path Test',
        icon: 'folder'
      })

      const paths = getAllSpacePaths()

      expect(paths).toContain(space.path)
    })
  })

  describe('touchSpaceActivity', () => {
    it('should set lastActiveAt on the space', async () => {
      const space = await createSpace({ name: 'Activity Test', icon: 'folder' })
      const before = new Date().toISOString()

      touchSpaceActivity(space.id)

      const updated = getSpace(space.id)
      expect(updated).toBeDefined()
      expect(updated!.lastActiveAt).toBeDefined()
      expect(new Date(updated!.lastActiveAt!).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime())
    })

    it('should update lastActiveAt on subsequent calls', async () => {
      const space = await createSpace({ name: 'Multi Touch', icon: 'folder' })

      touchSpaceActivity(space.id)
      const first = getSpace(space.id)!.lastActiveAt!

      // Second touch within throttle window — memory should still update
      touchSpaceActivity(space.id)
      const second = getSpace(space.id)!.lastActiveAt!

      expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime())
    })

    it('should be a no-op for non-existent space', async () => {
      // Should not throw
      expect(() => touchSpaceActivity('non-existent-id')).not.toThrow()
    })

    it('does not override explicit sortOrder', async () => {
      const spaceA = await createSpace({ name: 'Space A', icon: 'folder' })
      const spaceB = await createSpace({ name: 'Space B', icon: 'folder' })

      // Reset activity state to avoid throttle interference
      _resetActivityState()

      // B was created after A, so it sorts first (new-first). Touching A must
      // not reorder the list — explicit sortOrder governs, not activity.
      touchSpaceActivity(spaceA.id)

      const spaces = listSpaces()
      expect(spaces.length).toBe(2)
      expect(spaces[0].id).toBe(spaceB.id)
    })
  })

  describe('missing spaces', () => {
    it('should preserve unavailable spaces in the index and mark them missing', async () => {
      const haloDir = getHaloDir()
      const indexPath = path.join(haloDir, 'spaces-index.json')
      const missingPath = path.join(globalThis.__HALO_TEST_DIR__, 'external-drive', 'missing-project')
      const missingId = 'missing-space-id'

      fs.writeFileSync(indexPath, JSON.stringify({
        version: 3,
        spaces: {
          [missingId]: {
            path: missingPath,
            name: 'External Project',
            icon: 'folder',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            workingDir: missingPath
          }
        }
      }, null, 2))

      _resetSpaceRegistry()

      const spaces = listSpaces()
      expect(spaces).toHaveLength(1)
      expect(spaces[0].id).toBe(missingId)
      expect(spaces[0].isMissing).toBe(true)

      const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(persisted.spaces[missingId]).toBeDefined()
    })

    it('should exclude unavailable paths from security allowlist', async () => {
      const haloDir = getHaloDir()
      const indexPath = path.join(haloDir, 'spaces-index.json')
      const missingPath = path.join(globalThis.__HALO_TEST_DIR__, 'external-drive', 'missing-project')
      const missingId = 'missing-space-id'

      fs.writeFileSync(indexPath, JSON.stringify({
        version: 3,
        spaces: {
          [missingId]: {
            path: missingPath,
            name: 'External Project',
            icon: 'folder',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            workingDir: missingPath
          }
        }
      }, null, 2))

      _resetSpaceRegistry()

      const paths = getAllSpacePaths()
      expect(paths).not.toContain(missingPath)
    })
  })

  describe('flushSpaceActivity', () => {
    it('should persist dirty activity to disk', async () => {
      const space = await createSpace({ name: 'Flush Test', icon: 'folder' })

      // First touch persists immediately + starts throttle timer
      touchSpaceActivity(space.id)
      // Second touch within throttle window marks dirty but doesn't persist
      touchSpaceActivity(space.id)

      // Flush forces persist of dirty state
      flushSpaceActivity()

      // Reload from disk to verify persistence
      _resetSpaceRegistry()
      _resetActivityState()

      const reloaded = getSpace(space.id)
      expect(reloaded).toBeDefined()
      expect(reloaded!.lastActiveAt).toBeDefined()
    })

    it('should be safe to call with no pending activity', async () => {
      expect(() => flushSpaceActivity()).not.toThrow()
    })
  })

  describe('getSpaceDir', () => {
    // Pins the boundary semantics that FileExportGate depends on:
    // "the space's working directory" must equal the agent's cwd, not the
    // internal storage path. Regressions here historically broke outbound
    // file sends for every user with a custom workingDir.

    it('returns the artifacts subdir for halo-temp', async () => {
      const dir = getSpaceDir('halo-temp')
      const expected = path.join(getTempSpacePath(), 'artifacts')
      expect(dir).toBe(expected)
    })

    it('returns workingDir when set on a custom space', async () => {
      const projectDir = path.join(getHaloDir(), 'fixtures', 'd-drive-project')
      fs.mkdirSync(projectDir, { recursive: true })

      const space = await createSpace({
        name: 'Custom Working Dir',
        icon: 'folder',
        customPath: projectDir
      })

      expect(getSpaceDir(space.id)).toBe(projectDir)
      // Must NOT silently fall back to space.path (the internal storage location)
      expect(getSpaceDir(space.id)).not.toBe(space.path)
    })

    it('falls back to space.path when workingDir is not set', async () => {
      const space = await createSpace({
        name: 'No Custom Dir',
        icon: 'folder'
      })

      expect(getSpaceDir(space.id)).toBe(space.path)
    })

    it('returns empty string for unknown spaceIds', async () => {
      expect(getSpaceDir('does-not-exist')).toBe('')
    })
  })

  describe('reorderSpaces + sortOrder', () => {
    it('assigns a smaller sortOrder to newer spaces (new sorts first)', async () => {
      const a = await createSpace({ name: 'A', icon: 'folder' })
      const b = await createSpace({ name: 'B', icon: 'folder' })

      expect(typeof a.sortOrder).toBe('number')
      expect(typeof b.sortOrder).toBe('number')
      expect(b.sortOrder!).toBeLessThan(a.sortOrder!)
    })

    it('sorts by sortOrder when all spaces have it', async () => {
      const a = await createSpace({ name: 'A', icon: 'folder' })
      const b = await createSpace({ name: 'B', icon: 'folder' })
      const c = await createSpace({ name: 'C', icon: 'folder' })

      // Reverse the order via reorderSpaces
      await reorderSpaces([c.id, b.id, a.id])

      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['C', 'B', 'A'])
    })

    it('persisted sortOrder survives a registry reload', async () => {
      const a = await createSpace({ name: 'A', icon: 'folder' })
      const b = await createSpace({ name: 'B', icon: 'folder' })

      await reorderSpaces([b.id, a.id])

      _resetSpaceRegistry()
      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['B', 'A'])
    })

    it('rejects partial lists and preserves existing order', async () => {
      const a = await createSpace({ name: 'A', icon: 'folder' })
      const b = await createSpace({ name: 'B', icon: 'folder' })

      // Establish a known order first
      await reorderSpaces([a.id, b.id])

      // Partial list (3 ids for 2 spaces, with an unknown id) — must be rejected
      await reorderSpaces([b.id, 'unknown-id', a.id])

      // Order unchanged from the successful reorder above
      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['A', 'B'])
    })

    it('rejects incomplete lists (fewer ids than spaces)', async () => {
      const a = await createSpace({ name: 'A', icon: 'folder' })
      const b = await createSpace({ name: 'B', icon: 'folder' })
      const c = await createSpace({ name: 'C', icon: 'folder' })

      await reorderSpaces([c.id, b.id, a.id])

      // Only send 2 of 3 ids — must be rejected, order preserved
      await reorderSpaces([a.id, b.id])

      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['C', 'B', 'A'])
    })

    it('new space created after reorder sorts first', async () => {
      const a = await createSpace({ name: 'A', icon: 'folder' })
      const b = await createSpace({ name: 'B', icon: 'folder' })

      await reorderSpaces([b.id, a.id])

      const c = await createSpace({ name: 'C', icon: 'folder' })
      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['C', 'B', 'A'])
    })

    // Regression: legacy index (no sortOrder) + new space. backfill assigns
    // sortOrder to the legacy entry at load; createSpace then gives the new
    // space a smaller sortOrder so it sorts first, matching the store's
    // prepend-on-create (no visual jump after re-sync).
    it('new space on legacy index (no sortOrder) sorts first', async () => {
      const haloDir = getHaloDir()
      const indexPath = path.join(haloDir, 'spaces-index.json')
      const idA = 'legacy-space-a'
      const dirA = path.join(globalThis.__HALO_TEST_DIR__, 'legacy-a')
      fs.mkdirSync(path.join(dirA, '.halo'), { recursive: true })
      fs.writeFileSync(path.join(dirA, '.halo', 'meta.json'), JSON.stringify({
        id: idA, name: 'Legacy A', icon: 'folder',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
      }))
      fs.writeFileSync(indexPath, JSON.stringify({
        version: 3,
        spaces: {
          [idA]: {
            path: dirA, name: 'Legacy A', icon: 'folder',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      }, null, 2))

      _resetSpaceRegistry()

      // New space after legacy load — must sort first (matches store prepend)
      const b = await createSpace({ name: 'New B', icon: 'folder' })
      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['New B', 'Legacy A'])

      // Persisted sortOrder should now be present on both entries
      const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(typeof persisted.spaces[idA].sortOrder).toBe('number')
      expect(typeof persisted.spaces[b.id].sortOrder).toBe('number')
      expect(persisted.spaces[b.id].sortOrder).toBeLessThan(persisted.spaces[idA].sortOrder)
    })
  })
})
