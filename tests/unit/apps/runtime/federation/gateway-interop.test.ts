/**
 * Interop smoke: the real TS federation clients against the REAL Go gateway
 * binary (`gateway/`), exercising the full v1-gw relay path end to end:
 *
 *   host GatewayAttachClient ── auth(proof) → gw:host-attach ──┐
 *                                                              │ Go gateway
 *   member WsFederationClient ─ auth(proof) → join-request ────┘
 *     → host receives, replies addressed join-grant (admission gate)
 *     → member receives grant, then a host BROADCAST (proves admitted)
 *     → member frame relayed back to host
 *
 * Both sides present real Ed25519 device-key proofs; the identity derivation
 * here is the protocol-mandated `id_ + b64url(sha256(SPKI DER))[:32]`, so this
 * doubles as the cross-implementation golden-vector check.
 *
 * Skipped when the Go toolchain is unavailable (the gateway is built once per
 * run into a temp dir).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { generateKeyPairSync, createHash, sign as edSign, type KeyObject } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import net from 'net'

import { WsFederationClient } from '../../../../../src/main/apps/runtime/federation/ws-federation-client'
import { GatewayAttachClient } from '../../../../../src/main/apps/runtime/federation/gateway-attach'
import type { FederationMessage } from '../../../../../src/main/apps/runtime/federation/types'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { AuthorityStore } from '../../../../../src/main/apps/federation/authority-store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const OFFICE = 'office-interop-1'

function hasGo(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

interface TestIdentity {
  id: string
  privateKey: KeyObject
  publicKeyPem: string
}

/** Mirrors src/main/http/identity/device-key.ts deriveIdentityId (protocol §3.3). */
function makeIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const id = `id_${createHash('sha256').update(der).digest('base64url').slice(0, 32)}`
  return { id, privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string }
}

