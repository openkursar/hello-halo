import { rawRpcMethod, type RpcResponse } from '../define'
import type {
  CcInstallation,
  CcInstallRequest,
  CcRuntimeConfig,
  CcRuntimeIssue,
  CcReleaseInfo,
  CcRuntimeStatus,
  CcScanResult,
} from '../../types/cc-runtime'

export interface CcRuntimeResponse<T = unknown> extends RpcResponse<T> {
  issue?: CcRuntimeIssue
}

export const ccRuntimeRpc = {
  ccRuntimeStatus: rawRpcMethod<[], CcRuntimeResponse<CcRuntimeStatus>>('cc-runtime:status'),
  ccRuntimeScan: rawRpcMethod<[], CcRuntimeResponse<CcScanResult>>('cc-runtime:scan'),
  ccRuntimeProbe: rawRpcMethod<[path: string], CcRuntimeResponse<CcInstallation>>('cc-runtime:probe'),
  ccRuntimeSelect: rawRpcMethod<[path: string], CcRuntimeResponse<CcRuntimeStatus>>('cc-runtime:select'),
  ccRuntimeLookup: rawRpcMethod<[request: CcInstallRequest], CcRuntimeResponse<CcReleaseInfo>>('cc-runtime:lookup'),
  ccRuntimeInstall: rawRpcMethod<[request: CcInstallRequest], CcRuntimeResponse<CcRuntimeStatus>>('cc-runtime:install'),
  ccRuntimeCancel: rawRpcMethod<[], CcRuntimeResponse<void>>('cc-runtime:cancel'),
  ccRuntimeConfigure: rawRpcMethod<[
    preferences: Pick<CcRuntimeConfig, 'sources' | 'sourceId' | 'installVersion'>
  ], CcRuntimeResponse<CcRuntimeStatus>>('cc-runtime:configure'),
  ccRuntimeBrowse: rawRpcMethod<[], CcRuntimeResponse<string | null>>('cc-runtime:browse'),
}
