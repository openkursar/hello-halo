/**
 * Unit tests for apps/runtime/federation -- GatewayAttachClient.
 *
 * A local fake gateway (real `ws` server) drives the full host attachment:
 * two-leg auth → gw:host-attach → gw:attached, addressed sends (unicast +
 * broadcast), inbound relayed frames, reconnect + re-attach after a
 * server-side drop, and the §9.3 gw:announce whose signature payload must be
 * byte-exact (verified with a real Ed25519 keypair, the same primitive the
 * device key uses).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'crypto'

import {
  GatewayAttachClient,
  buildAnnounceSigPayload,
} from '../../../../../src/main/apps/runtime/federation/gateway-attach'
import type { FederationMessage } from '../../../../../src/main/apps/runtime/federation/types'
import { startFakeGateway, waitFor, type FakeGateway } from './_fake-gateway'

const OFFICE = 'office-gw-1'
const IDENTITY = 'id_test-node-identity'

/** Any control-plane frame; the client treats payloads as opaque. */
function heartbeat(): FederationMessage {
  return { kind: 'heartbeat', officeId: OFFICE, fromNode: IDENTITY, ts: Date.now() } as FederationMessage
}

describe('GatewayAttachClient (fake gateway over real ws)', () => {
  let gateway: FakeGateway
  let client: GatewayAttachClient | null = null

  afterEach(async () => {
    client?.close()
    client = null
    await gateway?.close()
  })

  function makeClient(extra: Partial<ConstructorParameters<typeof GatewayAttachClient>[0]> = {}) {
    const received: FederationMessage[] = []
    const states: string[] = []
    client = new GatewayAttachClient({
      gatewayUrl: gateway.url,
      officeId: OFFICE,
      makeAuthProof: (nonce) => ({ method: 'device-key', identityId: IDENTITY, challenge: nonce }),
      onFrame: (frame) => received.push(frame),
      onStateChange: (state) => states.push(state),
      ...extra,
    })
    return { client, received, states }
  }

  it('authenticates, attaches, and exchanges addressed frames both ways', async () => {
    gateway = await startFakeGateway()
    const { received } = makeClient()

    await waitFor(() => client!.isAttached())
    expect(gateway.attachCount()).toBe(1)
    // The auth proof answered the challenge (leg 2 carried it).
    expect(gateway.authProofs[0]).toMatchObject({ identityId: IDENTITY })

    // Unicast + broadcast addressed sends.
    client!.send('node-x', heartbeat())
    client!.send(null, heartbeat())
    await waitFor(() => gateway.hostFrames.length >= 2)
    expect(gateway.hostFrames[0].to).toBe('node-x')
    expect(gateway.hostFrames[0].payload).toMatchObject({ kind: 'heartbeat', officeId: OFFICE })
    expect(gateway.hostFrames[1].to).toBeNull()

    // Inbound relayed member frame reaches onFrame.
    gateway.relayToHost({ kind: 'heartbeat', officeId: OFFICE, fromNode: 'node-member' })
    await waitFor(() => received.length >= 1)
    expect(received[0]).toMatchObject({ kind: 'heartbeat', fromNode: 'node-member' })
  })

  it('queues frames sent before attach and flushes them after', async () => {
    gateway = await startFakeGateway()
    makeClient()

    // Sent immediately — the client is still connecting/authing.
    client!.send('node-early', heartbeat())
    await waitFor(() => gateway.hostFrames.length >= 1)
    expect(client!.isAttached()).toBe(true)
    expect(gateway.hostFrames[0].to).toBe('node-early')
  })

  it('reconnects and re-attaches after a server-side drop', async () => {
    gateway = await startFakeGateway()
    makeClient()
    await waitFor(() => client!.isAttached())
    expect(gateway.attachCount()).toBe(1)

    gateway.dropHost()
    await waitFor(() => !client!.isAttached(), 1000)
    // Backoff leg 1 is 1s; allow comfortably more.
    await waitFor(() => gateway.attachCount() >= 2, 6000)
    expect(gateway.attachCount()).toBe(2)
    expect(client!.isAttached()).toBe(true)

    // The re-attached session still routes addressed sends.
    client!.send('node-after', heartbeat())
    await waitFor(() => gateway.hostFrames.length >= 1)
    expect(gateway.hostFrames.at(-1)!.to).toBe('node-after')
  })

  it('publishes a gw:announce whose signature payload is byte-exact (§9.3)', async () => {
    gateway = await startFakeGateway()
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const endpoints = ['http://192.168.1.10:3017', 'https://alt.example.com']

    makeClient({
      signAnnounce: (payload) => edSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
      getIdentityId: () => IDENTITY,
      getEndpoints: () => endpoints,
      getDisplayName: () => 'Test Host',
    })

    await waitFor(() => gateway.announces.length >= 1)
    const announce = gateway.announces[0]
    expect(announce.endpoints).toEqual(endpoints)
    expect(announce.displayName).toBe('Test Host')
    expect(typeof announce.ts).toBe('number')

    // Reconstruct the exact §9.3 payload from the wire fields and verify the
    // Ed25519 signature — proving both the payload byte layout and that the
    // client signed exactly that string.
    const expectedPayload = `halo-gw-announce\n${OFFICE}\n${IDENTITY}\n${announce.ts}\n${endpoints.join('\n')}`
    expect(buildAnnounceSigPayload(OFFICE, IDENTITY, announce.ts, endpoints)).toBe(expectedPayload)
    const ok = edVerify(
      null,
      Buffer.from(expectedPayload, 'utf8'),
      publicKey,
      Buffer.from(announce.sig, 'base64')
    )
    expect(ok).toBe(true)
  })

  it('skips the announce when no endpoints are advertised', async () => {
    gateway = await startFakeGateway()
    const { privateKey } = generateKeyPairSync('ed25519')
    makeClient({
      signAnnounce: (payload) => edSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
      getIdentityId: () => IDENTITY,
      getEndpoints: () => [],
    })
    await waitFor(() => client!.isAttached())
    // Give a beat for a (wrong) immediate announce to arrive.
    await new Promise((r) => setTimeout(r, 100))
    expect(gateway.announces).toHaveLength(0)
  })

  it('retries after HOST_CONFLICT and attaches once the room frees up (§9.2)', async () => {
    gateway = await startFakeGateway({ rejectAttaches: 1 })
    const errors: string[] = []
    makeClient({ onGatewayError: (code) => errors.push(code) })

    // First attach is refused; the client reconnects with backoff (leg 1 = 1s)
    // and the second attempt claims the room.
    await waitFor(() => client!.isAttached(), 6000)
    expect(errors).toContain('HOST_CONFLICT')
    expect(gateway.attachCount()).toBe(1)

    client!.send('node-x', heartbeat())
    await waitFor(() => gateway.hostFrames.length >= 1)
    expect(gateway.hostFrames[0].to).toBe('node-x')
  })

  it('sends gw:evict for a node', async () => {
    gateway = await startFakeGateway()
    makeClient()
    await waitFor(() => client!.isAttached())
    client!.evict('node-kicked')
    await waitFor(() => gateway.evictions.length >= 1)
    expect(gateway.evictions[0]).toBe('node-kicked')
  })
})
