/**
 * IPC for the HTML preview origin (see foundation/protocol.service).
 */

import { app } from 'electron'
import { homedir } from 'os'
import { isAbsolute } from 'path'
import { getHaloDir } from '../foundation/config.service'
import { canvasPreviewRpc } from '../../shared/rpc/contracts/canvas-preview.contract'
import { closePreview, openPreview } from '../foundation/protocol.service'
import { registerRpcHandlers } from './rpc'

export function registerCanvasPreviewHandlers(): void {
  registerRpcHandlers(
    canvasPreviewRpc,
    {
      openHtmlPreview: (filePath) => {
        if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw new Error('An absolute file path is required')
        // Places whose contents a previewed page must never be able to reach.
        return openPreview(filePath, [homedir(), getHaloDir(), app.getPath('userData')])
      },
      closeHtmlPreview: (host) => {
        if (typeof host === 'string') closePreview(host)
      },
    },
    'CanvasPreview'
  )
}
