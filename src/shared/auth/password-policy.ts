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

/**
 * Shortest credential any surface accepts for a login attempt. The
 * auto-generated PIN is 12 chars and custom passwords are ≥ 8, so 8 is
 * the single floor both credential kinds can hit — any submission below
 * it can never succeed and is rejected client-side without a round trip.
 */
export const ACCESS_CODE_MIN_SUBMIT_LENGTH = PASSWORD_MIN_LENGTH

/**
 * Trim-and-cap input normalization shared by every access-code entry
 * surface. Auto PINs include printable ASCII specials, so — unlike a
 * legacy alphanumeric PIN — symbols must survive: only whitespace is
 * stripped (paste artifacts), never characters.
 */
export function normalizeAccessCodeInput(raw: string): string {
  return raw.replace(/\s+/g, '').slice(0, PASSWORD_MAX_LENGTH)
}

/**
 * Whether an entry surface may enable its submit action for this input.
 * A cheap length floor; the server still runs the full timing-safe
 * comparison, so this gates UX only, never authorization.
 */
export function isAccessCodeSubmittable(code: string): boolean {
  return code.length >= ACCESS_CODE_MIN_SUBMIT_LENGTH
}
