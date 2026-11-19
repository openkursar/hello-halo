import { cliToolsRpc } from '../../shared/rpc/contracts/cli-tools.contract'
import * as cliTools from '../controllers/cli-tools.controller'
import { registerRpcHandlers } from './rpc'

export function registerCliToolsHandlers(): void {
  registerRpcHandlers(
    cliToolsRpc,
    {
      cliToolsOverview: () => cliTools.overview(),
      cliToolsSetCurrent: input => cliTools.setCurrent(input),
      cliToolsSetDisabled: input => cliTools.setDisabled(input),
      cliToolsRemoveVersion: input => cliTools.removeVersion(input),
      cliToolsRemoveTool: input => cliTools.removeTool(input),
      cliToolsPickPackage: () => cliTools.pickPackage(),
      cliToolsConfirmImport: input => cliTools.confirmImport(input),
      cliToolsCancelImport: input => cliTools.cancelImport(input),
      cliToolsPickExternal: () => cliTools.pickExternal(),
      cliToolsRegisterExternal: input => cliTools.registerExternal(input),
      cliToolsReconfirmExternal: input => cliTools.reconfirmExternal(input),
    },
    'CliTools',
  )
}
