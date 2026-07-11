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
 *   - default publication recognition keys off TeamStore findings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createArtifactService,
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
    const assertion = expect(p).rejects.toThrow('timed out')

    expect(viewer.pendingCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(viewer.pendingCount()).toBe(0)
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
    // A published artifact is recognized by a finding carrying its ref.
    store.insertFinding({
      id: 'finding-1',
      teamId: OFFICE,
      epochId: EPOCH,
      authorAppId: 'app-author',
      body: null,
      ref: 'published.md',
      createdAt: ts,
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

    await expect(viewer.fetch(publishedRef('not-published.md'))).rejects.toThrow('artifact-not-published')
  })
})
