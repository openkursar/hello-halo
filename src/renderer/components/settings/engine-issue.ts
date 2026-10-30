import type { EngineId } from '../../../shared/types/engine'

export type EngineIssue = 'account-needs-cc' | 'account-cc-ready' | 'codex-account' | 'cc-missing'

/**
 * Why a conversation cannot run as configured. `ccAvailable` is undefined
 * until it is known; an account that needs Claude Code is reported meanwhile.
 */
export function resolveEngineIssue(input: { engine: EngineId; delegated: boolean; accountCompatible: boolean; ccAvailable?: boolean }): EngineIssue | null {
  if (input.delegated) {
    if (input.engine === 'anthropic') return input.ccAvailable === false ? 'account-needs-cc' : null
    return input.ccAvailable ? 'account-cc-ready' : 'account-needs-cc'
  }
  if (!input.accountCompatible) return 'codex-account'
  return input.engine === 'anthropic' && input.ccAvailable === false ? 'cc-missing' : null
}

export type EngineNotice = { kind: 'issue'; issue: EngineIssue } | { kind: 'failure' } | { kind: 'fell-back' }

/**
 * Which note the chat shows. A turn that failed for its engine always gets
 * one, even when no specific way out is known, so the failure is never left
 * pointing at nothing.
 */
export function resolveEngineNotice(input: { issue: EngineIssue | null; failed: boolean; fellBack: boolean; dismissed: boolean }): EngineNotice | null {
  if (input.issue) return { kind: 'issue', issue: input.issue }
  if (input.failed) return { kind: 'failure' }
  return input.fellBack && !input.dismissed ? { kind: 'fell-back' } : null
}
