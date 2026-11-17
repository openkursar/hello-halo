import type { CcInstallRequest, CcRuntimeStatus } from '../../shared/types/cc-runtime'
import type { CcRuntimeResponse } from '../../shared/rpc/contracts/cc-runtime.contract'
import {
  externalRuntimeResponse, installExternalRuntimeForUse, selectExternalRuntimeForUse,
} from './external-runtime.controller'

export async function ccRuntimeResponse<T>(activity: string, operation: () => T | Promise<T>): Promise<CcRuntimeResponse<T>> {
  const response = await externalRuntimeResponse(activity, operation)
  if (response.success) return response
  return { ...response, error: response.issue ? `cc-runtime:${response.issue}` : 'Claude Code operation failed' }
}

export function selectCcRuntimeForUse(path: string): Promise<CcRuntimeStatus> {
  return selectExternalRuntimeForUse('anthropic', path)
}

export function installCcRuntimeForUse(request: CcInstallRequest): Promise<CcRuntimeStatus> {
  return installExternalRuntimeForUse('anthropic', request)
}
