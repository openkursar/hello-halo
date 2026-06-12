/**
 * Tlon (knowledge base) IPC handlers — typed-RPC registration.
 *
 * All channels delegate to tlon.controller (shared with HTTP routes), returning
 * its `{ success, data | error }` envelope verbatim (passthrough contract). The
 * file/folder pickers open the OS dialog here so the renderer never touches the
 * local filesystem directly.
 */

import { dialog } from 'electron'
import * as tlonController from '../controllers/tlon.controller'
import type { CreateKBInput, UpdateKBInput } from '../../shared/types/tlon'
import { tlonRpc } from '../../shared/rpc/contracts/tlon.contract'
import { registerRawRpcHandlers } from './rpc'

export function registerTlonHandlers(): void {
  registerRawRpcHandlers(tlonRpc, {
    tlonCreate: async (input: CreateKBInput) => tlonController.createKB(input),
    tlonList: async () => tlonController.listKBs(),
    tlonListForSpace: async (spaceId: string) => tlonController.listKBsForSpace(spaceId),
    tlonGet: async (kbId: string) => tlonController.getKB(kbId),
    tlonUpdate: async (kbId: string, updates: UpdateKBInput) => tlonController.updateKB(kbId, updates),
    tlonDelete: async (kbId: string) => tlonController.deleteKB(kbId),
    tlonSetDefault: async (kbId: string | null) => tlonController.setDefaultKB(kbId),
    tlonBindSpace: async (kbId: string, spaceId: string) => tlonController.bindToSpace(kbId, spaceId),
    tlonUnbindSpace: async (kbId: string, spaceId: string) => tlonController.unbindFromSpace(kbId, spaceId),
    tlonBindApp: async (kbId: string, appId: string) => tlonController.bindToApp(kbId, appId),
    tlonUnbindApp: async (kbId: string, appId: string) => tlonController.unbindFromApp(kbId, appId),
    tlonAddLinkedDir: async (kbId: string, dir: { path: string; label: string }) => tlonController.addLinkedDir(kbId, dir),
    tlonRemoveLinkedDir: async (kbId: string, linkId: string) => tlonController.removeLinkedDir(kbId, linkId),
    tlonAddFiles: async (kbId: string, filePaths: string[]) => tlonController.addRawFiles(kbId, filePaths),
    tlonListRaw: async (kbId: string) => tlonController.listRawFiles(kbId),
    tlonRemoveRaw: async (kbId: string, relativePath: string) => tlonController.removeRawFile(kbId, relativePath),
    tlonListWiki: async (kbId: string) => tlonController.listWikiPages(kbId),
    tlonReadWiki: async (kbId: string, pagePath: string) => tlonController.readWikiPage(kbId, pagePath),
    tlonReadIndex: async (kbId: string) => tlonController.readIndexMd(kbId),
    tlonTriggerIngest: async (kbId: string) => tlonController.triggerIngest(kbId),
    tlonClearRelearn: async (kbId: string) => tlonController.clearAndRelearn(kbId),
    tlonGetIngestStatus: async (kbId: string) => tlonController.getIngestStatus(kbId),

    // Pickers open the OS dialog directly (renderer has no filesystem access).
    tlonPickFiles: async () => {
      try {
        const result = await dialog.showOpenDialog({
          title: 'Add files to knowledge base',
          properties: ['openFile', 'multiSelections'],
          buttonLabel: 'Add',
        })
        return { success: true, data: { filePaths: result.filePaths, canceled: result.canceled } }
      } catch (error: unknown) {
        return { success: false, error: (error as Error).message }
      }
    },
    tlonPickFolder: async (options?: { title?: string; buttonLabel?: string }) => {
      try {
        const result = await dialog.showOpenDialog({
          title: options?.title || 'Link a folder to watch',
          properties: ['openDirectory'],
          buttonLabel: options?.buttonLabel || 'Link',
        })
        return { success: true, data: { filePaths: result.filePaths, canceled: result.canceled } }
      } catch (error: unknown) {
        return { success: false, error: (error as Error).message }
      }
    },
  })
}
