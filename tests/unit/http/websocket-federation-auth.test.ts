/**
 * D10 — WS federation node-identity handshake (device-key challenge–response).
 *
 * A shareable office invite is a bearer: it proves an office, not WHO presents
 * it. A federation NODE session must additionally prove its portable identity by
 * signing a host-issued one-shot nonce with its device key. This suite drives the
 * production initWebSocket over a real `ws` socket and asserts:
 *   - a federation session with a VALID proof authenticates and binds the proven
 *     node identity (getSessionIdentity);
 *   - a federation session that answers with a signature over the WRONG nonce is
 *     rejected (no replay of a captured challenge);
 *   - a bearer-only office session (no federation flag) authenticates as a VIEWER
 *     with NO bound node identity, and may not speak federation frames;
 *   - roster re-entry: a proven identity already admitted as an office node is
 *     re-admitted when its invite token can no longer be verified (survivor
 *     dialing a new authority), while an unknown identity is refused.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import path from 'path'
import { WebSocket } from 'ws'

function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
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

import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../src/main/platform/store/types'
import { initFederationStore, shutdownFederationStore, getFederationStore } from '../../../src/main/apps/federation/index'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../src/main/apps/team/migrations'
import { TeamStore } from '../../../src/main/apps/team/store'
import {
  initIdentity,
  getLocalIdentity,
  getLocalPublicKeyPem,
  signWithLocalKey,
} from '../../../src/main/http/identity/index'
import { issueOfficeCredential } from '../../../src/main/http/auth/office-credential'
import { initWebSocket, shutdownWebSocket, getSessionIdentity, listOfficeClientIds } from '../../../src/main/http/websocket'

const OFFICE = 'office-fedauth'

interface Frame {
  type: string
  payload?: Record<string, unknown>
  error?: string
}

/** A raw ws client that records frames and lets a test drive the auth legs. */
class RawClient {
  readonly ws: WebSocket
  readonly received: Frame[] = []
  private constructor(ws: WebSocket) {
    this.ws = ws
  }
  static async connect(port: number): Promise<RawClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const client = new RawClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    ws.on('message', (buf: Buffer) => client.received.push(JSON.parse(buf.toString()) as Frame))
    return client
  }
  send(frame: object): void {
    this.ws.send(JSON.stringify(frame))
  }
  last(type: string): Frame | undefined {
    return [...this.received].reverse().find((f) => f.type === type)
  }
  close(): void {
    this.ws.close()
  }
}

async function waitFor(predicate: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 15))
  }
}

/** Sign a base64 nonce with the local device key (a valid proof). */
function proofFor(nonce: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  const identity = getLocalIdentity()
  return {
    method: 'device-key',
    identityId: identity.id,
    publicKey: getLocalPublicKeyPem(),
    displayName: identity.displayName,
    challenge: nonce,
    signature: signWithLocalKey(Buffer.from(nonce, 'base64')).toString('base64'),
    ...overrides,
  }
}