function makeProof(identity: TestIdentity, nonce: string): Record<string, unknown> {
  return {
    method: 'device-key',
    identityId: identity.id,
    publicKey: identity.publicKeyPem,
    challenge: nonce,
    signature: edSign(null, Buffer.from(nonce, 'base64'), identity.privateKey).toString('base64'),
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe.skipIf(!hasGo())('gateway interop (real Go binary)', () => {
  let workDir: string
  let gateway: ChildProcess | null = null
  let baseUrl: string

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'halo-gw-interop-'))
    const bin = path.join(workDir, 'halo-gateway')
    execFileSync('go', ['build', '-o', bin, './cmd/gateway'], {
      cwd: path.join(REPO_ROOT, 'gateway'),
      stdio: ['ignore', 'pipe', 'pipe'],
      // The electron-vitest environment strips parts of the shell profile; give
      // the Go toolchain an explicit cache so builds work regardless of HOME.
      env: { ...process.env, GOCACHE: path.join(workDir, 'gocache'), GOFLAGS: '-mod=mod' },
    })

    const port = await pickFreePort()
    baseUrl = `http://127.0.0.1:${port}`
    gateway = spawn(bin, ['-listen', `127.0.0.1:${port}`, '-log-level', 'warn'], { stdio: 'inherit' })

    // Readiness: poll /healthz until the gateway serves.
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        const res = await fetch(`${baseUrl}/healthz`)
        if (res.ok) break
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('gateway did not become healthy')
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 60_000)

  afterAll(async () => {
    gateway?.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
    gateway?.kill('SIGKILL')
    rmSync(workDir, { recursive: true, force: true })
  })

  it('relays the full join handshake, broadcast, and member traffic', async () => {
    const hostId = makeIdentity()
    const memberId = makeIdentity()

    // ── Host: attach to the office room ──
    const hostInbound: FederationMessage[] = []
    const host = new GatewayAttachClient({
      gatewayUrl: baseUrl,
      officeId: OFFICE,
      makeAuthProof: (nonce) => makeProof(hostId, nonce),
      onFrame: (frame) => hostInbound.push(frame),
      signAnnounce: (payload) =>
        edSign(null, Buffer.from(payload, 'utf8'), hostId.privateKey).toString('base64'),
      getIdentityId: () => hostId.id,
      getEndpoints: () => ['http://192.0.2.1:3017'],
      getDisplayName: () => 'Interop Host',
    })
    await waitFor(() => host.isAttached())

    // ── Member: dial the gateway exactly like a joiner dials a host ──
    const memberInbound: FederationMessage[] = []
    let memberState = ''
    const member = new WsFederationClient({
      serverUrl: baseUrl,
      credentialToken: 'opaque-invite-token',
      officeId: OFFICE,
      makeAuthProof: (nonce) => makeProof(memberId, nonce),
      onFrame: (frame) => memberInbound.push(frame),
      onStateChange: (state) => {
        memberState = state
      },
    })
    await waitFor(() => memberState === 'open')

    // Pending member → host: the join handshake is relayed to the host.
    member.send({
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: memberId.id,
      identityId: memberId.id,
      credentialToken: 'opaque-invite-token',
      bringMembers: [],
    })
    await waitFor(() => hostInbound.some((f) => f.kind === 'join-request'))
    const joinReq = hostInbound.find((f) => f.kind === 'join-request')!
    expect(joinReq).toMatchObject({ fromNode: memberId.id, officeId: OFFICE })

    // Host → member: an ADDRESSED join-grant admits the member at the gateway.
    host.send(memberId.id, {
      kind: 'join-grant',
      officeId: OFFICE,
      assignedNodeId: memberId.id,
    })
    await waitFor(() => memberInbound.some((f) => f.kind === 'join-grant'))

    // Broadcast after admission reaches the member (pending members would not).
    host.send(null, {
      kind: 'presence-update',
      officeId: OFFICE,
      nodeId: hostId.id,
      status: 'online',
      members: [hostId.id],
      since: Date.now(),
    })
    await waitFor(() => memberInbound.some((f) => f.kind === 'presence-update'))

    // Member traffic keeps flowing host-ward after admission.
    member.send({ kind: 'heartbeat', officeId: OFFICE, fromNode: memberId.id, ts: Date.now() })
    await waitFor(() => hostInbound.some((f) => f.kind === 'heartbeat'))

    member.close()
    host.close()
  }, 30_000)

  it('rejects a spoofed fromNode at the gateway edge', async () => {
    const hostId = makeIdentity()
    const evilId = makeIdentity()

    const hostInbound: FederationMessage[] = []
    const host = new GatewayAttachClient({
      gatewayUrl: baseUrl,
      officeId: 'office-interop-spoof',
      makeAuthProof: (nonce) => makeProof(hostId, nonce),
      onFrame: (frame) => hostInbound.push(frame),
      getIdentityId: () => hostId.id,
      getEndpoints: () => [],
    })
    await waitFor(() => host.isAttached())

    let evilState = ''
    const evil = new WsFederationClient({
      serverUrl: baseUrl,
      credentialToken: '',
      officeId: 'office-interop-spoof',
      makeAuthProof: (nonce) => makeProof(evilId, nonce),
      onFrame: () => {},
      onStateChange: (state) => {
        evilState = state
      },
    })
    await waitFor(() => evilState === 'open')

    // fromNode forged as the HOST's identity: the gateway must drop it.
    evil.send({
      kind: 'join-request',
      officeId: 'office-interop-spoof',
      fromNode: hostId.id,
      identityId: hostId.id,
      credentialToken: '',
      bringMembers: [],
    })
    // An honest frame afterwards still arrives — proving the drop was selective.
    evil.send({
      kind: 'join-request',
      officeId: 'office-interop-spoof',
      fromNode: evilId.id,
      identityId: evilId.id,
      credentialToken: '',
      bringMembers: [],
    })
    await waitFor(() => hostInbound.some((f) => f.kind === 'join-request'))
    const kinds = hostInbound.filter((f) => f.kind === 'join-request')
    expect(kinds).toHaveLength(1)
    expect((kinds[0] as { fromNode?: string }).fromNode).toBe(evilId.id)

    evil.close()
    host.close()
  }, 30_000)

  it('forwards a HOST-relayed frame that carries another node fromNode (relay exemption)', async () => {
    // Regression for the field bug: history/artifact fetch is relayed by the host
    // one hop to the true owner and PRESERVES the original requester's fromNode
    // (needed for the scope seam), which is never the host's own identity. The
    // edge assertion must exempt the trusted host hub, or these relayed frames are
    // dropped and cross-member history/artifact reads hang. A member is still
    // constrained (proven by the spoof test above).
    const officeId = 'office-interop-relay-exempt'
    const hostId = makeIdentity()
    const memberId = makeIdentity()
    const requesterId = makeIdentity() // the original requester, a third node

    const hostInbound: FederationMessage[] = []
    const host = new GatewayAttachClient({
      gatewayUrl: baseUrl,
      officeId,
      makeAuthProof: (nonce) => makeProof(hostId, nonce),
      onFrame: (frame) => hostInbound.push(frame),
      getIdentityId: () => hostId.id,
      getEndpoints: () => [],
    })
    await waitFor(() => host.isAttached())

    const memberInbound: FederationMessage[] = []
    let memberState = ''
    const member = new WsFederationClient({
      serverUrl: baseUrl,
      credentialToken: 'opaque-invite-token',
      officeId,
      makeAuthProof: (nonce) => makeProof(memberId, nonce),
      onFrame: (frame) => memberInbound.push(frame),
      onStateChange: (state) => {
        memberState = state
      },
    })
    await waitFor(() => memberState === 'open')

    member.send({
      kind: 'join-request',
      officeId,
      fromNode: memberId.id,
      identityId: memberId.id,
      credentialToken: 'opaque-invite-token',
      bringMembers: [],
    })
    await waitFor(() => hostInbound.some((f) => f.kind === 'join-request'))
    host.send(memberId.id, { kind: 'join-grant', officeId, assignedNodeId: memberId.id })
    await waitFor(() => memberInbound.some((f) => f.kind === 'join-grant'))

    // Host relays a frame to the member on behalf of a THIRD node: fromNode is the
    // requester's, not the host's. (heartbeat is a payload-agnostic stand-in for a
    // relayed history-request — the gateway only reads kind + fromNode + officeId.)
    host.send(memberId.id, {
      kind: 'heartbeat',
      officeId,
      fromNode: requesterId.id,
      ts: Date.now(),
    })
    await waitFor(() => memberInbound.some((f) => f.kind === 'heartbeat'))
    const relayed = memberInbound.find((f) => f.kind === 'heartbeat')!
    expect((relayed as { fromNode?: string }).fromNode).toBe(requesterId.id)

    member.close()
    host.close()
  }, 30_000)

  it('presence stays mutually ONLINE across the relay (reproduces the two-machine field test)', async () => {
    // Two REAL federation managers — a host and a joiner — talk exclusively
    // through the real Go gateway, exactly like the two-machine setup. After
    // well past the confirmed-offline threshold (13s), BOTH sides must still
    // see each other online: heartbeats must flow host→member and member→host
    // through the relay.
    const officeId = 'office-presence-relay'
    const hostId = makeIdentity()
    const memberId = makeIdentity()
    const TOKEN = 'relay-presence-token'

    function makeNode(identity: TestIdentity) {
      const dbm = createDatabaseManager(':memory:')
      const db = dbm.getAppDatabase()
      dbm.runMigrations(db, FED_NS, fedMigrations)
      dbm.runMigrations(db, TEAM_NS, teamMigrations)
      const federationStore = new FederationStore(db)
      const teamStore = new TeamStore(db)
      const authorityStore = new AuthorityStore(db)
      const manager = createFederationManager({
        hostSend: () => false,
        hostListOfficeClients: () => [],
        federationStore,
        teamStore,
        authorityStore,
        verifyCredential: (token) => (token === TOKEN ? { officeId } : null),
        getLocalNodeId: () => identity.id,
        getGatewayUrl: () => baseUrl,
        makeAuthProof: (nonce) => makeProof(identity, nonce),
      })
      return { dbm, federationStore, teamStore, manager }
    }

    const hostNode = makeNode(hostId)
    const memberNode = makeNode(memberId)
    // The hosted office's team row must exist for roster snapshots.
    hostNode.teamStore.insertTeam({
      id: officeId,
      name: 'Relay Office',
      owningSpaceId: 'space-host',
      goal: '',
      leadAppId: null,
      memberSourcing: 'manual',
      collabMode: 'structured',
      escalationRouting: 'lead',
      status: 'idle',
      currentEpochId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Parameters<TeamStore['insertTeam']>[0])

    try {
      hostNode.manager.hostOffice(officeId)
      const joined = await memberNode.manager.joinOffice({
        officeId,
        serverUrl: baseUrl,
        credentialToken: TOKEN,
        selfContext: { officeId, selfNodeId: memberId.id },
        bringMembers: [{ appId: 'app-m-1', memberName: 'relay-writer' }],
      })
      expect(joined.ok).toBe(true)

      // Ride out the full suspect (6s) + confirmed-offline (13s) window.
      await new Promise((r) => setTimeout(r, 16_000))

      const hostViewOfMember = hostNode.federationStore.getNode(officeId, memberId.id)
      const memberViewOfHost = memberNode.federationStore.getNode(officeId, hostId.id)
      expect(hostViewOfMember?.status).toBe('online')
      expect(memberViewOfHost?.status).toBe('online')
    } finally {
      hostNode.manager.stopAll()
      memberNode.manager.stopAll()
      hostNode.dbm.closeAll()
      memberNode.dbm.closeAll()
    }
  }, 60_000)
})
