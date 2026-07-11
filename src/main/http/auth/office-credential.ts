/**
 * Office-member credential — a signed, opaque token the host issues into an
 * invite link and verifies when presented. It runs as a parallel credential
 * system to the remote-control PIN; the two are independent (revoking one
 * never affects the other).
 *
 * Currently the creator/host is the fixed authority, so issuer == verifier ==
 * host: both signing and verification use the host's Ed25519 identity key
 * (reused from http/identity — there is exactly one node key store).
 *
 * Token wire format: `halo-office.<base64url(claimsJson)>.<base64url(signature)>`.
 * A fixed magic prefix (OFFICE_TOKEN_PREFIX) — not the mere presence of a '.' —
 * is the routing hint parseCredentialType() relies on: a user's custom
 * remote-control password may legitimately contain a '.', and classifying by a
 * bare '.' would misroute it to the office branch and lock the user out forever.
 *
 * Validity is fail-closed: a token is accepted ONLY when the signature
 * verifies, the type is right, it is unexpired, AND the revocation-ledger
 * record exists and is not revoked. An unknown jti (forged, or revoked by
 * deletion) is treated as invalid.
 */

import { createPublicKey, randomUUID, verify } from 'crypto'

import { getLocalPublicKeyPem, signWithLocalKey } from '../identity/index'
import { getFederationStore, DEFAULT_OFFICE_SCOPE } from '../../apps/federation/index'
import type { OfficeScope, OfficeCredentialRecord } from '../../apps/federation/index'

const LOG_TAG = '[OfficeCred]'

/**
 * Skew applied when judging a ledger credential still reusable: a credential
 * within this window of expiry is treated as expired so a reused invite never
 * hands out a link about to die mid-use. Mirrors the invite controller's reuse
 * skew so the in-memory and ledger-backed reuse paths agree.
 */
const REUSE_EXPIRY_SKEW_MS = 60_000

/** Magic prefix marking an office-credential token (see file header for why). */
const OFFICE_TOKEN_PREFIX = 'halo-office.'

export type CredentialType = 'remote-control' | 'office-member'

export interface OfficeCredentialClaims {
  type: 'office-member'
  officeId: string
  identity: string
  scope: OfficeScope
  /** Expiry epoch ms; absent = no expiry. */
  exp?: number
  /** Unique id for independent revocation via the federation ledger. */
  jti: string
}

export type OfficeCredential = OfficeCredentialClaims

interface IssueInput {
  officeId: string
  identity: string
  scope?: OfficeScope
  ttlMs?: number
  /** Reserved for one-time invites; the ledger record carries enough state. */
  oneTime?: boolean
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64url')
}

/** True when two scope overlays are field-for-field equal. */
function scopeEquals(a: OfficeScope, b: OfficeScope): boolean {
  return (
    a.visibility === b.visibility &&
    a.contactable === b.contactable &&
    a.discoverable === b.discoverable &&
    a.canReinvite === b.canReinvite
  )
}

/**
 * Reject a scope whose fields fall outside the closed enum/boolean domain. The
 * scope crosses the issuance boundary (it can arrive from the renderer via IPC),
 * so each field is validated before it is signed into a credential — an invalid
 * overlay must never be persisted or enforced.
 */
function isValidScope(scope: OfficeScope): boolean {
  return (
    (scope.visibility === 'full' || scope.visibility === 'assigned' || scope.visibility === 'readonly') &&
    (scope.contactable === 'all' || scope.contactable === 'lead-only') &&
    typeof scope.discoverable === 'boolean' &&
    typeof scope.canReinvite === 'boolean'
  )
}

/**
 * Assemble the signed token string from a fully-formed claims object. Field
 * order here is the canonical signing order — reissue must rebuild claims in
 * this same order for the signed bytes to match exactly.
 */
function buildTokenFromClaims(claims: OfficeCredentialClaims): string {
  const claimsBytes = Buffer.from(JSON.stringify(claims), 'utf8')
  const signature = signWithLocalKey(claimsBytes)
  return `${OFFICE_TOKEN_PREFIX}${toBase64Url(claimsBytes)}.${toBase64Url(signature)}`
}

/**
 * Build the canonical claims object. `exp` is OMITTED when null/undefined (never
 * serialized as `exp: null`) so a no-expiry credential reproduces the exact bytes
 * whether the source is the issue-time `number | undefined` or the ledger's
 * `number | null`.
 */
function buildClaims(args: {
  officeId: string
  identity: string
  scope: OfficeScope
  exp: number | null | undefined
  jti: string
}): OfficeCredentialClaims {
  return {
    type: 'office-member',
    officeId: args.officeId,
    identity: args.identity,
    scope: args.scope,
    ...(args.exp != null ? { exp: args.exp } : {}),
    jti: args.jti,
  }
}

/**
 * Issue an office-member credential and persist it to the revocation ledger.
 * The returned token embeds the signed claims; the jti is also returned so the
 * caller can later revoke it.
 */
