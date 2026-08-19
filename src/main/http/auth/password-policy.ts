/**
 * Main-side wrapper around the shared password policy.
 *
 * The rules themselves live in `src/shared/auth/password-policy.ts` so
 * the renderer can run identical preflight checks; this module's only
 * job is to map structural codes to the English messages used by the
 * HTTP/IPC error envelope and the audit log.
 */

import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  checkPasswordPolicy,
  type PasswordPolicyCode,
} from '../../../shared/auth/password-policy'

export interface PasswordPolicyResult {
  ok: boolean
  error?: string
}

const TERMINAL_MESSAGES: Record<'NOT_A_STRING' | 'TOO_SHORT' | 'TOO_LONG', string> = {
  NOT_A_STRING: 'Password must be a string',
  TOO_SHORT: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  TOO_LONG: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
}

const CLASS_FRAGMENTS: Record<
  'MISSING_UPPER' | 'MISSING_LOWER' | 'MISSING_DIGIT',
  string
> = {
  MISSING_UPPER: 'uppercase letter',
  MISSING_LOWER: 'lowercase letter',
  MISSING_DIGIT: 'digit',
}

function isTerminal(code: PasswordPolicyCode): code is keyof typeof TERMINAL_MESSAGES {
  return code === 'NOT_A_STRING' || code === 'TOO_SHORT' || code === 'TOO_LONG'
}

export function validatePassword(password: string): PasswordPolicyResult {
  const result = checkPasswordPolicy(password)
  if (result.ok) return { ok: true }

  const [first] = result.codes
  if (isTerminal(first)) {
    return { ok: false, error: TERMINAL_MESSAGES[first] }
  }

  const missing = result.codes
    .filter((c): c is keyof typeof CLASS_FRAGMENTS => c in CLASS_FRAGMENTS)
    .map((c) => CLASS_FRAGMENTS[c])
  return { ok: false, error: `Password must include: ${missing.join(', ')}` }
}
