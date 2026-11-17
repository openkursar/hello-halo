import type { RpcClient } from '../../shared/rpc/define'
import type { externalRuntimeRpc } from '../../shared/rpc/contracts/external-runtime.contract'
import { isElectron } from './transport'
import { ensureExtendedServicesReady } from './bootstrap-ready'

async function desktop<T>(operation: () => Promise<T>): Promise<T> {
  if (!isElectron()) throw new Error('Manage external runtimes in the desktop app hosting Halo')
  await ensureExtendedServicesReady()
  return operation()
}

export const externalRuntimeApi: RpcClient<typeof externalRuntimeRpc> = {
  getExternalRuntimeStatus: runtimeId => desktop(() => window.halo.getExternalRuntimeStatus(runtimeId)),
  scanExternalRuntime: runtimeId => desktop(() => window.halo.scanExternalRuntime(runtimeId)),
  probeExternalRuntime: (runtimeId, path) => desktop(() => window.halo.probeExternalRuntime(runtimeId, path)),
  selectExternalRuntime: (runtimeId, path) => desktop(() => window.halo.selectExternalRuntime(runtimeId, path)),
  lookupExternalRuntime: (runtimeId, request) => desktop(() => window.halo.lookupExternalRuntime(runtimeId, request)),
  installExternalRuntime: (runtimeId, request) => desktop(() => window.halo.installExternalRuntime(runtimeId, request)),
  cancelExternalRuntime: runtimeId => desktop(() => window.halo.cancelExternalRuntime(runtimeId)),
  configureExternalRuntime: (runtimeId, preferences) => desktop(() => window.halo.configureExternalRuntime(runtimeId, preferences)),
  browseExternalRuntime: runtimeId => desktop(() => window.halo.browseExternalRuntime(runtimeId)),
  recordExternalRuntimeIntent: runtimeId => desktop(() => window.halo.recordExternalRuntimeIntent(runtimeId)),
}