export function issueOfficeCredential(input: IssueInput): { token: string; jti: string } {
  const jti = randomUUID()
  const scope = input.scope ?? DEFAULT_OFFICE_SCOPE
  if (!isValidScope(scope)) {
    throw new Error('OFFICE_SCOPE_INVALID')
  }
  // Narrow scopes are issuable: the joiner's identity is proven at the WS auth
  // handshake (device-key challenge–response), the invite's scope overlay is
  // persisted on each admitted member row at join, and the authority-side scope
  // gate enforces it against the AUTHENTICATED fromNode — so a narrow invite
  // yields a working, enforced narrow membership rather than a dead link.
  const exp = input.ttlMs ? Date.now() + input.ttlMs : undefined

  const claims = buildClaims({ officeId: input.officeId, identity: input.identity, scope, exp, jti })
  const token = buildTokenFromClaims(claims)

  const store = getFederationStore()
  if (!store) {
    // Fail-HARD: without a ledger record, verifyOfficeCredential() can never accept
    // this token (existence in the ledger is required), so handing it back would
    // mint a permanently-dead invite and silently mislead the caller. Throw instead
    // so the issuance path surfaces the unavailable store rather than emitting a
    // token that looks valid but is not.
    console.error(`${LOG_TAG} federation store unavailable; refusing to issue unverifiable credential`)
    throw new Error('OFFICE_CREDENTIAL_STORE_UNAVAILABLE')
  }

  store.insertCredential({
    jti,
    officeId: input.officeId,
    identity: input.identity,
    scope,
    exp: exp ?? null,
    issuedAt: Date.now(),
    revoked: false,
  })
  console.log(`${LOG_TAG} issued credential ${jti}`)

  return { token, jti }
}

/**
 * Verify a presented office token. Returns the claims only when every check
 * passes; any failure returns null (no detail is leaked to the caller).
 */
export function verifyOfficeCredential(token: string): OfficeCredential | null {
  if (typeof token !== 'string') return null
  if (!token.startsWith(OFFICE_TOKEN_PREFIX)) return null

  const body = token.slice(OFFICE_TOKEN_PREFIX.length)
  const dot = body.indexOf('.')
  if (dot <= 0 || dot !== body.lastIndexOf('.') || dot === body.length - 1) {
    // Must be exactly one '.' with non-empty segments on both sides.
    return null
  }

  const claimsBytes = Buffer.from(body.slice(0, dot), 'base64url')
  const signature = Buffer.from(body.slice(dot + 1), 'base64url')
  if (claimsBytes.length === 0 || signature.length === 0) return null

  // Ed25519 signature check over the exact claims bytes.
  let signatureValid = false
  try {
    signatureValid = verify(null, claimsBytes, createPublicKey(getLocalPublicKeyPem()), signature)
  } catch {
    return null
  }
  if (!signatureValid) return null

  let claims: OfficeCredentialClaims
  try {
    claims = JSON.parse(claimsBytes.toString('utf8')) as OfficeCredentialClaims
  } catch {
    return null
  }

  if (claims.type !== 'office-member' || typeof claims.jti !== 'string' || !claims.jti) {
    return null
  }

  if (typeof claims.exp === 'number' && Date.now() > claims.exp) {
    return null
  }

  // Revocation ledger: existence AND not-revoked are both required. An unknown
  // jti is invalid (could be forged or revoked-by-deletion); isRevoked-alone is
  // insufficient because it returns false for a missing row.
  const record = getFederationStore()?.getCredential(claims.jti)
  if (!record || record.revoked) return null

  return claims
}

/** Revoke a previously issued credential. Returns false when the jti is unknown. */
export function revokeOfficeCredential(jti: string): boolean {
  return getFederationStore()?.revokeCredential(jti) ?? false
}

/**
 * Rebuild the token string for an existing ledger credential WITHOUT minting a
 * new one. The ledger persists the claim fields (jti/officeId/identity/scope/exp)
 * but not the token string; because signing is deterministic over canonical
 * claims bytes, the original token is reproduced exactly. Used by the invite
 * reuse path so reopening the invite dialog returns the SAME shareable link.
 */
export function reissueOfficeCredentialToken(record: OfficeCredentialRecord): string {
  const claims = buildClaims({
    officeId: record.officeId,
    identity: record.identity,
    scope: record.scope,
    exp: record.exp,
    jti: record.jti,
  })
  return buildTokenFromClaims(claims)
}

/**
 * Find a still-usable credential for an office and return its rebuilt token, so
 * a caller can hand back the SAME invite instead of minting a new one. Returns
 * null when none qualifies, signalling the caller to mint fresh.
 *
 * When `requestedScope` is given, only a credential whose scope matches it is
 * reused — reusing a differently-scoped credential would hand back a link
 * broader or narrower than asked (a confused-deputy issuance). Omitting the
 * argument reuses regardless of scope, for link-stability on an unscoped reopen.
 */
export function findReusableOfficeCredential(
  officeId: string,
  requestedScope?: OfficeScope,
): { token: string; record: OfficeCredentialRecord } | null {
  const store = getFederationStore()
  if (!store) return null
  const now = Date.now()
  const usable = store
    .listCredentialsByOffice(officeId)
    .filter((r) => !r.revoked && (r.exp == null || now + REUSE_EXPIRY_SKEW_MS < r.exp))
    .filter((r) => requestedScope == null || scopeEquals(r.scope, requestedScope))
    .sort((a, b) => b.issuedAt - a.issuedAt)
  const record = usable[0]
  if (!record) return null
  return { token: reissueOfficeCredentialToken(record), record }
}

/**
 * Routing hint only — decides which validation branch a token takes. Actual
 * office validity is decided by verifyOfficeCredential(), never by this function.
 */
export function parseCredentialType(token: string): CredentialType {
  if (typeof token !== 'string') return 'remote-control'
  return token.startsWith(OFFICE_TOKEN_PREFIX) ? 'office-member' : 'remote-control'
}
