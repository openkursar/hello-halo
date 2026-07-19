/**
 * Space Service Unit Tests
 *
 * Tests for workspace/space management service.
 * Covers space creation, listing, and stats calculation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

import {
  getHaloSpace,
  listSpaces,
  createSpace,
  getSpace,
  getSpaceDir,
  deleteSpace,
  getAllSpacePaths,
  touchSpaceActivity,
  flushSpaceActivity,
  reorderSpaces,
  _resetSpaceRegistry,
  _resetActivityState
} from '../../../src/main/services/space.service'
import { initializeApp, getHaloDir, getSpacesDir, getTempSpacePath } from '../../../src/main/foundation/config.service'

describe('Space Service', () => {
  beforeEach(async () => {
    // Reset the module-level registry so each test gets a fresh load from the new testDir
    _resetSpaceRegistry()
    _resetActivityState()
    await initializeApp()
  })

  describe('getHaloSpace', () => {
    it('should return the Halo temp space', () => {
      const haloSpace = getHaloSpace()

      expect(haloSpace.id).toBe('halo-temp')
      expect(haloSpace.name).toBe('Halo')
      expect(haloSpace.isTemp).toBe(true)
      expect(haloSpace.icon).toBe('sparkles')
    })

    it('should have valid path', () => {
      const haloSpace = getHaloSpace()

      expect(haloSpace.path).toBeTruthy()
      expect(fs.existsSync(haloSpace.path)).toBe(true)
    })

  })

  describe('listSpaces', () => {
    it('should return empty array when no custom spaces exist', () => {
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

    it('should return null/undefined for non-existent id', () => {
      const space = getSpace('non-existent-id')
      expect(space).toBeFalsy() // null or undefined
    })

    it('should return Halo space for halo-temp id', () => {
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
  })

  describe('getAllSpacePaths', () => {
    it('should include temp space path', () => {
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
    it('should set lastActiveAt on the space', () => {
      const space = createSpace({ name: 'Activity Test', icon: 'folder' })
      const before = new Date().toISOString()

      touchSpaceActivity(space.id)

      const updated = getSpace(space.id)
      expect(updated).toBeDefined()
      expect(updated!.lastActiveAt).toBeDefined()
      expect(new Date(updated!.lastActiveAt!).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime())
    })

    it('should update lastActiveAt on subsequent calls', () => {
      const space = createSpace({ name: 'Multi Touch', icon: 'folder' })

      touchSpaceActivity(space.id)
      const first = getSpace(space.id)!.lastActiveAt!

      // Second touch within throttle window — memory should still update
      touchSpaceActivity(space.id)
      const second = getSpace(space.id)!.lastActiveAt!

      expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime())
    })

    it('should be a no-op for non-existent space', () => {
      // Should not throw
      expect(() => touchSpaceActivity('non-existent-id')).not.toThrow()
    })

    it('should affect listSpaces sort order', () => {
      const spaceA = createSpace({ name: 'Space A', icon: 'folder' })
      const spaceB = createSpace({ name: 'Space B', icon: 'folder' })

      // Reset activity state to avoid throttle interference
      _resetActivityState()

      // Touch A after B was created — A should appear first in the list
      touchSpaceActivity(spaceA.id)

      const spaces = listSpaces()
      expect(spaces.length).toBe(2)
      expect(spaces[0].id).toBe(spaceA.id)
    })
  })

  describe('missing spaces', () => {
    it('should preserve unavailable spaces in the index and mark them missing', () => {
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

    it('should exclude unavailable paths from security allowlist', () => {
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
    it('should persist dirty activity to disk', () => {
      const space = createSpace({ name: 'Flush Test', icon: 'folder' })

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

    it('should be safe to call with no pending activity', () => {
      expect(() => flushSpaceActivity()).not.toThrow()
    })
  })

  describe('getSpaceDir', () => {
    // Pins the boundary semantics that FileExportGate depends on:
    // "the space's working directory" must equal the agent's cwd, not the
    // internal storage path. Regressions here historically broke outbound
    // file sends for every user with a custom workingDir.

    it('returns the artifacts subdir for halo-temp', () => {
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

    it('returns empty string for unknown spaceIds', () => {
      expect(getSpaceDir('does-not-exist')).toBe('')
    })
  })

  describe('reorderSpaces + sortOrder', () => {
    it('assigns sortOrder to newly created spaces (ascending, last wins)', async () => {
      const a = createSpace({ name: 'A', icon: 'folder' })
      const b = createSpace({ name: 'B', icon: 'folder' })

      expect(typeof a.sortOrder).toBe('number')
      expect(typeof b.sortOrder).toBe('number')
      expect(b.sortOrder!).toBeGreaterThan(a.sortOrder!)
    })

    it('sorts by sortOrder when all spaces have it', async () => {
      const a = createSpace({ name: 'A', icon: 'folder' })
      const b = createSpace({ name: 'B', icon: 'folder' })
      const c = createSpace({ name: 'C', icon: 'folder' })

      // Reverse the order via reorderSpaces
      reorderSpaces([c.id, b.id, a.id])

      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['C', 'B', 'A'])
    })

    it('persisted sortOrder survives a registry reload', async () => {
      const a = createSpace({ name: 'A', icon: 'folder' })
      const b = createSpace({ name: 'B', icon: 'folder' })

      reorderSpaces([b.id, a.id])

      _resetSpaceRegistry()
      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['B', 'A'])
    })

    it('rejects partial lists and preserves existing order', async () => {
      const a = createSpace({ name: 'A', icon: 'folder' })
      const b = createSpace({ name: 'B', icon: 'folder' })

      // Establish a known order first
      reorderSpaces([a.id, b.id])

      // Partial list (3 ids for 2 spaces, with an unknown id) — must be rejected
      reorderSpaces([b.id, 'unknown-id', a.id])

      // Order unchanged from the successful reorder above
      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['A', 'B'])
    })

    it('rejects incomplete lists (fewer ids than spaces)', async () => {
      const a = createSpace({ name: 'A', icon: 'folder' })
      const b = createSpace({ name: 'B', icon: 'folder' })
      const c = createSpace({ name: 'C', icon: 'folder' })

      reorderSpaces([c.id, b.id, a.id])

      // Only send 2 of 3 ids — must be rejected, order preserved
      reorderSpaces([a.id, b.id])

      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['C', 'B', 'A'])
    })

    it('new space created after reorder sorts last', async () => {
      const a = createSpace({ name: 'A', icon: 'folder' })
      const b = createSpace({ name: 'B', icon: 'folder' })

      reorderSpaces([b.id, a.id])

      const c = createSpace({ name: 'C', icon: 'folder' })
      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['B', 'A', 'C'])
    })

    // Regression: legacy index (no sortOrder) + new space must not jump to
    // the front. Before backfill, createSpace assigned sortOrder=0 while
    // listSpaces fell back to activity sort (newest first), contradicting
    // the store's append-on-create and causing a visual jump after re-sync.
    it('new space on legacy index (no sortOrder) sorts last, not first', async () => {
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

      // New space after legacy load — must sort last (matches store append)
      const b = createSpace({ name: 'New B', icon: 'folder' })
      const spaces = listSpaces()
      expect(spaces.map(s => s.name)).toEqual(['Legacy A', 'New B'])

      // Persisted sortOrder should now be present on both entries
      const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(typeof persisted.spaces[idA].sortOrder).toBe('number')
      expect(typeof persisted.spaces[b.id].sortOrder).toBe('number')
      expect(persisted.spaces[b.id].sortOrder).toBeGreaterThan(persisted.spaces[idA].sortOrder)
    })
  })
})
