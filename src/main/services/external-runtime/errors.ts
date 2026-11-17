import type { RuntimeIssue } from '../../../shared/types/external-runtime';
export class RuntimeError extends Error {
  constructor(public readonly code: RuntimeIssue, options?: ErrorOptions) {
    super(code, options);
    this.name = 'RuntimeError';
  }
}
export { RuntimeError as CcRuntimeError };
export function issueFromError(error: unknown, fallback: RuntimeIssue): RuntimeIssue {
  return error instanceof RuntimeError ? error.code : fallback;
}
