import type { OpenDialogOptions } from 'electron'
import { externalRuntimeRpc } from '../../shared/rpc/contracts/external-runtime.contract'
import {
  assertRuntimeId, externalRuntimeResponse, installExternalRuntimeForUse,
  recordExternalRuntimeIntent, selectExternalRuntimeForUse,
} from '../controllers/external-runtime.controller'
import { showOpenDialog } from '../foundation/file-dialog'
import { getMainWindow } from '../foundation/window.service'
import {
  cancelExternalRuntime, configureExternalRuntime, getExternalRuntimeStatus,
  lookupExternalRuntime, probeExternalRuntime, scanExternalRuntime,
} from '../services/external-runtime'
import { registerRawRpcHandlers } from './rpc'

export function registerExternalRuntimeHandlers(): void {
  registerRawRpcHandlers(externalRuntimeRpc, {
    getExternalRuntimeStatus: runtimeId => externalRuntimeResponse('Read settings', () => getExternalRuntimeStatus(runtimeId)),
    scanExternalRuntime: runtimeId => externalRuntimeResponse('Find installations', () => scanExternalRuntime(runtimeId)),
    probeExternalRuntime: (runtimeId, path) => externalRuntimeResponse('Check installation', () => probeExternalRuntime(runtimeId, path)),
    selectExternalRuntime: (runtimeId, path) => externalRuntimeResponse('Select installation', () => selectExternalRuntimeForUse(runtimeId, path)),
    lookupExternalRuntime: (runtimeId, request) => externalRuntimeResponse('Check release', () => lookupExternalRuntime(runtimeId, request)),
    installExternalRuntime: (runtimeId, request) => externalRuntimeResponse('Install release', () => installExternalRuntimeForUse(runtimeId, request)),
    cancelExternalRuntime: runtimeId => externalRuntimeResponse('Cancel installation', () => { cancelExternalRuntime(runtimeId) }),
    configureExternalRuntime: (runtimeId, preferences) => externalRuntimeResponse('Save source', () => configureExternalRuntime(runtimeId, preferences)),
    browseExternalRuntime: runtimeId => externalRuntimeResponse('Choose installation', async () => {
      assertRuntimeId(runtimeId)
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
    recordExternalRuntimeIntent: runtimeId => externalRuntimeResponse('Record engine choice', () => recordExternalRuntimeIntent(runtimeId)),
  })
}
