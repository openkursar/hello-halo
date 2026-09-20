/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Space Controller - Unified business logic for space operations
 * Used by both IPC handlers and HTTP routes
 */

import {
  getHaloSpace,
  listSpaces as serviceListSpaces,
  createSpace as serviceCreateSpace,
  deleteSpace as serviceDeleteSpace,
  forgetSpace as serviceForgetSpace,
  getSpaceWithPreferences as serviceGetSpaceWithPreferences,
  openSpaceFolder as serviceOpenSpaceFolder,
  updateSpace as serviceUpdateSpace,
  reorderSpaces as serviceReorderSpaces
} from '../services/space.service'
import { getAppManager } from '../apps/manager'
import { listAvailableSkills } from '../apps/skill-discovery'
import { listConversations } from '../services/conversation.service'
import { countSpaceFiles } from '../services/artifact.service'

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
  color?: string
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
  updates: { name?: string; icon?: string; color?: string }
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

/**
 * Remove an unreachable space's registry entry (does not touch disk).
 */
export function forgetSpace(spaceId: string): ControllerResponse {
  try {
    const result = serviceForgetSpace(spaceId)
    return { success: result }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

export interface SpaceSummary {
  spaceId: string
  fileCount: number
  digitalHumanCount: number
  skillCount: number
  mcpCount: number
  globalSkillCount: number
  globalMcpCount: number
  conversationCount: number
}

/** Files worth surfacing on a card, not the exact count of a real project. */
const SUMMARY_FILE_COUNT_CAP = 999
const SUMMARY_FILE_SCAN_DEPTH = 2

/**
 * One space's asset counts for the workspace management page's cards.
 * Pulls from four domains (apps manager, skill discovery, conversations,
 * artifacts) — deliberately lives here rather than in space.service.ts,
 * which owns only the space registry itself.
 */
async function buildSpaceSummary(spaceId: string, isMissing: boolean): Promise<SpaceSummary> {
  const manager = getAppManager()

  const digitalHumanCount = manager
    ? manager.listApps({ spaceId, type: 'automation' }).filter(a => a.status !== 'uninstalled').length
    : 0

  const mcpApps = manager ? manager.listEffectiveMcpApps(spaceId) : []
  const mcpCount = mcpApps.filter(a => a.spaceId === spaceId).length
  const globalMcpCount = mcpApps.filter(a => a.spaceId === null).length

  const skills = listAvailableSkills(spaceId)
  const skillCount = skills.filter(s => s.scope === 'space').length
  const globalSkillCount = skills.filter(s => s.scope === 'global').length

  const conversationCount = listConversations(spaceId).length

  // A disconnected space's path doesn't resolve — skip the scan outright
  // rather than block on an unavailable mount point.
  let fileCount = 0
  if (!isMissing) {
    try {
      fileCount = await countSpaceFiles(spaceId, SUMMARY_FILE_COUNT_CAP, SUMMARY_FILE_SCAN_DEPTH)
    } catch (error) {
      console.error(`[Space] Failed to count files for summary (${spaceId}):`, error)
    }
  }

  return { spaceId, fileCount, digitalHumanCount, skillCount, mcpCount, globalSkillCount, globalMcpCount, conversationCount }
}

/**
 * Asset summaries for every space, for the workspace management page's
 * cards. One call, computed concurrently, so the page doesn't fan out a
 * request per card.
 *
 * listSpaces() omits the Halo temp space (it has its own getter), but the
 * management page renders a card for it too — without its summary that card
 * shows empty counts.
 */
export async function listSpaceSummaries(): Promise<ControllerResponse> {
  try {
    const spaces = [getHaloSpace(), ...serviceListSpaces()]
    const summaries = await Promise.all(
      spaces.map(s => buildSpaceSummary(s.id, !!s.isMissing))
    )
    return { success: true, data: summaries }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}
