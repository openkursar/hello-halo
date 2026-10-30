import type { CcRuntimeResponse } from '../../../../shared/rpc/contracts/cc-runtime.contract'
import type { CcRuntimeIssue } from '../../../../shared/types/cc-runtime'

export class CcSettingsError extends Error {
  constructor(readonly issue?: CcRuntimeIssue) { super(issue ?? 'cc-settings-unavailable') }
}

export function ccResult<T>(response: CcRuntimeResponse<T>): T {
  if (!response.success) throw new CcSettingsError(response.issue)
  return response.data as T
}

export function ccIssue(error: unknown): CcRuntimeIssue | undefined {
  return error instanceof CcSettingsError ? error.issue : undefined
}
