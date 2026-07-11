/**
 * Startup office recovery. On boot recoverPersistedOffices re-readies every
 * persisted office: owned offices (team rows, host_node_id null) are re-hosted,
 * and joined offices are re-dialed from the federation store's connection records
 * by replaying each through joinTeamOffice (the same path a manual join takes).
 *
 * The federation manager, federation store, and app manager are mocked so the
 * recovery's read→replay contract can be asserted without a running server: that
 * owned offices call hostOffice, that each persisted connection drives joinOffice
 * with the resolved members, and that one failing row never aborts the rest.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'

function testHome(): string {
  return (globalThis as { __HALO_TEST_DIR__?: string }).__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

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

// ── Mockable singletons the recovery + the joinTeamOffice it calls depend on ──
const fedManager = {
  hostOffice: vi.fn(),
  joinOffice: vi.fn(),
}
const fedManagerRef: { value: typeof fedManager | null } = { value: fedManager }
vi.mock('../../../src/main/apps/runtime/federation/manager', () => ({
  getFederationManager: () => fedManagerRef.value,
}))

interface JoinedConn {
  officeId: string
  serverUrl: string
  inviteToken: string
  bringAppIds: string[]
  createdAt: number
  updatedAt: number
}
const joinedConnections: { value: JoinedConn[] } = { value: [] }
vi.mock('../../../src/main/apps/federation', () => ({
  getFederationStore: () => ({ listJoinedOfficeConnections: () => joinedConnections.value }),
  // extended.ts imports several other symbols from this module at load; the
  // recovery path only touches getFederationStore, so the rest can be inert.
  initFederationStore: vi.fn(),
  shutdownFederationStore: vi.fn(),
  getAuthorityStore: () => null,
}))

const appMap = new Map<string, { id: string; spaceId: string | null; spec: { name: string } }>()
vi.mock('../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: (id: string) => appMap.get(id) ?? null }),
}))

vi.mock('../../../src/main/http/identity/index', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/http/identity/index')>(
    '../../../src/main/http/identity/index'
  )
  return { ...actual, getLocalIdentity: () => ({ id: 'self-node-id', displayName: 'Self' }) }
})

vi.mock('../../../src/main/apps/team', () => ({
  getTeamStore: () => teamStoreRef.value,
  getTeamService: () => null,
}))

// remote.service is lazy-imported by generateTeamInvite only; joinTeamOffice does
// not touch it, but stub it so any incidental import resolves.
vi.mock('../../../src/main/services/remote.service', () => ({
  getRemoteAccessStatus: () => ({ server: { running: false, lanUrl: null } }),
}))

interface FakeTeam {
  id: string
  hostNodeId: string | null
}
const teamStoreRef: { value: { listTeams: () => FakeTeam[] } | null } = { value: null }

import { recoverPersistedOffices } from '../../../src/main/bootstrap/office-recovery'
import type { TeamStore } from '../../../src/main/apps/team'

function fakeTeamStore(teams: FakeTeam[]): TeamStore {
  return { listTeams: () => teams } as unknown as TeamStore
}

describe('startup office recovery (H-1)', () => {
  beforeEach(() => {
    fedManagerRef.value = fedManager
    fedManager.hostOffice.mockReset()
    fedManager.joinOffice.mockReset()
    fedManager.joinOffice.mockResolvedValue({ ok: true })
    joinedConnections.value = []
    teamStoreRef.value = null
    appMap.clear()
  })

  it('re-hosts owned offices and skips joined team rows', () => {
    recoverPersistedOffices(
      fakeTeamStore([
        { id: 'owned-a', hostNodeId: null },
        { id: 'owned-b', hostNodeId: null },
        { id: 'joined-x', hostNodeId: 'remote-host' },
      ])
    )
    expect(fedManager.hostOffice).toHaveBeenCalledWith('owned-a')
    expect(fedManager.hostOffice).toHaveBeenCalledWith('owned-b')
    expect(fedManager.hostOffice).not.toHaveBeenCalledWith('joined-x')
    expect(fedManager.hostOffice).toHaveBeenCalledTimes(2)
  })

  it('re-dials each persisted joined connection through joinOffice with resolved members', async () => {
    appMap.set('app-1', { id: 'app-1', spaceId: 'space-1', spec: { name: 'Analyst' } })
    joinedConnections.value = [
      {
        officeId: 'joined-x',
        serverUrl: 'http://host:3017',
        inviteToken: 'tok-x',
        bringAppIds: ['app-1'],
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    recoverPersistedOffices(fakeTeamStore([]))
    // Re-join is fire-and-forget; let the dispatched promise settle.
    await vi.waitFor(() => expect(fedManager.joinOffice).toHaveBeenCalledTimes(1))

    const arg = fedManager.joinOffice.mock.calls[0][0]
    expect(arg.officeId).toBe('joined-x')
    expect(arg.serverUrl).toBe('http://host:3017')
    expect(arg.credentialToken).toBe('tok-x')
    expect(arg.selfContext).toEqual({ officeId: 'joined-x', selfNodeId: 'self-node-id' })
    expect(arg.bringMembers).toEqual([
      { appId: 'app-1', memberName: 'Analyst', role: '', spaceId: 'space-1' },
    ])
  })

  it('re-hosts and re-joins together in one pass', async () => {
    appMap.set('app-1', { id: 'app-1', spaceId: null, spec: { name: 'Writer' } })
    joinedConnections.value = [
      {
        officeId: 'joined-x',
        serverUrl: 'http://host:3017',
        inviteToken: 'tok-x',
        bringAppIds: ['app-1'],
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    recoverPersistedOffices(fakeTeamStore([{ id: 'owned-a', hostNodeId: null }]))

    expect(fedManager.hostOffice).toHaveBeenCalledWith('owned-a')
    await vi.waitFor(() => expect(fedManager.joinOffice).toHaveBeenCalledTimes(1))
  })

  it('a connection whose appIds no longer resolve does not abort the others', async () => {
    appMap.set('app-live', { id: 'app-live', spaceId: null, spec: { name: 'Live' } })
    joinedConnections.value = [
      // First row's app was uninstalled → joinTeamOffice returns NO_MEMBERS, no joinOffice.
      {
        officeId: 'joined-dead',
        serverUrl: 'http://host:3017',
        inviteToken: 'tok-dead',
        bringAppIds: ['app-gone'],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        officeId: 'joined-live',
        serverUrl: 'http://host:3017',
        inviteToken: 'tok-live',
        bringAppIds: ['app-live'],
        createdAt: 2,
        updatedAt: 2,
      },
    ]

    recoverPersistedOffices(fakeTeamStore([]))
    await vi.waitFor(() => expect(fedManager.joinOffice).toHaveBeenCalledTimes(1))
    expect(fedManager.joinOffice.mock.calls[0][0].officeId).toBe('joined-live')
  })

  it('a rejected join promise does not throw out of recovery', async () => {
    appMap.set('app-1', { id: 'app-1', spaceId: null, spec: { name: 'Writer' } })
    fedManager.joinOffice.mockRejectedValue(new Error('network down'))
    joinedConnections.value = [
      {
        officeId: 'joined-x',
        serverUrl: 'http://host:3017',
        inviteToken: 'tok-x',
        bringAppIds: ['app-1'],
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    expect(() => recoverPersistedOffices(fakeTeamStore([]))).not.toThrow()
    await vi.waitFor(() => expect(fedManager.joinOffice).toHaveBeenCalledTimes(1))
  })

  it('skips recovery cleanly when the federation manager is absent', () => {
    fedManagerRef.value = null
    expect(() =>
      recoverPersistedOffices(fakeTeamStore([{ id: 'owned-a', hostNodeId: null }]))
    ).not.toThrow()
    expect(fedManager.hostOffice).not.toHaveBeenCalled()
  })
})
