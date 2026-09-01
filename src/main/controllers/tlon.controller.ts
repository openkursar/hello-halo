/**
 * Tlon Controller — unified business logic for knowledge base operations.
 * Shared by IPC handlers and HTTP routes. Thin wrapper around the service.
 */

import {
  createKB as svcCreateKB,
  getKB as svcGetKB,
  listKBs as svcListKBs,
  listKBsForSpace as svcListKBsForSpace,
  updateKB as svcUpdateKB,
  deleteKB as svcDeleteKB,
  setDefaultKB as svcSetDefaultKB,
  bindToSpace as svcBindToSpace,
  unbindFromSpace as svcUnbindFromSpace,
  bindToApp as svcBindToApp,
  unbindFromApp as svcUnbindFromApp,
  addLinkedDir as svcAddLinkedDir,
  removeLinkedDir as svcRemoveLinkedDir,
  addRawFiles as svcAddRawFiles,
  listRawFiles as svcListRawFiles,
  removeRawFile as svcRemoveRawFile,
  readIndexMd as svcReadIndexMd,
  triggerFullIngest as svcTriggerFullIngest,
  getIngestProgress as svcGetIngestProgress,
  clearAndRelearn as svcClearAndRelearn,
  isIngesting as svcIsIngesting,
  resolveSources as svcResolveSources,
} from '../services/tlon'
import type {
  CreateKBInput,
  UpdateKBInput,
} from '../../shared/types/tlon'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  /**
   * Stable failure discriminator (e.g. 'TOO_MANY_FILES'), mirroring
   * ApiResponse.code: lets the UI render localized messages without parsing
   * the raw error text. Known rejection modes carry structured detail in
   * `data`; absent for unknown/unexpected failures.
   */
  code?: string
}

function ok<T>(data: T): ControllerResponse<T> {
  return { success: true, data }
}

function fail(error: unknown): ControllerResponse {
  const err = error as Error
  return { success: false, error: err?.message || String(error) }
}

export function createKB(input: CreateKBInput): ControllerResponse {
  try {
    return ok(svcCreateKB(input))
  } catch (e) { return fail(e) }
}

export function listKBs(): ControllerResponse {
  try {
    return ok(svcListKBs())
  } catch (e) { return fail(e) }
}

export function listKBsForSpace(spaceId: string): ControllerResponse {
  try {
    return ok(svcListKBsForSpace(spaceId))
  } catch (e) { return fail(e) }
}

export function getKB(kbId: string): ControllerResponse {
  try {
    const kb = svcGetKB(kbId)
    return kb ? ok(kb) : { success: false, error: 'Knowledge base not found' }
  } catch (e) { return fail(e) }
}

export function updateKB(kbId: string, updates: UpdateKBInput): ControllerResponse {
  try {
    const kb = svcUpdateKB(kbId, updates)
    return kb ? ok(kb) : { success: false, error: 'Knowledge base not found' }
  } catch (e) { return fail(e) }
}

export async function deleteKB(kbId: string): Promise<ControllerResponse> {
  try {
    return ok(await svcDeleteKB(kbId))
  } catch (e) { return fail(e) }
}

export function setDefaultKB(kbId: string | null): ControllerResponse {
  try {
    return ok(svcSetDefaultKB(kbId))
  } catch (e) { return fail(e) }
}

export function bindToSpace(kbId: string, spaceId: string): ControllerResponse {
  try {
    return ok(svcBindToSpace(kbId, spaceId))
  } catch (e) { return fail(e) }
}

export function unbindFromSpace(kbId: string, spaceId: string): ControllerResponse {
  try {
    return ok(svcUnbindFromSpace(kbId, spaceId))
  } catch (e) { return fail(e) }
}

export function bindToApp(kbId: string, appId: string): ControllerResponse {
  try {
    return ok(svcBindToApp(kbId, appId))
  } catch (e) { return fail(e) }
}

export function unbindFromApp(kbId: string, appId: string): ControllerResponse {
  try {
    return ok(svcUnbindFromApp(kbId, appId))
  } catch (e) { return fail(e) }
}

export function addLinkedDir(
  kbId: string,
  dir: { path: string; label: string }
): ControllerResponse {
  try {
    const result = svcAddLinkedDir(kbId, dir)
    if (result.ok) return ok(result.linked)
    switch (result.reason) {
      case 'too-many-files':
        return {
          success: false,
          error: 'Linked folder contains too many files',
          code: 'TOO_MANY_FILES',
          data: { count: result.count, limit: result.limit },
        }
      case 'disk-root':
        return { success: false, error: 'Cannot watch a disk root', code: 'DISK_ROOT' }
      case 'folder-too-large':
        return { success: false, error: 'Linked folder is too large', code: 'FOLDER_TOO_LARGE' }
      case 'path-missing':
        return { success: false, error: 'Folder does not exist', code: 'PATH_NOT_FOUND' }
      case 'kb-not-found':
        return { success: false, error: 'Knowledge base not found', code: 'KB_NOT_FOUND' }
      default:
        return { success: false, error: 'Failed to add linked directory' }
    }
  } catch (e) { return fail(e) }
}

export function removeLinkedDir(kbId: string, linkId: string): ControllerResponse {
  try {
    return ok(svcRemoveLinkedDir(kbId, linkId))
  } catch (e) { return fail(e) }
}

export function addRawFiles(kbId: string, filePaths: string[]): ControllerResponse {
  try {
    return ok(svcAddRawFiles(kbId, filePaths))
  } catch (e) { return fail(e) }
}

export function listRawFiles(kbId: string): ControllerResponse {
  try {
    return ok(svcListRawFiles(kbId))
  } catch (e) { return fail(e) }
}

export function removeRawFile(kbId: string, relativePath: string): ControllerResponse {
  try {
    return ok(svcRemoveRawFile(kbId, relativePath))
  } catch (e) { return fail(e) }
}

export function readIndexMd(kbId: string): ControllerResponse {
  try {
    return ok(svcReadIndexMd(kbId) || '')
  } catch (e) { return fail(e) }
}

export async function triggerIngest(kbId: string): Promise<ControllerResponse> {
  try {
    // Fire-and-forget: processing runs serially in the background and pushes
    // progress events. Return immediately so the UI can show the running state.
    void svcTriggerFullIngest(kbId).catch(err =>
      console.error(`[Tlon] triggerIngest failed for ${kbId}:`, err)
    )
    return ok(true)
  } catch (e) { return fail(e) }
}

export function clearAndRelearn(kbId: string): ControllerResponse {
  try {
    if (svcIsIngesting(kbId)) {
      return { success: false, error: 'Learning is already in progress' }
    }
    // Fire-and-forget: clears the wiki then re-ingests; progress via events.
    void svcClearAndRelearn(kbId).catch(err =>
      console.error(`[Tlon] clearAndRelearn failed for ${kbId}:`, err)
    )
    return ok(true)
  } catch (e) { return fail(e) }
}

export function getIngestStatus(kbId: string): ControllerResponse {
  try {
    return ok(svcGetIngestProgress(kbId))
  } catch (e) { return fail(e) }
}

export function resolveSources(kbId: string, readPaths: string[]): ControllerResponse {
  try {
    return ok(svcResolveSources(kbId, readPaths))
  } catch (e) { return fail(e) }
}
