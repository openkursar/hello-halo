/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Space Controller - Unified business logic for space operations
 * Used by both IPC handlers and HTTP routes
 */

import {
  getHaloSpace,
  listSpaces as serviceListSpaces,
  createSpace as serviceCreateSpace,
  deleteSpace as serviceDeleteSpace,
  getSpaceWithPreferences as serviceGetSpaceWithPreferences,
  openSpaceFolder as serviceOpenSpaceFolder,
  updateSpace as serviceUpdateSpace,
  reorderSpaces as serviceReorderSpaces
} from '../services/space.service'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Get the Halo temp space
 */
export function getHaloTempSpace(): ControllerResponse {
  try {
    const space = getHaloSpace()
    return { success: true, data: space }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * List all spaces
 */
export function listSpaces(): ControllerResponse {
  try {
    const spaces = serviceListSpaces()
    return { success: true, data: spaces }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Create a new space
 */
export function createSpace(input: {
  name: string
  icon: string
  customPath?: string
}): ControllerResponse {
  try {
    const space = serviceCreateSpace(input)
    return { success: true, data: space }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Delete a space
 */
export async function deleteSpace(spaceId: string): Promise<ControllerResponse> {
  try {
    const result = await serviceDeleteSpace(spaceId)
    return { success: result }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Get a specific space by ID (with preferences for UI)
 */
export function getSpace(spaceId: string): ControllerResponse {
  try {
    const space = serviceGetSpaceWithPreferences(spaceId)
    if (space) {
      return { success: true, data: space }
    }
    return { success: false, error: 'Space not found' }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Open space folder in file explorer
 */
export function openSpaceFolder(spaceId: string): ControllerResponse {
  try {
    const result = serviceOpenSpaceFolder(spaceId)
    return { success: result }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Update space metadata
 */
export function updateSpace(
  spaceId: string,
  updates: { name?: string; icon?: string }
): ControllerResponse {
  try {
    const space = serviceUpdateSpace(spaceId, updates)
    if (space) {
      return { success: true, data: space }
    }
    return { success: false, error: 'Failed to update space' }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Persist a user-defined space ordering.
 */
export function reorderSpaces(spaceIds: string[]): ControllerResponse {
  try {
    const spaces = serviceReorderSpaces(spaceIds)
    return { success: true, data: spaces }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}
