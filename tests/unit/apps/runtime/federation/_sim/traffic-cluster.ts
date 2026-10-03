/**
 * An N-node office of REAL FederationManagers (host + joiners, each with its own
 * SQLite stores) over a deterministic in-process bus that accounts every frame
 * a node receives: bytes and frames per plane and per frame kind, keyed the way
 * the joiner's link health line reports them (`rx=` / `rxKinds=`). Timers run on
 * vitest fake timers, so the 2 s heartbeat, 750 ms roster refresh, 5 s feed tick,
 * 30 s re-announce and 10 min digest resend all fire instantly.
 *
 * Traffic bounds are asserted against this during development; the real-process
 * `npm run test:team -- scale` suite confirms them at release time.
 */

import { vi } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../../src/main/apps/federation/store'
import { AuthorityStore } from '../../../../../../src/main/apps/federation/authority-store'
import { FeedStore } from '../../../../../../src/main/apps/federation/feed-store'
import { MIGRATION_NAMESPACE as FED_NS, migrations as fedMigrations } from '../../../../../../src/main/apps/federation/migrations'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../../src/main/apps/federation/types'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE as TEAM_NS, migrations as teamMigrations } from '../../../../../../src/main/apps/team/migrations'
import { createFederationManager, type FederationManager } from '../../../../../../src/main/apps/runtime/federation/manager'
import { WsFederationClient } from '../../../../../../src/main/apps/runtime/federation/ws-federation-client'
import { framePlane, type FederationMessage, type StreamFramesFrame } from '../../../../../../src/main/apps/runtime/federation/types'
import type { SerializedHistoryMessage } from '../../../../../../src/main/apps/runtime/federation/protocol-m2'
import { buildTeamSessionKey } from '../../../../../../src/shared/apps/im-keys'
import type { TeamMemberRuntimeStatus } from '../../../../../../src/shared/apps/team-types'

export const SIM_OFFICE = 'office-traffic'
export const SIM_EPOCH = 'epoch-traffic'
const TOKEN = 'valid'

export interface Tally {
  frames: number
  bytes: number
}

/** What one node received: by plane, and by kind (`<plane>.<kind>` outside control). */
export interface Received {
  planes: Record<string, Tally>
  kinds: Record<string, Tally>
}

export interface SimNode {
  id: string
  appId: string
  dbm: DatabaseManager
  team: TeamStore
  manager: FederationManager
  /** This node's own members' transcripts, by session key. */
  transcripts: Map<string, SerializedHistoryMessage[]>
  rx: Received
}

export interface TrafficCluster {
  host: SimNode
  joiners: SimNode[]
  /** Run-state the host projects for each member (drives `member-status`). */
  runtimeStatus: Map<string, TeamMemberRuntimeStatus>
  /** Joiners whose socket counts as backed up (they receive reduced droppable frames). */
  slow: Set<string>
  /** Every frame received by the nodes listed in `capture`, for content assertions. */
  capture: Set<string>
  captured: Map<string, FederationMessage[]>
  sessionKey(appId: string): string
  /**
   * `node` owns `appId`: append one message to its transcript and relay its live
   * frames. `turn` wraps them in the turn's lifecycle events (start, complete).
   */
  speak(appId: string, text: string, opts?: { deltas?: number; turn?: boolean }): void
  /** A board row the host (authority) records: `actor` messaged `target`. */
  recordMessage(actorAppId: string, targetAppId: string): void
  /** A viewer on `node` shows these sessions. */
  watch(node: SimNode, sessionKeys: string[]): void
  advance(ms: number): void
  /** The node's process dies: it sends and receives nothing any more. */
  kill(node: SimNode): void
  /**
   * The host is gone: advance until the survivors elect one of themselves over
   * the real presence FSM and election, and return the winner.
   */
  electAfterHostLoss(): SimNode
  snapshot(): Map<string, Received>
  dispose(): void
}

function emptyReceived(): Received {
  return { planes: {}, kinds: {} }
}

function add(map: Record<string, Tally>, key: string, bytes: number): void {
  const t = (map[key] ??= { frames: 0, bytes: 0 })
  t.frames += 1
  t.bytes += bytes
}

function account(rx: Received, frame: FederationMessage, bytes: number): void {
  const plane = framePlane(frame)
  add(rx.planes, plane, bytes)
  add(rx.kinds, plane === 'control' ? frame.kind : `${plane}.${frame.kind}`, bytes)
}

function wireBytes(frame: FederationMessage): number {
  return JSON.stringify({ type: 'federation', payload: frame }).length
}

export function cloneReceived(rx: Received): Received {
  return JSON.parse(JSON.stringify(rx)) as Received
}

