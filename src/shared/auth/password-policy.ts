/**
 * Shared remote-access password policy.
 *
 * Lives in `shared/` so the main process (write-side enforcement,
 * structured HTTP errors, audit) and the renderer (instant client-side
 * feedback with localized messages) consume the exact same rules from
 * a single source. The structural check is text-free — callers map the
 * returned discriminants to either an English message (main) or a
 * translated string (renderer).
 *
 * Auto-generated PINs and credentials restored from disk are intentionally
 * NOT validated by this module; the policy gates human-chosen passwords
 * at the write boundary only.
 */

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 64

/**
 * Reasons a password can fail the policy. Length failures are returned
 * alone because they are terminal — until the password is long enough,
 * class coverage cannot be evaluated meaningfully. Class failures are
 * aggregated so the UI can list everything still missing in one pass.
 *
 * A special character is allowed but intentionally NOT required: this
 * credential is primarily typed on mobile, where symbols force a keyboard
 * switch and some Android password fields block pasting them. Length plus
 * upper/lower/digit keeps the strength adequate for an HTTPS-guarded PIN.
 */
export type PasswordPolicyCode =
  | 'NOT_A_STRING'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'MISSING_UPPER'
  | 'MISSING_LOWER'
  | 'MISSING_DIGIT'

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; codes: PasswordPolicyCode[] }

export function checkPasswordPolicy(password: unknown): PasswordPolicyResult {
  if (typeof password !== 'string') return { ok: false, codes: ['NOT_A_STRING'] }
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, codes: ['TOO_SHORT'] }
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, codes: ['TOO_LONG'] }

  const codes: PasswordPolicyCode[] = []
  if (!/[A-Z]/.test(password)) codes.push('MISSING_UPPER')
  if (!/[a-z]/.test(password)) codes.push('MISSING_LOWER')
  if (!/[0-9]/.test(password)) codes.push('MISSING_DIGIT')

  if (codes.length > 0) return { ok: false, codes }
  return { ok: true }
}
