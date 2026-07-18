/**
 * Unit tests for apps/runtime/federation/authority -- cross-machine artifact
 * on-demand fetch.
 *
 * Two service instances (owner + viewer) are wired through a fake `send` that
 * routes a frame to the addressed node's `handleM2Frame`, so a viewer `fetch`
 * and the owner's `handleFetch` exchange real `artifact-fetch`/`artifact-bytes`
 * frames in-process. `resolveArtifactBytes` is a fake byte store; publication is
 * controlled per-test (a fake predicate, and once via the default TeamStore
 * findings path) to prove the owner refuses anything not published.
 *
 * Proven:
 *   - round-trip: owner serves a published ref → viewer gets identical bytes;
 *   - unpublished ref → viewer fetch rejects with the owner's error, and the
 *     owner never reads bytes (no resolveArtifactBytes call);
 *   - foreign-office ref → refused the same way;
 *   - large payload survives base64 round-trip byte-for-byte;
 *   - fetch timeout rejects and cleans up the pending entry;
 *   - the local SELF sentinel is not accepted as ownership on the wire;
 *   - default publication recognition keys off TeamStore findings AND task
 *     resultRef deliveries (the two publication forms the team tools promise);
 *   - classifyArtifactFetchFailure maps every rejection code to its category.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createArtifactService,
  classifyArtifactFetchFailure,
  type ArtifactService,
} from '../../../../../../src/main/apps/runtime/federation/authority/artifact-fetch'
import type { ArtifactRef } from '../../../../../../src/main/apps/runtime/federation/protocol-m2'
import type {
  FederationMessage,
  NodeId,
} from '../../../../../../src/main/apps/runtime/federation/types'

import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../../src/main/apps/team/migrations'

const OFFICE = 'office-1'
const OWNER = 'node-owner'
const VIEWER = 'node-viewer'
const EPOCH = 'epoch-1'

/**
 * A two-node bus: each service registers under its node id; `send(to, frame)`
 * delivers to that node's `handleM2Frame`. Mirrors the production artifact plane
 * where the Lead routes onM2Frame into the service.
 */
function makeBus() {
  const nodes = new Map<NodeId, ArtifactService>()
  const send = (to: NodeId, frame: FederationMessage) => {
    const target = nodes.get(to)
    if (!target) return
    // The artifact plane only carries these two kinds.
    if (frame.kind === 'artifact-fetch' || frame.kind === 'artifact-bytes') {
      const from = (frame as { fromNode: NodeId }).fromNode
      target.handleM2Frame(from, frame)
    }
  }
  return { nodes, send }
}

function publishedRef(ref: string): ArtifactRef {
  return { ownerNodeId: OWNER, teamId: OFFICE, epochId: EPOCH, ref }
}

describe('artifact-fetch round-trip', () => {
  it('owner serves a published ref → viewer gets identical bytes', async () => {
    const bus = makeBus()
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 0, 99])

    const owner = createArtifactService({
      officeId: OFFICE,
      selfNodeId: OWNER,
      store: {} as TeamStore,
      send: bus.send,
      isPublishedRef: (r) => r.ref === 'report.md',
      resolveArtifactBytes: async () => bytes,
    })
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: bus.send,
      resolveArtifactBytes: async () => null, // viewer never resolves locally
    })
    bus.nodes.set(OWNER, owner)
    bus.nodes.set(VIEWER, viewer)

    const got = await viewer.fetch(publishedRef('report.md'))
    expect(Array.from(got)).toEqual(Array.from(bytes))
    expect(viewer.pendingCount()).toBe(0)
  })
})

describe('artifact-fetch authorization (AC-6.2)', () => {
  it('rejects an unpublished ref without ever reading bytes', async () => {
    const bus = makeBus()
    const resolve = vi.fn(async () => new Uint8Array([9, 9, 9]))

    const owner = createArtifactService({
      officeId: OFFICE,
      selfNodeId: OWNER,
      store: {} as TeamStore,
      send: bus.send,
      isPublishedRef: () => false,
      resolveArtifactBytes: resolve,
    })
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: bus.send,
      resolveArtifactBytes: async () => null,
    })
    bus.nodes.set(OWNER, owner)
    bus.nodes.set(VIEWER, viewer)

    await expect(viewer.fetch(publishedRef('secret.key'))).rejects.toThrow('artifact-not-published')
    expect(resolve).not.toHaveBeenCalled()
    expect(viewer.pendingCount()).toBe(0)
  })

  it('rejects a ref scoped to a different office', async () => {
    const bus = makeBus()
    const resolve = vi.fn(async () => new Uint8Array([1]))

    const owner = createArtifactService({
      officeId: OFFICE,
      selfNodeId: OWNER,
      store: {} as TeamStore,
      send: bus.send,
      isPublishedRef: () => true, // even "published" must not cross office bounds
      resolveArtifactBytes: resolve,
    })
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: bus.send,
      resolveArtifactBytes: async () => null,
    })
    bus.nodes.set(OWNER, owner)
    bus.nodes.set(VIEWER, viewer)

    const foreign: ArtifactRef = { ownerNodeId: OWNER, teamId: 'other-office', epochId: EPOCH, ref: 'x' }
    await expect(viewer.fetch(foreign)).rejects.toThrow('artifact-not-published')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('replies not-found when a published ref resolves to no bytes', async () => {
    const bus = makeBus()
    const owner = createArtifactService({
      officeId: OFFICE,
      selfNodeId: OWNER,
      store: {} as TeamStore,
      send: bus.send,
      isPublishedRef: () => true,
      resolveArtifactBytes: async () => null, // published but gone on disk
    })
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: bus.send,
      resolveArtifactBytes: async () => null,
    })
    bus.nodes.set(OWNER, owner)
    bus.nodes.set(VIEWER, viewer)

    await expect(viewer.fetch(publishedRef('gone.md'))).rejects.toThrow('artifact-not-found')
  })
})

