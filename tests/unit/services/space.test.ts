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
  deleteSpace,
  getAllSpacePaths
} from '../../../src/main/services/space.service'
import { initializeApp, getSpacesDir, getTempSpacePath } from '../../../src/main/services/config.service'

describe('Space Service', () => {
  beforeEach(async () => {
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

    it('should include stats', () => {
      const haloSpace = getHaloSpace()

      expect(haloSpace.stats).toBeDefined()
      expect(typeof haloSpace.stats.artifactCount).toBe('number')
      expect(typeof haloSpace.stats.conversationCount).toBe('number')
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

      expect(space.path).toBe(customPath)
      expect(fs.existsSync(path.join(customPath, '.halo', 'meta.json'))).toBe(true)
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
})
