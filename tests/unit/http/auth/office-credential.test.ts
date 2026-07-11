/**
 * Office-member credential tests. Crypto is real (the host's Ed25519 identity
 * is both issuer and verifier) and the revocation ledger is a real in-memory
 * FederationStore; the global setup isolates getHaloDir() to a per-test temp
 * dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'

function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

// Own the electron mock to add a safeStorage stub the identity module needs
// (the global setup omits it). Plaintext fallback — no OS keychain in CI.
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      const dir = testHome()
      if (name === 'userData') return path.join(dir, '.halo')
      return dir
    },
    getAppPath: () => path.join(testHome(), 'app'),
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { initFederationStore, shutdownFederationStore, getFederationStore, DEFAULT_OFFICE_SCOPE } from '../../../../src/main/apps/federation/index'
import { ensureLocalIdentity, _resetLocalIdentityCache } from '../../../../src/main/http/identity/device-key'
import {
  issueOfficeCredential,
  verifyOfficeCredential,
  revokeOfficeCredential,
  parseCredentialType,
  findReusableOfficeCredential,
  reissueOfficeCredentialToken,
} from '../../../../src/main/http/auth/office-credential'

const OFFICE_A = 'team-abc'
const IDENTITY_A = 'id_member_1'

describe('office-credential', () => {
  let dbManager: DatabaseManager

  beforeEach(() => {
    _resetLocalIdentityCache()
    ensureLocalIdentity()
    dbManager = createDatabaseManager(':memory:')
    initFederationStore({ db: dbManager })
  })

  afterEach(() => {
    shutdownFederationStore()
    dbManager.closeAll()
    _resetLocalIdentityCache()
  })

  it('issues a well-formed narrow scope (enforced end-to-end once identity is device-key proven)', () => {
    // Narrow scope is now issuable: the joiner's identity is proven at the WS
    // handshake (device-key challenge–response), the overlay is persisted on the
    // admitted member row, and the authority scope gate enforces it against the
    // authenticated node — a working narrow membership, not a dead invite.
    const scope = { visibility: 'readonly' as const, contactable: 'lead-only' as const, discoverable: false, canReinvite: false }
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A, scope })
    const cred = verifyOfficeCredential(token)
    expect(cred?.scope).toEqual(scope)
  })

  it('rejects issuing a malformed scope (out-of-domain field)', () => {
    expect(() =>
      issueOfficeCredential({
        officeId: OFFICE_A,
        identity: IDENTITY_A,
        // visibility outside the closed enum — must never be signed.
        scope: { visibility: 'everything' as never, contactable: 'all', discoverable: true, canReinvite: true },
      }),
    ).toThrow('OFFICE_SCOPE_INVALID')
  })

  it('round-trips: issue then verify returns the claims', () => {
    const { token, jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    const cred = verifyOfficeCredential(token)
    expect(cred).not.toBeNull()
    expect(cred?.type).toBe('office-member')
    expect(cred?.officeId).toBe(OFFICE_A)
    expect(cred?.identity).toBe(IDENTITY_A)
    expect(cred?.jti).toBe(jti)
    expect(cred?.scope.visibility).toBe('full')
  })

  it('rejects a tampered signature', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    // token format: halo-office.<claims>.<sig>
    const lastDot = token.lastIndexOf('.')
    const prefixAndClaims = token.slice(0, lastDot)
    const forged = `${prefixAndClaims}.${Buffer.from('not-a-real-signature-padding-padding').toString('base64url')}`
    expect(verifyOfficeCredential(forged)).toBeNull()
  })

  it('rejects tampered claims (signature no longer matches)', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    const sig = token.slice(token.lastIndexOf('.') + 1)
    const prefix = token.slice(0, token.indexOf('.') + 1) // includes the trailing '.'
    const tamperedClaims = Buffer.from(
      JSON.stringify({ type: 'office-member', officeId: 'other-office', identity: IDENTITY_A, scope: {}, jti: 'x' })
    ).toString('base64url')
    expect(verifyOfficeCredential(`${prefix}${tamperedClaims}.${sig}`)).toBeNull()
  })

  it('rejects an expired credential', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A, ttlMs: -1000 })
    expect(verifyOfficeCredential(token)).toBeNull()
  })

  it('rejects a revoked credential', () => {
    const { token, jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    expect(verifyOfficeCredential(token)).not.toBeNull()
    expect(revokeOfficeCredential(jti)).toBe(true)
    expect(verifyOfficeCredential(token)).toBeNull()
  })

  it('rejects an unknown jti — existence in the ledger is required', () => {
    const { token, jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    getFederationStore()!.revokeCredential(jti)
    // Even stronger: delete the row entirely via a fresh store with no records.
    const fresh = createDatabaseManager(':memory:')
    initFederationStore({ db: fresh })
    expect(verifyOfficeCredential(token)).toBeNull()
    fresh.closeAll()
  })

  it('treats a remote-control PIN as remote-control and never verifies it as office', () => {
    const pin = 'Aa1!Aa1!Aa1!'
    expect(parseCredentialType(pin)).toBe('remote-control')
    expect(verifyOfficeCredential(pin)).toBeNull()
  })

  it('classifies an office token (magic prefix) as office-member', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    expect(token.startsWith('halo-office.')).toBe(true)
    expect(parseCredentialType(token)).toBe('office-member')
  })

  it('F5: a custom remote-control password containing a "." routes to PIN, not office', () => {
    // A user-chosen password may legitimately contain a '.' (the policy special
    // class spans !-/, which includes '.'). Classifying by a bare '.' would
    // misroute it to the office branch → permanent 401 lockout. The magic prefix
    // prevents that: only a real office token carries it.
    const dottedPassword = 'My.Secret.Pass1!'
    expect(parseCredentialType(dottedPassword)).toBe('remote-control')
    expect(verifyOfficeCredential(dottedPassword)).toBeNull()
  })

  it('rejects malformed tokens', () => {
    expect(verifyOfficeCredential('')).toBeNull()
    expect(verifyOfficeCredential('.')).toBeNull()
    expect(verifyOfficeCredential('abc.')).toBeNull()
    expect(verifyOfficeCredential('.abc')).toBeNull()
    expect(verifyOfficeCredential('a.b.c')).toBeNull()
  })

  // ── invite reuse helpers ──

  it('reissueOfficeCredentialToken reproduces the original token byte-for-byte', () => {
    const { token, jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    const record = getFederationStore()!.getCredential(jti)!
    const rebuilt = reissueOfficeCredentialToken(record)
    // Deterministic Ed25519 over canonical claims bytes → identical token string.
    expect(rebuilt).toBe(token)
    expect(verifyOfficeCredential(rebuilt)).not.toBeNull()
  })

  it('reissue reproduces a no-expiry token identically (exp omitted, not null)', () => {
    // No ttl → exp undefined at issue, stored as null in the ledger. The rebuild
    // must omit exp so the bytes match (exp: null would change the signature).
    const { token, jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    const record = getFederationStore()!.getCredential(jti)!
    expect(record.exp).toBeNull()
    expect(reissueOfficeCredentialToken(record)).toBe(token)
  })

  it('findReusableOfficeCredential returns the active credential token', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    const reuse = findReusableOfficeCredential(OFFICE_A)
    expect(reuse).not.toBeNull()
    expect(reuse?.token).toBe(token)
    expect(verifyOfficeCredential(reuse!.token)).not.toBeNull()
  })

  it('findReusableOfficeCredential skips a revoked credential', () => {
    const { jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    expect(revokeOfficeCredential(jti)).toBe(true)
    expect(findReusableOfficeCredential(OFFICE_A)).toBeNull()
  })

  it('findReusableOfficeCredential skips an expired credential', () => {
    issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A, ttlMs: -1000 })
    expect(findReusableOfficeCredential(OFFICE_A)).toBeNull()
  })

  it('findReusableOfficeCredential returns null for an office with no credential', () => {
    expect(findReusableOfficeCredential('office-with-nothing')).toBeNull()
  })

  it('findReusableOfficeCredential picks a qualifying credential, skipping non-qualifying ones', () => {
    // Two credentials exist for the office; the first is revoked, so reuse must
    // return the second (only-qualifying) one. This exercises selection among
    // mixed states without depending on sub-millisecond issuedAt ordering.
    const first = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    const second = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    expect(revokeOfficeCredential(first.jti)).toBe(true)
    const reuse = findReusableOfficeCredential(OFFICE_A)
    expect(reuse?.record.jti).toBe(second.jti)
    expect(verifyOfficeCredential(reuse!.token)).not.toBeNull()
  })

  it('findReusableOfficeCredential reuses a credential with the matching requested scope', () => {
    // Scope-matched reuse: the request carries the same (default) scope the
    // credential was issued with, so reuse returns it. Narrow scopes can't be
    // exercised here while non-default issuance is gated (pending device-key bind).
    const { jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    const reuse = findReusableOfficeCredential(OFFICE_A, DEFAULT_OFFICE_SCOPE)
    expect(reuse?.record.jti).toBe(jti)
    expect(reuse?.record.scope).toEqual(DEFAULT_OFFICE_SCOPE)
  })

  it('findReusableOfficeCredential mints fresh when the requested scope differs (no confused-deputy reuse)', () => {
    // A default-scope credential exists; a request for a NARROWER scope must not
    // reuse it (that would hand back a link wider than asked). Reuse returns null,
    // signalling the caller to mint a fresh, correctly-scoped credential.
    issueOfficeCredential({ officeId: OFFICE_A, identity: IDENTITY_A })
    const narrow = { visibility: 'readonly' as const, contactable: 'lead-only' as const, discoverable: false, canReinvite: false }
    expect(findReusableOfficeCredential(OFFICE_A, narrow)).toBeNull()
  })
})
