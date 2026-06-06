/**
 * Space IPC Handlers
 */

import { dialog } from 'electron'
import {
  getHaloSpace,
  listSpaces,
  createSpace,
  deleteSpace,
  getSpaceWithPreferences,
  openSpaceFolder,
  updateSpace,
  updateSpacePreferences,
  getSpacePreferences
} from '../services/space.service'
import { getSpacesDir } from '../foundation/config.service'
import { spaceRpc } from '../../shared/rpc/contracts/space.contract'
import { registerRawRpcHandlers } from './rpc'

// Import types for preferences
interface SpaceLayoutPreferences {
  artifactRailExpanded?: boolean
  chatWidth?: number
}

interface SpacePreferences {
  layout?: SpaceLayoutPreferences
}

export function registerSpaceHandlers(): void {
  registerRawRpcHandlers(spaceRpc, {
    // Get Halo temp space
    getHaloSpace: async () => {
      try {
        const space = getHaloSpace()
        console.log('[SpaceIPC] space:get-halo response: id=%s', space?.id)
        return { success: true, data: space }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[SpaceIPC] space:get-halo error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // List all spaces
    listSpaces: async () => {
      try {
        const spaces = listSpaces()
        console.log('[SpaceIPC] space:list response: count=%d', spaces.length)
        return { success: true, data: spaces }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[SpaceIPC] space:list error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Create a new space
    createSpace: async (input: { name: string; icon: string; customPath?: string }) => {
      try {
        const space = createSpace(input)
        return { success: true, data: space }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Delete a space
    deleteSpace: async (spaceId: string) => {
      try {
        const result = await deleteSpace(spaceId)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Get a specific space (with preferences for UI)
    getSpace: async (spaceId: string) => {
      try {
        const space = getSpaceWithPreferences(spaceId)
        return { success: true, data: space }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Open space folder
    openSpaceFolder: async (spaceId: string) => {
      try {
        const result = openSpaceFolder(spaceId)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Update space
    updateSpace: async (spaceId: string, updates: { name?: string; icon?: string }) => {
      try {
        const space = updateSpace(spaceId, updates)
        return { success: true, data: space }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Get default space path
    getDefaultSpacePath: async () => {
      try {
        const spacesDir = getSpacesDir()
        return { success: true, data: spacesDir }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Select folder dialog (for custom space location)
    selectFolder: async () => {
      try {
        const result = await dialog.showOpenDialog({
          title: 'Select Space Location',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Select Folder'
        })

        if (result.canceled || result.filePaths.length === 0) {
          return { success: true, data: null }
        }

        return { success: true, data: result.filePaths[0] }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Update space preferences (layout settings)
    updateSpacePreferences: async (spaceId: string, preferences: Partial<SpacePreferences>) => {
      try {
        const space = updateSpacePreferences(spaceId, preferences)
        return { success: true, data: space }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Get space preferences
    getSpacePreferences: async (spaceId: string) => {
      try {
        const preferences = getSpacePreferences(spaceId)
        return { success: true, data: preferences }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },
  })

}