describe('D10 — WS federation node-identity handshake', () => {
  let server: http.Server
  let port: number
  let dbManager: DatabaseManager
  let teamStore: TeamStore
  let token: string

  beforeEach(async () => {
    initIdentity()
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    initFederationStore({ db: dbManager })
    teamStore = new TeamStore(db)
    token = issueOfficeCredential({ officeId: OFFICE, identity: getLocalIdentity().id }).token

    server = http.createServer()
    initWebSocket(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(() => {
    shutdownWebSocket()
    server?.close()
    shutdownFederationStore()
    dbManager.closeAll()
  })

  it('a federation session with a valid device-key proof authenticates and binds the proven identity', async () => {
    const client = await RawClient.connect(port)
    client.send({ type: 'auth', payload: { token, federation: true } })
    await waitFor(() => client.last('auth:challenge') !== undefined)
    const nonce = client.last('auth:challenge')!.payload!.nonce as string
    expect(typeof nonce).toBe('string')

    client.send({ type: 'auth', payload: { token, federation: true, proof: proofFor(nonce) } })
    await waitFor(() => client.last('auth:success') !== undefined)

    // The session is bound to the proven node identity, so the office-client set
    // now lists this connection and getSessionIdentity reports the id.
    await waitFor(() => listOfficeClientIds(OFFICE).length === 1)
    const clientId = listOfficeClientIds(OFFICE)[0]
    expect(getSessionIdentity(clientId)).toBe(getLocalIdentity().id)
    client.close()
  })

  it('rejects a proof signed over a DIFFERENT nonce (no replay of a captured challenge)', async () => {
    const client = await RawClient.connect(port)
    client.send({ type: 'auth', payload: { token, federation: true } })
    await waitFor(() => client.last('auth:challenge') !== undefined)
    const nonce = client.last('auth:challenge')!.payload!.nonce as string

    // Sign a foreign nonce but claim it answers the issued challenge.
    const foreignNonce = Buffer.from('some-other-challenge-bytes-32bytes!!').toString('base64')
    const forged = proofFor(foreignNonce, { challenge: nonce })

    client.send({ type: 'auth', payload: { token, federation: true, proof: forged } })
    await waitFor(() => client.last('auth:failed') !== undefined)
    expect(client.last('auth:success')).toBeUndefined()
    client.close()
  })

  it('a bearer-only office session authenticates as a viewer with NO node identity and cannot speak federation', async () => {
    const client = await RawClient.connect(port)
    client.send({ type: 'auth', payload: { token } })
    await waitFor(() => client.last('auth:success') !== undefined)

    await waitFor(() => listOfficeClientIds(OFFICE).length === 1)
    const clientId = listOfficeClientIds(OFFICE)[0]
    // Authenticated, but no PROVEN node identity → getSessionIdentity is null.
    expect(getSessionIdentity(clientId)).toBeNull()

    // A federation frame from a bearer-only viewer is refused.
    client.send({ type: 'federation', payload: { kind: 'heartbeat', officeId: OFFICE, fromNode: 'x', ts: 1 } })
    await waitFor(() => client.last('error') !== undefined)
    expect(client.last('error')!.error).toBe('Federation not permitted')
    client.close()
  })

  it('roster re-entry: a proven identity already admitted as a node is re-admitted when the invite cannot be verified; an unknown identity is refused', async () => {
    // Seed the local ledger as if this identity already joined the office (the
    // survivor case: the creator's invite key is gone, but the node row remains).
    const identityId = getLocalIdentity().id
    getFederationStore()!.upsertNode({
      nodeId: identityId,
      officeId: OFFICE,
      identity: identityId,
      displayName: 'Survivor',
      joinedAt: 1,
      lastSeen: Date.now(),
      status: 'online',
      advertisedUrl: null,
    })

    // Re-entry with an UNVERIFIABLE token (garbage) but a valid identity proof +
    // officeId. Admitted because the identity is an admitted node of the office.
    const client = await RawClient.connect(port)
    client.send({ type: 'auth', payload: { token: 'halo-office.not.verifiable', federation: true, officeId: OFFICE } })
    await waitFor(() => client.last('auth:challenge') !== undefined)
    const nonce = client.last('auth:challenge')!.payload!.nonce as string
    client.send({ type: 'auth', payload: { token: 'halo-office.not.verifiable', federation: true, officeId: OFFICE, proof: proofFor(nonce) } })
    await waitFor(() => client.last('auth:success') !== undefined || client.last('auth:failed') !== undefined)
    expect(client.last('auth:success')).toBeDefined()
    await waitFor(() => listOfficeClientIds(OFFICE).length === 1)
    expect(getSessionIdentity(listOfficeClientIds(OFFICE)[0])).toBe(identityId)
    client.close()

    // A DIFFERENT office (no node row for this identity) refuses re-entry.
    const other = await RawClient.connect(port)
    other.send({ type: 'auth', payload: { token: 'halo-office.not.verifiable', federation: true, officeId: 'office-unknown' } })
    await waitFor(() => other.last('auth:challenge') !== undefined)
    const nonce2 = other.last('auth:challenge')!.payload!.nonce as string
    other.send({ type: 'auth', payload: { token: 'halo-office.not.verifiable', federation: true, officeId: 'office-unknown', proof: proofFor(nonce2) } })
    await waitFor(() => other.last('auth:failed') !== undefined)
    expect(other.last('auth:success')).toBeUndefined()
    other.close()
  })
})
