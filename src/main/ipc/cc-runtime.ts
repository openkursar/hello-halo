import type { OpenDialogOptions } from 'electron'
import { ccRuntimeRpc } from '../../shared/rpc/contracts/cc-runtime.contract'
import { showOpenDialog } from '../foundation/file-dialog'
import { getMainWindow } from '../foundation/window.service'
import { ccRuntimeResponse, installCcRuntimeForUse, selectCcRuntimeForUse } from '../controllers/cc-runtime.controller'
import {
  cancelCcInstall,
  configureCcRuntime,
  getCcRuntimeStatus,
  lookupCcRelease,
  probeCcInstallation,
  scanCcInstallations,
} from '../services/cc-runtime'
import { registerRawRpcHandlers } from './rpc'

export function registerCcRuntimeHandlers(): void {
  registerRawRpcHandlers(ccRuntimeRpc, {
    ccRuntimeStatus: () => ccRuntimeResponse('Read settings', getCcRuntimeStatus),
    ccRuntimeScan: () => ccRuntimeResponse('Find installations', scanCcInstallations),
    ccRuntimeProbe: path => ccRuntimeResponse('Check installation', () => probeCcInstallation(path)),
    ccRuntimeSelect: path => ccRuntimeResponse('Select installation', () => selectCcRuntimeForUse(path)),
    ccRuntimeLookup: request => ccRuntimeResponse('Check release', () => lookupCcRelease(request)),
    ccRuntimeInstall: request => ccRuntimeResponse('Install release', () => installCcRuntimeForUse(request)),
    ccRuntimeCancel: () => ccRuntimeResponse('Cancel installation', () => { cancelCcInstall() }),
    ccRuntimeConfigure: preferences => ccRuntimeResponse('Save source', () => configureCcRuntime(preferences)),
    ccRuntimeBrowse: () => ccRuntimeResponse('Choose installation', async () => {
      const options: OpenDialogOptions = {
        properties: process.platform === 'darwin'
          ? ['openFile', 'openDirectory', 'showHiddenFiles']
          : ['openDirectory', 'showHiddenFiles'],
      }
      const window = getMainWindow()
      const result = window && !window.isDestroyed()
        ? await showOpenDialog(window, options)
        : await showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    }),
  })
}