describe('artifact-fetch large payload fidelity', () => {
  it('round-trips a large binary payload byte-for-byte through base64', async () => {
    const bus = makeBus()
    const big = new Uint8Array(256 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff

    const owner = createArtifactService({
      officeId: OFFICE,
      selfNodeId: OWNER,
      store: {} as TeamStore,
      send: bus.send,
      isPublishedRef: () => true,
      resolveArtifactBytes: async () => big,
    })
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: bus.send,
      resolveArtifactBytes: async () => null,
    })
    bus.nodes.set(OWNER, owner)
    bus.nodes.set(VIEWER, viewer)

    const got = await viewer.fetch(publishedRef('blob.bin'))
    expect(got.length).toBe(big.length)
    expect(Buffer.from(got).equals(Buffer.from(big))).toBe(true)
  })
})

describe('artifact-fetch timeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects and cleans up when the owner never replies', async () => {
    // Viewer points at an owner node that is NOT on the bus → no reply ever.
    const bus = makeBus()
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: bus.send,
      resolveArtifactBytes: async () => null,
      fetchTimeoutMs: 5000,
    })
    bus.nodes.set(VIEWER, viewer)

    const p = viewer.fetch(publishedRef('never.md'))
    const assertion = expect(p).rejects.toThrow('artifact-fetch-timeout')

    expect(viewer.pendingCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(viewer.pendingCount()).toBe(0)
  })
})

describe('artifact-fetch host relay (star topology)', () => {
  const HOST = 'node-host'

  /**
   * Star bus: joiners (viewer + owner) can only reach the HOST — their `send`
   * ignores the addressed node (mirrors the joiner link that always forwards to
   * the host). Only the host addresses peers directly. This is the exact topology
   * a joiner→joiner artifact read must traverse.
   */
  function makeStar() {
    const nodes = new Map<NodeId, ArtifactService>()
    const route = (deliverFrom: NodeId, to: NodeId, frame: FederationMessage) => {
      const target = nodes.get(to)
      if (!target) return
      if (frame.kind === 'artifact-fetch' || frame.kind === 'artifact-bytes') {
        target.handleM2Frame(deliverFrom, frame)
      }
    }
    // A joiner always forwards to the host, whatever `to` says.
    const joinerSend = (self: NodeId) => (_to: NodeId, frame: FederationMessage) => route(self, HOST, frame)
    // The host addresses the requested node directly.
    const hostSend = (to: NodeId, frame: FederationMessage) => route(HOST, to, frame)
    return { nodes, joinerSend, hostSend }
  }

  function wire(reachable: (n: NodeId) => boolean = () => true) {
    const star = makeStar()
    const bytes = new Uint8Array([7, 8, 9, 200, 0, 1])

    const host = createArtifactService({
      officeId: OFFICE,
      selfNodeId: HOST,
      store: {} as TeamStore,
      send: star.hostSend,
      // The host owns nothing here → it can only relay; its own resolve is never hit.
      isPublishedRef: () => true,
      resolveArtifactBytes: async () => null,
      isNodeReachable: reachable,
    })
    const owner = createArtifactService({
      officeId: OFFICE,
      selfNodeId: OWNER,
      store: {} as TeamStore,
      send: star.joinerSend(OWNER),
      isPublishedRef: (r) => r.ref === 'brief.md',
      resolveArtifactBytes: async () => bytes,
    })
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: star.joinerSend(VIEWER),
      resolveArtifactBytes: async () => null,
    })
    star.nodes.set(HOST, host)
    star.nodes.set(OWNER, owner)
    star.nodes.set(VIEWER, viewer)
    return { host, owner, viewer, bytes }
  }

  it('relays a joiner→joiner fetch through the host to the true owner', async () => {
    const { host, viewer, bytes } = wire()
    const got = await viewer.fetch(publishedRef('brief.md'))
    expect(Array.from(got)).toEqual(Array.from(bytes))
    // No dangling pending on either the viewer or the relaying host.
    expect(viewer.pendingCount()).toBe(0)
    expect(host.pendingCount()).toBe(0)
  })

  it('fails fast with owner-unreachable when the owner is offline (no relay round-trip)', async () => {
    const { viewer, host } = wire((n) => n !== OWNER)
    await expect(viewer.fetch(publishedRef('brief.md'))).rejects.toThrow('artifact-owner-unreachable')
    expect(host.pendingCount()).toBe(0)
  })

  it('propagates the owner\u2019s not-published refusal back through the relay', async () => {
    const { viewer } = wire()
    await expect(viewer.fetch(publishedRef('secret.key'))).rejects.toThrow('artifact-not-published')
  })
})

