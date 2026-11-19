import { rpcMethod } from '../define'
import type {
  CliExternalPick, CliPackagePreviewView, CliRegisterExternalInput, CliToolsOverview, CliToolsResult,
} from '../../types/cli-tools'

/**
 * Local command-line tool management. Every action answers a
 * `CliToolsResult`, so a refusal arrives as a code the renderer localizes,
 * not as an exception string. The two pickers open a native file dialog and
 * are desktop-only.
 */
export const cliToolsRpc = {
  cliToolsOverview: rpcMethod<[], CliToolsOverview>('cli-tools:overview'),
  cliToolsSetCurrent: rpcMethod<[input: { id: string; version: string }], CliToolsResult<CliToolsOverview>>('cli-tools:set-current'),
  cliToolsSetDisabled: rpcMethod<[input: { id: string; disabled: boolean }], CliToolsResult<CliToolsOverview>>('cli-tools:set-disabled'),
  cliToolsRemoveVersion: rpcMethod<[input: { id: string; version: string }], CliToolsResult<CliToolsOverview>>('cli-tools:remove-version'),
  cliToolsRemoveTool: rpcMethod<[input: { id: string }], CliToolsResult<CliToolsOverview>>('cli-tools:remove-tool'),
  cliToolsPickPackage: rpcMethod<[], CliToolsResult<CliPackagePreviewView | null>>('cli-tools:pick-package'),
  cliToolsConfirmImport: rpcMethod<[input: { previewId: string; makeCurrent: boolean }], CliToolsResult<CliToolsOverview>>('cli-tools:confirm-import'),
  cliToolsCancelImport: rpcMethod<[input: { previewId: string }], void>('cli-tools:cancel-import'),
  cliToolsPickExternal: rpcMethod<[], CliToolsResult<CliExternalPick | null>>('cli-tools:pick-external'),
  cliToolsRegisterExternal: rpcMethod<[input: CliRegisterExternalInput], CliToolsResult<CliToolsOverview>>('cli-tools:register-external'),
  cliToolsReconfirmExternal: rpcMethod<[input: { id: string }], CliToolsResult<CliToolsOverview>>('cli-tools:reconfirm-external'),
}
