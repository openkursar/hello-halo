/**
 * spaceApi — space domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const spaceApi = {
  // ===== Space =====
  getHaloSpace: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getHaloSpace()
    }
    return httpRequest('GET', '/api/spaces/halo')
  },

  listSpaces: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listSpaces()
    }
    return httpRequest('GET', '/api/spaces')
  },

  createSpace: async (input: {
    name: string
    icon: string
    customPath?: string
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createSpace(input)
    }
    return httpRequest('POST', '/api/spaces', input)
  },

  deleteSpace: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.deleteSpace(spaceId)
    }
    return httpRequest('DELETE', `/api/spaces/${spaceId}`)
  },

  getSpace: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSpace(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}`)
  },

  openSpaceFolder: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.openSpaceFolder(spaceId)
    }
    // In remote mode, just return the path (can't open folder remotely)
    return httpRequest('POST', `/api/spaces/${spaceId}/open`)
  },

  getDefaultSpacePath: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getDefaultSpacePath()
    }
    // In remote mode, get default path from server
    return httpRequest('GET', '/api/spaces/default-path')
  },

  selectFolder: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.selectFolder()
    }
    // Cannot select folder in remote mode
    return { success: false, error: 'Cannot select folder in remote mode' }
  },

  updateSpace: async (
    spaceId: string,
    updates: { name?: string; icon?: string }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateSpace(spaceId, updates)
    }
    return httpRequest('PUT', `/api/spaces/${spaceId}`, updates)
  },

  // Update space preferences (layout settings)
  updateSpacePreferences: async (
    spaceId: string,
    preferences: {
      layout?: {
        artifactRailExpanded?: boolean
        chatWidth?: number
      }
    }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateSpacePreferences(spaceId, preferences)
    }
    return httpRequest('PUT', `/api/spaces/${spaceId}/preferences`, preferences)
  },

  // Get space preferences
  getSpacePreferences: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSpacePreferences(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/preferences`)
  },

  // Reorder spaces (persist user-defined display order)
  reorderSpaces: async (spaceIds: string[]): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.reorderSpaces(spaceIds)
    }
    return httpRequest('PUT', '/api/spaces/reorder', { spaceIds })
  },

}