describe('artifact-fetch SELF sentinel on the wire', () => {
  it('refuses a ref whose ownerNodeId is the local SELF sentinel', async () => {
    const bus = makeBus()
    const resolve = vi.fn(async () => new Uint8Array([1]))

    const owner = createArtifactService({
      officeId: OFFICE,
      selfNodeId: OWNER,
      store: {} as TeamStore,
      send: bus.send,
      isPublishedRef: () => true,
      resolveArtifactBytes: resolve,
    })
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: bus.send,
      resolveArtifactBytes: async () => null,
    })
    bus.nodes.set(OWNER, owner)
    bus.nodes.set(VIEWER, viewer)
    // Deliver the mis-addressed frame to a real peer (the wire always lands
    // somewhere concrete even when the ref carries the SELF sentinel).
    bus.nodes.set('SELF', owner)

    // A wire frame must name a real owner node; SELF only means "local" inside
    // one process and must never be honored as ownership by a peer.
    const selfRef: ArtifactRef = { ownerNodeId: 'SELF', teamId: OFFICE, epochId: EPOCH, ref: 'x.md' }
    await expect(viewer.fetch(selfRef)).rejects.toThrow('artifact-not-published')
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('classifyArtifactFetchFailure', () => {
  it('maps each rejection code to its category', () => {
    expect(classifyArtifactFetchFailure('artifact-owner-unreachable')).toBe('owner-unreachable')
    expect(classifyArtifactFetchFailure('artifact-relay-failed')).toBe('owner-unreachable')
    expect(classifyArtifactFetchFailure('artifact-fetch-timeout after 15000ms')).toBe('owner-unreachable')
    expect(classifyArtifactFetchFailure('artifact-not-published')).toBe('not-published')
    expect(classifyArtifactFetchFailure('artifact-not-found')).toBe('not-found')
    expect(classifyArtifactFetchFailure('socket hang up')).toBe('error')
  })
})

describe('artifact-fetch default publication recognition (TeamStore findings)', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    store = new TeamStore(db)

    const ts = Date.now()
    store.insertTeam({
      id: OFFICE,
      name: 'Office 1',
      owningSpaceId: 'space-1',
      goal: 'g',
      leadAppId: null,
      memberSourcing: 'manual',
      collabMode: 'free',
      escalationRouting: 'lead',
      status: 'active',
      currentEpochId: EPOCH,
      createdAt: ts,
      updatedAt: ts,
    })
    store.insertEpoch({
      id: EPOCH,
      teamId: OFFICE,
      startedAt: ts,
      endedAt: null,
      endReason: null,
      summary: null,
      lifecycle: 'run',
    })
    // A published artifact is recognized by a finding carrying its ref...
    store.insertFinding({
      id: 'finding-1',
      teamId: OFFICE,
      epochId: EPOCH,
      authorAppId: 'app-author',
      body: null,
      ref: 'published.md',
      createdAt: ts,
    })
    // ...or by a task delivering it as resultRef (no finding needed).
    store.insertTask({
      id: 'task-1',
      teamId: OFFICE,
      epochId: EPOCH,
      title: 'Produce the report',
      assigneeAppId: 'app-author',
      status: 'done',
      resultRef: 'delivered.md',
      note: null,
      parentId: null,
      createdByAppId: 'app-lead',
      createdAt: ts,
      updatedAt: ts,
    })
  })

  afterEach(() => dbManager.closeAll())

  it('serves a finding-backed ref and refuses an unknown ref', async () => {
    const bus = makeBus()
    const bytes = new Uint8Array([42, 43, 44])

    const owner = createArtifactService({
      officeId: OFFICE,
      selfNodeId: OWNER,
      store,
      send: bus.send,
      // no isPublishedRef → default findings-backed recognition
      resolveArtifactBytes: async () => bytes,
    })
    const viewer = createArtifactService({
      officeId: OFFICE,
      selfNodeId: VIEWER,
      store: {} as TeamStore,
      send: bus.send,
      resolveArtifactBytes: async () => null,
    })
    bus.nodes.set(OWNER, owner)
    bus.nodes.set(VIEWER, viewer)

    const got = await viewer.fetch(publishedRef('published.md'))
    expect(Array.from(got)).toEqual([42, 43, 44])

    const viaResultRef = await viewer.fetch(publishedRef('delivered.md'))
    expect(Array.from(viaResultRef)).toEqual([42, 43, 44])

    await expect(viewer.fetch(publishedRef('not-published.md'))).rejects.toThrow('artifact-not-published')
  })
})
