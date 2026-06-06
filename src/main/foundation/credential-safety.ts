/**
 * Credential-at-rest safety gate — foundation tier.
 *
 * Reads the `credentialAtRestSafe` flag from product.json (`security` block)
 * to decide whether persisted credentials are encrypted at rest. Lives in
 * foundation (not in `services/security-policy.ts`) so the at-rest crypto
 * primitive (`crypto-envelope.ts`) can consult it without depending on the
 * express-coupled security-policy domain module.
 *
 * `security-policy.ts` re-exports this predicate so its public surface and
 * documentation stay intact.
 */

import { loadProductConfig } from './product-config'

/**
 * True only when `security.credentialAtRestSafe` is explicitly boolean true.
 *
 * Consumers MUST treat this as a one-way gate: when false, the credential
 * persistence layer takes the standard path (plain string stored in
 * config). When true, the GM/T path is taken: HKDF-SHA-256 over a
 * machine-bound seed derives an SM4-CBC encryption key and an HMAC-SM3
 * MAC key (encrypt-then-MAC); see `crypto-envelope.ts`. Any non-boolean
 * truthy value is treated as false to prevent accidental enablement via
 * config typos.
 */
export function isCredentialAtRestSafe(): boolean {
  const security = loadProductConfig().security as { credentialAtRestSafe?: unknown } | undefined
  return security?.credentialAtRestSafe === true
}
