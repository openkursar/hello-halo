/**
 * Tests for the M1b invite-generation + join flow (P2).
 *
 * Two surfaces are exercised:
 *   - generate/revoke: the shared team-invite controller, with REAL crypto
 *     (issueOfficeCredential signs with the host identity) and a real in-memory
 *     FederationStore revocation ledger. getRemoteAccessStatus and the federation
 *     manager are mocked so the host-coordinator side-effect and the remote-off
 *     gate can be asserted without a running server.
 *   - join-office: the shared joinTeamOffice controller. The federation manager
 *     + app manager are mocked so we can assert the resolved bringMembers,
 *     selfContext, member skipping, the empty → NO_MEMBERS guard, and reason
 *     propagation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'

function testHome(): string {
  return (globalThis as { __HALO_TEST_DIR__?: string }).__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

// Electron mock: safeStorage stub for the identity key store.
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

// ── Mockable singletons used by the controller + join handler ──
const remoteStatus = {
  value: {
    server: { running: true, lanUrl: 'http://192.168.1.50:3017' as string | null },
  },
}
vi.mock('../../../../../src/main/services/remote', () => ({
  getRemoteAccessStatus: () => remoteStatus.value,
}))

const fedManager = {
  hostOffice: vi.fn(),
  joinOffice: vi.fn(),
}
const fedManagerRef: { value: typeof fedManager | null } = { value: fedManager }
vi.mock('../../../../../src/main/apps/runtime/federation/manager', () => ({
  getFederationManager: () => fedManagerRef.value,
}))

const appMap = new Map<string, { id: string; spaceId: string | null; spec: { name: string } }>()
vi.mock('../../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: (id: string) => appMap.get(id) ?? null }),
}))

vi.mock('../../../../../src/main/http/identity/index', async () => {
  const actual = await vi.importActual<typeof import('../../../../../src/main/http/identity/index')>(
    '../../../../../src/main/http/identity/index'
  )
  return { ...actual, getLocalIdentity: () => ({ id: 'self-node-id', displayName: 'Self' }) }
})

// team store is consumed by the controller (getTeamById) — mock to a simple map.
const teams = new Set<string>()
vi.mock('../../../../../src/main/apps/team', () => ({
  getTeamStore: () => ({ getTeamById: (id: string) => (teams.has(id) ? { id } : null) }),
  getTeamService: () => null,
}))

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import {
  initFederationStore,
  shutdownFederationStore,
  getFederationStore,
} from '../../../../../src/main/apps/federation/index'
import { ensureLocalIdentity, _resetLocalIdentityCache } from '../../../../../src/main/http/identity/device-key'
import { verifyOfficeCredential } from '../../../../../src/main/http/auth/office-credential'
import {
  generateTeamInvite,
  revokeTeamInvite,
  joinTeamOffice,
} from '../../../../../src/main/controllers/team-invite.controller'

const TEAM_ID = 'team-abc'

describe('team invite generation + join (P2)', () => {
  let dbManager: DatabaseManager

  beforeEach(() => {
    _resetLocalIdentityCache()
    ensureLocalIdentity()
    dbManager = createDatabaseManager(':memory:')
    initFederationStore({ db: dbManager })

    teams.clear()
    teams.add(TEAM_ID)
    appMap.clear()
    remoteStatus.value = { server: { running: true, lanUrl: 'http://192.168.1.50:3017' } }
    fedManagerRef.value = fedManager
    fedManager.hostOffice.mockReset()
    fedManager.joinOffice.mockReset()
  })

  afterEach(() => {
    shutdownFederationStore()
    dbManager.closeAll()
  })

  // ── generate-invite ──

  it('mints a verifiable invite URL and hosts the office (remote access ON)', async () => {
    const result = await generateTeamInvite(TEAM_ID)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.officeId).toBe(TEAM_ID)
    expect(result.data.serverUrl).toBe('http://192.168.1.50:3017')
    expect(result.data.url).toContain(`office=${TEAM_ID}`)
    expect(result.data.url).toContain('invite=')
    expect(result.data.url.startsWith('http://192.168.1.50:3017/?')).toBe(true)

    // The office coordinator was readied for joins.
    expect(fedManager.hostOffice).toHaveBeenCalledWith(TEAM_ID)

    // The embedded token is a real, verifiable office credential for this office.
    const claims = verifyOfficeCredential(result.data.token)
    expect(claims?.officeId).toBe(TEAM_ID)
  })

  it('returns the SAME active invite across repeated opens (A-1)', async () => {
    const first = await generateTeamInvite(TEAM_ID)
    const second = await generateTeamInvite(TEAM_ID)
    expect(first.success && second.success).toBe(true)
    if (!first.success || !second.success) return
    expect(second.data.jti).toBe(first.data.jti)
    expect(second.data.token).toBe(first.data.token)
    expect(second.data.url).toBe(first.data.url)
    // Office is hosted on the first issue; the reuse path still re-readies it.
    expect(fedManager.hostOffice).toHaveBeenCalledWith(TEAM_ID)
  })

  it('mints a fresh invite after the active one is revoked (A-1)', async () => {
    const first = await generateTeamInvite(TEAM_ID)
    expect(first.success).toBe(true)
    if (!first.success) return

    revokeTeamInvite(first.data.jti)

    const second = await generateTeamInvite(TEAM_ID)
    expect(second.success).toBe(true)
    if (!second.success) return
    expect(second.data.jti).not.toBe(first.data.jti)
    expect(verifyOfficeCredential(first.data.token)).toBeNull()
    expect(verifyOfficeCredential(second.data.token)).not.toBeNull()
  })

  it('refreshes the URL on endpoint change while reusing the token (A-1)', async () => {
    const first = await generateTeamInvite(TEAM_ID)
    expect(first.success).toBe(true)
    if (!first.success) return

    // Simulate a port drift: the token is endpoint-independent, so the SAME
    // credential is reused inside a URL rebuilt for the new endpoint (no re-mint),
    // and a link a user already shared keeps verifying.
    remoteStatus.value = { server: { running: true, lanUrl: 'http://192.168.1.50:4099' } }
    const second = await generateTeamInvite(TEAM_ID)
    expect(second.success).toBe(true)
    if (!second.success) return
    expect(second.data.jti).toBe(first.data.jti)
    expect(second.data.token).toBe(first.data.token)
    expect(second.data.serverUrl).toBe('http://192.168.1.50:4099')
    expect(second.data.url.startsWith('http://192.168.1.50:4099/?')).toBe(true)
  })

  it('returns REMOTE_ACCESS_OFF when remote access is not running', async () => {
    remoteStatus.value = { server: { running: false, lanUrl: null } }
    const result = await generateTeamInvite(TEAM_ID)
    expect(result).toEqual({ success: false, error: 'REMOTE_ACCESS_OFF' })
    expect(fedManager.hostOffice).not.toHaveBeenCalled()
  })

  it('returns TEAM_NOT_FOUND for an unknown team', async () => {
    const result = await generateTeamInvite('no-such-team')
    expect(result).toEqual({ success: false, error: 'TEAM_NOT_FOUND' })
  })

  it('returns FEDERATION_UNAVAILABLE when no manager is present', async () => {
    fedManagerRef.value = null
    const result = await generateTeamInvite(TEAM_ID)
    expect(result).toEqual({ success: false, error: 'FEDERATION_UNAVAILABLE' })
  })

  // ── revoke ──

  it('revokes an issued invite so it no longer verifies', async () => {
    const issued = await generateTeamInvite(TEAM_ID)
    expect(issued.success).toBe(true)
    if (!issued.success) return
    expect(verifyOfficeCredential(issued.data.token)).not.toBeNull()

    const revoked = revokeTeamInvite(issued.data.jti)
    expect(revoked.success).toBe(true)
    expect(getFederationStore()?.getCredential(issued.data.jti)?.revoked).toBe(true)
    expect(verifyOfficeCredential(issued.data.token)).toBeNull()
  })

  // ── join-office ──

  it('resolves bringMembers from local apps and drives joinOffice', async () => {
    appMap.set('app-1', { id: 'app-1', spaceId: 'space-1', spec: { name: 'Analyst' } })
    appMap.set('app-2', { id: 'app-2', spaceId: null, spec: { name: 'Writer' } })
    fedManager.joinOffice.mockResolvedValue({ ok: true })

    const res = await joinTeamOffice({
      officeId: TEAM_ID,
      serverUrl: 'http://host:3017',
      inviteToken: 'tok',
      bringAppIds: ['app-1', 'unknown-app', 'app-2'],
    })

    expect(res).toEqual({ success: true })
    expect(fedManager.joinOffice).toHaveBeenCalledTimes(1)
    const arg = fedManager.joinOffice.mock.calls[0][0]
    expect(arg.officeId).toBe(TEAM_ID)
    expect(arg.serverUrl).toBe('http://host:3017')
    expect(arg.credentialToken).toBe('tok')
    expect(arg.selfContext).toEqual({ officeId: TEAM_ID, selfNodeId: 'self-node-id' })
    // unknown-app skipped; spaceId carried (and undefined for the null one).
    expect(arg.bringMembers).toEqual([
      { appId: 'app-1', memberName: 'Analyst', role: '', spaceId: 'space-1' },
      { appId: 'app-2', memberName: 'Writer', role: '', spaceId: undefined },
    ])
  })

  it('returns NO_MEMBERS when no appIds resolve', async () => {
    fedManager.joinOffice.mockResolvedValue({ ok: true })
    const res = await joinTeamOffice({
      officeId: TEAM_ID,
      serverUrl: 'http://host:3017',
      inviteToken: 'tok',
      bringAppIds: ['ghost'],
    })
    expect(res).toEqual({ success: false, error: 'NO_MEMBERS' })
    expect(fedManager.joinOffice).not.toHaveBeenCalled()
  })

  it('propagates the join reason on failure', async () => {
    appMap.set('app-1', { id: 'app-1', spaceId: 'space-1', spec: { name: 'Analyst' } })
    fedManager.joinOffice.mockResolvedValue({ ok: false, reason: 'AUTH_REJECTED' })
    const res = await joinTeamOffice({
      officeId: TEAM_ID,
      serverUrl: 'http://host:3017',
      inviteToken: 'tok',
      bringAppIds: ['app-1'],
    })
    expect(res).toEqual({ success: false, error: 'AUTH_REJECTED' })
  })
})
