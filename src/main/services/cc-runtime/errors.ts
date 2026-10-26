import type { CcRuntimeIssue } from '../../../shared/types/cc-runtime'

export class CcRuntimeError extends Error {
  constructor(readonly code: CcRuntimeIssue, options?: ErrorOptions) {
    super(`cc-runtime:${code}`, options)
    this.name = 'CcRuntimeError'
  }
}

export function issueFromError(error: unknown, fallback: CcRuntimeIssue): CcRuntimeIssue {
  return error instanceof CcRuntimeError ? error.code : fallback
}
