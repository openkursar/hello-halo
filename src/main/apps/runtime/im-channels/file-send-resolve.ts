/**
 * apps/runtime/im-channels -- File-send capability resolution
 *
 * Binds a channel instance's file capability to ONE chat, behind the export
 * gate. The result is what `createFileSendMcpServer` turns into a tool.
 *
 * Why this is a module and not a local helper: a chat can be served by more
 * than one dispatch path (the inbound message, and a later runtime-woken turn
 * of the same digital human). Those turns share a session, and a session is
 * rebuilt whenever its tool set changes — so a path that resolves this
 * differently from another does not merely lose file sending, it destroys the
 * turn that is starting. One implementation, one answer, for every path.
 */

import { tmpdir } from 'os'
import { FileExportGate } from '../file-export-gate'
import { getActiveImChannelManager } from './index'
import type { FileSendFn } from './file-send-mcp'

/**
 * Resolve the file-send function for one chat, or undefined when the channel
 * cannot send files (text-only provider, manager not initialized, or the
 * instance is no longer registered).
 *
 * The returned closure runs every path through {@link FileExportGate} first, so
 * an AI-initiated send cannot reach outside the sandbox.
 *
 * @param spaceDir - The digital human's working directory. Together with tmpdir
 *   it bounds what may leave the machine; it is where attachments and
 *   AI-produced files actually live (see `getSpaceDir`, which is deliberately
 *   not `space.path`).
 */
export function resolveImFileSend(params: {
  instanceId: string
  chatId: string
  chatType: 'direct' | 'group'
  spaceDir: string
}): FileSendFn | undefined {
  const instance = getActiveImChannelManager()?.getInstance(params.instanceId)
  if (!instance?.fileCapability) return undefined

  const exportGate = new FileExportGate([params.spaceDir, tmpdir()])
  return (filePath: string, filename?: string) => {
    const sanctioned = exportGate.sanction(filePath)
    // An explicit filename from the caller overrides the on-disk name.
    const file = filename ? { ...sanctioned, displayName: filename } : sanctioned
    return instance.fileCapability!.sendFile(params.chatId, file, params.chatType)
  }
}
