import type { ExternalRuntimeResponse as CcRuntimeResponse } from '../../../../shared/rpc/contracts/external-runtime.contract'
import type { RuntimeIssue as CcRuntimeIssue } from '../../../../shared/types/external-runtime'

export class CcSettingsError extends Error {
  constructor(readonly issue?: CcRuntimeIssue) { super(issue ?? 'cc-settings-unavailable') }
}

export function ccResult<T>(response: CcRuntimeResponse<T>): T {
  if (!response.success) throw new CcSettingsError(response.issue)
  return response.data as T
}

export function ccIssue(error: unknown): CcRuntimeIssue | undefined {
  if (error instanceof CcSettingsError) return error.issue
  console.warn('[ExternalRuntimeSettings] Request failed', { name: error instanceof Error ? error.name : 'UnknownError' })
  return undefined
}
