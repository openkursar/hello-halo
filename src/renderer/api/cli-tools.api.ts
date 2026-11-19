import type { RpcClient } from '../../shared/rpc/define'
import type { cliToolsRpc } from '../../shared/rpc/contracts/cli-tools.contract'
import { httpRequest, isElectron } from './_shared'
import { ensureExtendedServicesReady } from './bootstrap-ready'

async function desktop<T>(operation: () => Promise<T>): Promise<T> {
  await ensureExtendedServicesReady()
  return operation()
}

export const cliToolsApi: RpcClient<typeof cliToolsRpc> = {
  cliToolsOverview: () => isElectron() ? desktop(() => window.halo.cliToolsOverview()) : httpRequest('POST', '/api/cli-tools/overview', {}),
  cliToolsSetCurrent: input => isElectron() ? desktop(() => window.halo.cliToolsSetCurrent(input)) : httpRequest('POST', '/api/cli-tools/set-current', { ...input }),
  cliToolsSetDisabled: input => isElectron() ? desktop(() => window.halo.cliToolsSetDisabled(input)) : httpRequest('POST', '/api/cli-tools/set-disabled', { ...input }),
  cliToolsRemoveVersion: input => isElectron() ? desktop(() => window.halo.cliToolsRemoveVersion(input)) : httpRequest('POST', '/api/cli-tools/remove-version', { ...input }),
  cliToolsRemoveTool: input => isElectron() ? desktop(() => window.halo.cliToolsRemoveTool(input)) : httpRequest('POST', '/api/cli-tools/remove-tool', { ...input }),
  cliToolsPickPackage: () => isElectron() ? desktop(() => window.halo.cliToolsPickPackage()) : httpRequest('POST', '/api/cli-tools/pick-package', {}),
  cliToolsConfirmImport: input => isElectron() ? desktop(() => window.halo.cliToolsConfirmImport(input)) : httpRequest('POST', '/api/cli-tools/confirm-import', { ...input }),
  cliToolsCancelImport: input => isElectron() ? desktop(() => window.halo.cliToolsCancelImport(input)) : httpRequest('POST', '/api/cli-tools/cancel-import', { ...input }),
  cliToolsPickExternal: () => isElectron() ? desktop(() => window.halo.cliToolsPickExternal()) : httpRequest('POST', '/api/cli-tools/pick-external', {}),
  cliToolsRegisterExternal: input => isElectron() ? desktop(() => window.halo.cliToolsRegisterExternal(input)) : httpRequest('POST', '/api/cli-tools/register-external', { ...input }),
  cliToolsReconfirmExternal: input => isElectron() ? desktop(() => window.halo.cliToolsReconfirmExternal(input)) : httpRequest('POST', '/api/cli-tools/reconfirm-external', { ...input }),
}
