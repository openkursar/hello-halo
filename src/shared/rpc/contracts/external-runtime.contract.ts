import { rawRpcMethod, type RpcResponse } from '../define'
import type {
  RuntimeId, RuntimeInstallation, RuntimeInstallRequest, RuntimeIssue,
  RuntimePreferences, RuntimeReleaseInfo, RuntimeScanResult, RuntimeStatus,
} from '../../types/external-runtime'

export interface ExternalRuntimeResponse<T = unknown> extends RpcResponse<T> {
  issue?: RuntimeIssue
}

export const externalRuntimeRpc = {
  getExternalRuntimeStatus: rawRpcMethod<[runtimeId: RuntimeId], ExternalRuntimeResponse<RuntimeStatus>>('external-runtime:status'),
  scanExternalRuntime: rawRpcMethod<[runtimeId: RuntimeId], ExternalRuntimeResponse<RuntimeScanResult>>('external-runtime:scan'),
  probeExternalRuntime: rawRpcMethod<[runtimeId: RuntimeId, path: string], ExternalRuntimeResponse<RuntimeInstallation>>('external-runtime:probe'),
  selectExternalRuntime: rawRpcMethod<[runtimeId: RuntimeId, path: string], ExternalRuntimeResponse<RuntimeStatus>>('external-runtime:select'),
  lookupExternalRuntime: rawRpcMethod<[runtimeId: RuntimeId, request: RuntimeInstallRequest], ExternalRuntimeResponse<RuntimeReleaseInfo>>('external-runtime:lookup'),
  installExternalRuntime: rawRpcMethod<[runtimeId: RuntimeId, request: RuntimeInstallRequest], ExternalRuntimeResponse<RuntimeStatus>>('external-runtime:install'),
  cancelExternalRuntime: rawRpcMethod<[runtimeId: RuntimeId], ExternalRuntimeResponse<void>>('external-runtime:cancel'),
  configureExternalRuntime: rawRpcMethod<[runtimeId: RuntimeId, preferences: RuntimePreferences], ExternalRuntimeResponse<RuntimeStatus>>('external-runtime:configure'),
  browseExternalRuntime: rawRpcMethod<[runtimeId: RuntimeId], ExternalRuntimeResponse<string | null>>('external-runtime:browse'),
  recordExternalRuntimeIntent: rawRpcMethod<[runtimeId: RuntimeId], ExternalRuntimeResponse<void>>('external-runtime:intent'),
}
