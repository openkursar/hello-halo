import type { RpcClient } from '../../shared/rpc/define'
import type { ccRuntimeRpc } from '../../shared/rpc/contracts/cc-runtime.contract'
import { isElectron } from './transport'
import { ensureExtendedServicesReady } from './bootstrap-ready'

async function desktop<T>(operation: () => Promise<T>): Promise<T> {
  if (!isElectron()) throw new Error('Manage Claude Code in the desktop app hosting Halo')
  await ensureExtendedServicesReady()
  return operation()
}

export const ccRuntimeApi: RpcClient<typeof ccRuntimeRpc> = {
  ccRuntimeStatus: () => desktop(() => window.halo.ccRuntimeStatus()),
  ccRuntimeScan: () => desktop(() => window.halo.ccRuntimeScan()),
  ccRuntimeProbe: path => desktop(() => window.halo.ccRuntimeProbe(path)),
  ccRuntimeSelect: path => desktop(() => window.halo.ccRuntimeSelect(path)),
  ccRuntimeLookup: request => desktop(() => window.halo.ccRuntimeLookup(request)),
  ccRuntimeInstall: request => desktop(() => window.halo.ccRuntimeInstall(request)),
  ccRuntimeCancel: () => desktop(() => window.halo.ccRuntimeCancel()),
  ccRuntimeConfigure: preferences => desktop(() => window.halo.ccRuntimeConfigure(preferences)),
  ccRuntimeBrowse: () => desktop(() => window.halo.ccRuntimeBrowse()),
}