/** Growth of `after` over `before`, as { kind: Tally }. */
export function kindGrowth(before: Received, after: Received): Record<string, Tally> {
  const out: Record<string, Tally> = {}
  for (const [kind, t] of Object.entries(after.kinds)) {
    const b = before.kinds[kind] ?? { frames: 0, bytes: 0 }
    if (t.frames > b.frames) out[kind] = { frames: t.frames - b.frames, bytes: t.bytes - b.bytes }
  }
  return out
}

export function planeGrowth(before: Received, after: Received, plane: string): Tally {
  const a = after.planes[plane] ?? { frames: 0, bytes: 0 }
  const b = before.planes[plane] ?? { frames: 0, bytes: 0 }
  return { frames: a.frames - b.frames, bytes: a.bytes - b.bytes }
}

export function buildTrafficCluster(joinerCount: number): TrafficCluster {
  vi.spyOn(WsFederationClient.prototype as unknown as { connect: () => void }, 'connect').mockImplementation(() => {})
  // Presence silence is measured on the monotonic clock, which fake timers leave running in real time.
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  const runtimeStatus = new Map<string, TeamMemberRuntimeStatus>()
  const slow = new Set<string>()
  const capture = new Set<string>()
  const captured = new Map<string, FederationMessage[]>()
  const nodes = new Map<string, SimNode>()
  const dead = new Set<string>()
  // `viaServer`: the frame arrives on the target's WS server as from a client
  // that dialed it (a survivor's leg to a peer, or to an elected authority).
  const route = (to: string, from: string, frame: FederationMessage, viaServer = false): void => {
    const target = nodes.get(to)
    if (!target || dead.has(to) || dead.has(from)) return
    // Frames cross a real wire as JSON: nothing may alias sender state.
    const wire = JSON.parse(JSON.stringify(frame)) as FederationMessage
    account(target.rx, wire, wireBytes(wire))
    if (capture.has(to)) {
      const list = captured.get(to) ?? []
      list.push(wire)
      captured.set(to, list)
    }
    if (viaServer || target.manager.listHostedOffices().includes(SIM_OFFICE)) {
      target.manager.handleHostInbound({ clientId: from, officeId: SIM_OFFICE, frame: wire })
    } else {
      target.manager.deliverInbound(SIM_OFFICE, wire, from)
    }
  }

  function buildNode(id: string, appId: string): SimNode {
    const dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, FED_NS, fedMigrations)
    dbm.runMigrations(db, TEAM_NS, teamMigrations)
    const team = new TeamStore(db)
    const transcripts = new Map<string, SerializedHistoryMessage[]>()
    const node: SimNode = { id, appId, dbm, team, transcripts, rx: emptyReceived(), manager: undefined as unknown as FederationManager }
    const joinerIds = () => [...nodes.keys()].filter((n) => n !== id)
    node.manager = createFederationManager({
      hostSend: (clientId, frame) => {
        route(clientId, id, frame)
        return true
      },
      hostSendMany: (clientIds, frame, opts) => {
        const shed: string[] = []
        for (const clientId of clientIds) {
          if (opts.droppable && slow.has(clientId)) {
            shed.push(clientId)
            const reduced = opts.degrade?.() ?? null
            if (reduced) route(clientId, id, reduced)
            continue
          }
          route(clientId, id, frame)
        }
        return shed
      },
      hostListOfficeClients: () => joinerIds(),
      getSessionIdentity: (clientId) => clientId,
      federationStore: new FederationStore(db),
      teamStore: team,
      authorityStore: new AuthorityStore(db),
      feedStore: new FeedStore(db),
      verifyCredential: (tok) => (tok === TOKEN ? { officeId: SIM_OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null),
      getLocalNodeId: () => id,
      getLocalDisplayName: () => id,
      getMemberRuntimeStatus: (member) => runtimeStatus.get(member) ?? 'idle',
      getCurrentRunEpoch: () => ({ teamId: SIM_OFFICE, epochId: SIM_EPOCH }),
      getOwnerStatus: () => 'idle',
      applyMemberWrite: () => {},
      reassignTask: () => {},
      peerDialer: (_officeId, peer) => (nodes.has(peer) ? { sender: (_to, frame) => route(peer, id, frame, true) } : null),
      readOwnedTranscript: (_teamId, member, epochId) =>
        transcripts.get(buildTeamSessionKey(member, SIM_OFFICE, epochId)) ?? null,
      isSessionActive: () => false,
      runLocalTurn: async () => ({ finalMessage: null }),
    })
    nodes.set(id, node)
    return node
  }

  // ── Host office ──
  const host = buildNode('node-host', 'app-host')
  const t0 = Date.now()
  host.team.insertTeam({
    id: SIM_OFFICE, name: 'traffic office', owningSpaceId: 'space-host', goal: 'g', leadAppId: null,
    memberSourcing: 'manual', collabMode: 'structured', escalationRouting: 'user', status: 'running',
    currentEpochId: SIM_EPOCH, createdAt: t0, updatedAt: t0,
  })
  host.team.addMember({ teamId: SIM_OFFICE, appId: 'app-host', memberName: 'host member', role: 'r', isLead: true, aiProvisioned: false, addedAt: t0 })
  host.manager.hostOffice(SIM_OFFICE)

  // ── Joiners, joined over the bus ──
  const joiners: SimNode[] = []
  for (let i = 1; i <= joinerCount; i++) {
    const j = buildNode(`node-j${i}`, `app-j${i}`)
    joiners.push(j)
    j.team.insertTeam({
      id: SIM_OFFICE, name: 'traffic office', owningSpaceId: `space-j${i}`, goal: 'g', leadAppId: null,
      memberSourcing: 'manual', collabMode: 'structured', escalationRouting: 'user', status: 'idle',
      currentEpochId: null, createdAt: t0, updatedAt: t0, hostNodeId: host.id,
    })
    void j.manager.joinOffice({
      officeId: SIM_OFFICE,
      serverUrl: 'ws://127.0.0.1:9/ws',
      credentialToken: TOKEN,
      selfContext: { officeId: SIM_OFFICE, selfNodeId: j.id },
      bringMembers: [{ appId: j.appId, memberName: `member ${i}`, role: 'r', spaceId: `space-j${i}` }],
    })
    j.manager.repointLink(SIM_OFFICE, (_to, frame) => route(host.id, j.id, frame))
    j.manager.reenrollWithAuthority(SIM_OFFICE)
  }

  const ownerOf = (appId: string): SimNode => [host, ...joiners].find((n) => n.appId === appId)!
  const sessionKey = (appId: string) => buildTeamSessionKey(appId, SIM_OFFICE, SIM_EPOCH)
  const streamSeq = new Map<string, number>()

  return {
    host,
    joiners,
    runtimeStatus,
    slow,
    capture,
    captured,
    sessionKey,
    speak(appId, text, opts) {
      const owner = ownerOf(appId)
      const key = sessionKey(appId)
      const rows = owner.transcripts.get(key) ?? []
      rows.push({ seq: rows.length + 1, role: 'assistant', content: text })
      owner.transcripts.set(key, rows)
      const frames: StreamFramesFrame['frames'] = []
      const next = () => {
        const seq = (streamSeq.get(key) ?? 0) + 1
        streamSeq.set(key, seq)
        return seq
      }
      if (opts?.turn) frames.push({ seq: next(), kind: 'milestone', channel: 'agent:turn-start', spaceId: 's', payload: {} })
      for (let d = 0; d < (opts?.deltas ?? 0); d++) {
        frames.push({ seq: next(), kind: 'incremental', channel: 'agent:thought-delta', spaceId: 's', payload: { delta: 'thinking…' } })
      }
      frames.push({ seq: next(), kind: 'milestone', channel: 'agent:message', spaceId: 's', payload: { delta: text } })
      if (opts?.turn) frames.push({ seq: next(), kind: 'milestone', channel: 'agent:complete', spaceId: 's', payload: {} })
      owner.manager.relaySink(SIM_OFFICE, { kind: 'stream-frames', officeId: SIM_OFFICE, sessionKey: key, baseSeq: frames[0].seq, frames, originRun: 'run-1' })
    },
    recordMessage(actorAppId, targetAppId) {
      const id = `act-${actorAppId}-${targetAppId}-${Math.random().toString(36).slice(2)}`
      const activity = {
        id, teamId: SIM_OFFICE, epochId: SIM_EPOCH, kind: 'message', actorAppId, targetAppId,
        subject: 'hello', body: null, refId: null, correlationId: null, status: 'sent', createdAt: Date.now(),
      }
      host.team.insertActivity(activity as never)
      host.manager.routeAuthorityWrite({ teamId: SIM_OFFICE, epochId: SIM_EPOCH, op: 'post_activity', payload: activity })
    },
    watch(node, sessionKeys) {
      node.manager.setWatchedSessions(new Set(sessionKeys))
    },
    advance(ms) {
      vi.advanceTimersByTime(ms)
    },
    kill(node) {
      dead.add(node.id)
      node.manager.stopAll()
    },
    electAfterHostLoss() {
      if (!dead.has(host.id)) throw new Error('kill the host first')
      for (let waited = 0; waited < 120_000; waited += 1_000) {
        vi.advanceTimersByTime(1_000)
        const winner = joiners.find((j) => !dead.has(j.id) && j.manager.getOfficeAuthority(SIM_OFFICE)?.isAuthoritySelf())
        if (winner) {
          // Let the survivors re-form around it (redial, re-enroll).
          vi.advanceTimersByTime(5_000)
          return winner
        }
      }
      throw new Error('no survivor was elected within 120 s')
    },
    snapshot() {
      return new Map([...nodes].map(([id, n]) => [id, cloneReceived(n.rx)]))
    },
    dispose() {
      for (const n of nodes.values()) {
        n.manager.stopAll()
        n.dbm.closeAll()
      }
    },
  }
}
