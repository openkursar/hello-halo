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
  reorderSpaces as serviceReorderSpaces,
  getSpacePreferences as serviceGetSpacePreferences,
  updateSpacePreferences as serviceUpdateSpacePreferences,
  getSpaceDir,
  setSpaceWorkingDir,
  workingDirChangeProblem,
} from '../services/space.service'
import { getSpaceMemoryStatus as serviceGetSpaceMemoryStatus, consolidateSpaceMemoryNow } from '../services/memory-consolidation'
import { closeSpaceSessions, copyStoredSessions, countSessionAcquisitions, invalidateSessionsForSpace, isSpaceBusy, retireWorkingDirs } from '../services/agent'
import { rerootSpaceWatcher } from '../services/watcher-host.service'
import { destroySpaceCache, rerootSpaceCache } from '../services/artifact-cache.service'
import { listPinnedWorkDirs, repointSpaceEnvironments } from '../apps/runtime'
import { resolve } from 'path'
import type { MemorySettings } from '../../shared/types/memory'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  code?: string
}

const SPACE_BUSY_DELETE = 'A reply, run or background task is still going in this workspace. Delete it once it has finished, or stop it first.'

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
 * Delete a space. Refused while anything runs in it. Otherwise its engine
 * processes and file watching stop first: Windows will not remove a folder
 * that a live process works in.
 */
export async function deleteSpace(spaceId: string): Promise<ControllerResponse> {
  try {
    if (isSpaceBusy(spaceId)) return { success: false, error: SPACE_BUSY_DELETE, code: 'SPACE_BUSY' }
    await closeSpaceSessions(spaceId, 'space deleted')
    // Checked before the file cache goes too, so a refused delete leaves the open file tree live.
    if (isSpaceBusy(spaceId)) return { success: false, error: SPACE_BUSY_DELETE, code: 'SPACE_BUSY' }
    await destroySpaceCache(spaceId)
    // And again right before the folder goes: tearing the cache down yields.
    if (isSpaceBusy(spaceId)) return { success: false, error: SPACE_BUSY_DELETE, code: 'SPACE_BUSY' }
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

/** Spaces whose working directory is being changed right now. */
const changingWorkingDir = new Set<string>()

const SPACE_BUSY = 'A reply, run or background task is still going in this workspace. Change the folder once it has finished, or stop it first.'

const STARTED_WHILE_COPYING = 'A reply or run started in this workspace while its conversations were being copied. Try again.'

/**
 * Point a space at another working directory — its folder was moved, deleted,
 * or chosen wrongly. Nothing may be written to the old folder once its
 * sessions are copied, or the next turn in the new folder would miss it:
 *   1. refused while anything runs in the space;
 *   2. the engine's stored sessions are copied to the new folder's name, so
 *      conversations keep their memory — before anything points there;
 *   3. refused if any session of the space was asked for meanwhile, even one
 *      that has finished again; from this check to the end nothing awaits;
 *   4. the space record, then every environment its digital humans pinned;
 *      from then on no session starts in the folders it left, so a turn that
 *      read the old folder just before is refused instead of run there;
 *   5. resident sessions rebuild; the file panel and file triggers watch the
 *      new folder.
 * Nothing in either folder is moved, created or deleted, and Halo's own data
 * for the space stays where it is. The default space keeps its folder.
 */
export async function changeSpaceWorkingDir(spaceId: string, workingDir: unknown): Promise<ControllerResponse> {
  if (typeof workingDir !== 'string') return { success: false, error: 'Choose a folder by its full path.' }
  const problem = workingDirChangeProblem(spaceId, workingDir.trim())
  if (problem) return { success: false, error: problem }
  if (changingWorkingDir.has(spaceId)) return { success: false, error: 'This workspace’s folder is already being changed.' }
  if (isSpaceBusy(spaceId)) return { success: false, error: SPACE_BUSY }
  const acquisitions = countSessionAcquisitions(spaceId)

  const target = resolve(workingDir.trim())
  changingWorkingDir.add(spaceId)
  try {
    const previous = new Set([getSpaceDir(spaceId), ...listPinnedWorkDirs(spaceId)])
    previous.delete(target)
    let carried = 0
    for (const dir of previous) carried += await copyStoredSessions(dir, target)
    if (isSpaceBusy(spaceId)) return { success: false, error: SPACE_BUSY }
    if (countSessionAcquisitions(spaceId) !== acquisitions) return { success: false, error: STARTED_WHILE_COPYING }

    const updated = setSpaceWorkingDir(spaceId, target)
    if (!updated) return { success: false, error: 'Space not found' }
    const repointed = repointSpaceEnvironments(spaceId, target)
    retireWorkingDirs(spaceId, previous, target)
    invalidateSessionsForSpace(spaceId, 'working directory change')
    rerootSpaceWatcher(spaceId, target)
    rerootSpaceCache(spaceId, target)
    console.log(
      `[SpaceController] ${spaceId} works in ${target} now (was ${[...previous].join(', ') || 'the same'}): ` +
      `${carried} stored session file(s) carried over, ${repointed} pinned environment(s) moved`
    )
    return { success: true, data: updated }
  } catch (error: unknown) {
    console.error(`[SpaceController] Changing the working directory of ${spaceId} failed:`, error)
    return { success: false, error: (error as Error).message }
  } finally {
    changingWorkingDir.delete(spaceId)
  }
}

export function getSpacePreferences(spaceId: string): ControllerResponse {
  try {
    return { success: true, data: serviceGetSpacePreferences(spaceId) }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
  }
}

/** Only the known preference groups are taken from the caller. */
export function updateSpacePreferences(
  spaceId: string,
  body: { layout?: { artifactRailExpanded?: boolean; chatWidth?: number }; memory?: MemorySettings }
): ControllerResponse {
  try {
    const preferences: { layout?: typeof body.layout; memory?: MemorySettings } = {}
    if (body.layout && typeof body.layout === 'object') preferences.layout = body.layout
    if (body.memory && typeof body.memory === 'object') preferences.memory = body.memory
    const space = serviceUpdateSpacePreferences(spaceId, preferences)
    return space ? { success: true, data: space } : { success: false, error: 'Failed to update space preferences' }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
  }
}

export async function getSpaceMemoryStatus(spaceId: string): Promise<ControllerResponse> {
  try {
    const status = await serviceGetSpaceMemoryStatus(spaceId)
    return status ? { success: true, data: status } : { success: false, error: 'Space not found' }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
  }
}

export function consolidateSpaceMemory(spaceId: string): ControllerResponse {
  try {
    const result = consolidateSpaceMemoryNow(spaceId)
    console.log(`[Space] Memory consolidation requested for ${spaceId}: started=${result.started}${result.reason ? ` (${result.reason})` : ''}`)
    return { success: true, data: result }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
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
