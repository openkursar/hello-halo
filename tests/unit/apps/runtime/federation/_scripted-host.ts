/**
 * Shared test helper: one joiner FederationManager on this build, joined over a
 * REAL ws socket to a scripted host that speaks only the frames every build on
 * this protocol version exchanges.
 *
 * The host grants every join it receives, projects the roster it is told to
 * (`host.members`), and records every frame the joiner sends. It runs no host
 * logic of its own, so whatever reaches it is exactly what the joiner sent —
 * which is what a host on an earlier build would get.
 */

import http from 'http'
import { expect } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { migrations as teamMigrations, MIGRATION_NAMESPACE as TEAM_NS } from '../../../../../src/main/apps/team/migrations'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { FeedStore } from '../../../../../src/main/apps/federation/feed-store'
import { migrations as federationMigrations, MIGRATION_NAMESPACE as FED_NS } from '../../../../../src/main/apps/federation/migrations'
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import type { FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/shared/federation/protocol-version'
import type { FederationMessage, JoinMember, RosterMemberSnap } from '../../../../../src/main/apps/runtime/federation/types'

export const SCRIPTED_OFFICE = 'office-scripted'
export const SCRIPTED_HOST = 'node-host'
export const SCRIPTED_SELF = 'node-self'
export const SCRIPTED_LEAD = 'app-host-lead'

export async function waitFor(predicate: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

export const bring = (appId: string): JoinMember => ({ appId, memberName: appId, role: '', spaceId: `space-${appId}` })

/** A roster row; `owner` is SCRIPTED_SELF for the joiner's own members. */
export function snap(appId: string, owner: string, duty: string | null = null): RosterMemberSnap {
  return {
    appId,
    memberName: appId,
    role: '',
    duty,
    isLead: appId === SCRIPTED_LEAD,
    ownerNodeId: owner,
    memberIdentity: owner === SCRIPTED_SELF ? SCRIPTED_SELF : SCRIPTED_HOST,
    ownerDisplayName: owner === SCRIPTED_SELF ? 'Me' : 'Host',
  }
}

export type ScriptedHostOffice = Awaited<ReturnType<typeof startScriptedHostOffice>>

/** Join `brought` (each with `duty` on the host's first roster, if given) and wait for the roster. */
export async function startScriptedHostOffice(brought: string[], opts: { duty?: (appId: string) => string | null } = {}) {
  const db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), TEAM_NS, teamMigrations)
  db.runMigrations(db.getAppDatabase(), FED_NS, federationMigrations)
  const teamStore = new TeamStore(db.getAppDatabase())
  const federationStore = new FederationStore(db.getAppDatabase())

  // The roster the host projects on its next join answer or explicit send.
  const host = {
    members: [snap(SCRIPTED_LEAD, SCRIPTED_HOST), ...brought.map((id) => snap(id, SCRIPTED_SELF, opts.duty?.(id) ?? null))],
    outgoing: [] as FederationMessage[],
    rosterVersion: 0,
  }
  const server = http.createServer()
  const wss = new WebSocketServer({ server, path: '/ws' })
  let socket: WebSocket | undefined
  const send = (frame: FederationMessage) => socket?.send(JSON.stringify({ type: 'federation', payload: frame }))
  const sendRoster = () =>
    send({
      kind: 'roster',
      officeId: SCRIPTED_OFFICE,
      version: ++host.rosterVersion,
      snapshot: {
        team: { id: SCRIPTED_OFFICE, name: 'Release', goal: 'Ship', leadAppId: SCRIPTED_LEAD, collabMode: 'free', hostNodeId: SCRIPTED_HOST },
        members: host.members,
        edges: [],
      },
    })
  wss.on('connection', (client) => {
    socket = client
    client.on('message', (bytes) => {
      const msg = JSON.parse(bytes.toString())
      if (msg.type === 'auth') client.send(JSON.stringify({ type: 'auth:success' }))
      if (msg.type !== 'federation') return
      host.outgoing.push(msg.payload)
      if (msg.payload.kind === 'join-request') {
        send({ kind: 'join-grant', officeId: SCRIPTED_OFFICE, assignedNodeId: SCRIPTED_SELF, pv: FEDERATION_PROTOCOL_VERSION })
        sendRoster()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const removed: Array<{ appId: string; ownMember: boolean }> = []
  const manager: FederationManager = createFederationManager({
    teamStore,
    federationStore,
    feedStore: new FeedStore(db.getAppDatabase()),
    hostSend: () => false,
    hostListOfficeClients: () => [],
    getLocalNodeId: () => SCRIPTED_SELF,
    verifyCredential: () => null,
    onMemberRemovedRemote: (_officeId, appId, ownMember) => removed.push({ appId, ownMember }),
    // What bootstrap does with it: publish the owner's profile, as any duty edit does.
    onDutiesRestored: (officeId, appIds) => {
      for (const appId of appIds) {
        const member = teamStore.getMember(officeId, appId)
        if (!member) continue
        manager.routeOfficeStateWrite(officeId, 'member_profile', {
          teamId: officeId,
          appId,
          duty: member.duty ?? null,
          acceptsChecks: member.acceptsChecks !== false,
          awaitingDecision: member.awaitingDecision === true,
        })
      }
    },
  })

  const join = async (appIds: string[]) => {
    const result = await manager.joinOffice({
      officeId: SCRIPTED_OFFICE,
      serverUrl,
      credentialToken: 'invite-token',
      selfContext: { officeId: SCRIPTED_OFFICE, selfNodeId: SCRIPTED_SELF },
      bringMembers: appIds.map(bring),
    })
    expect(result.ok).toBe(true)
  }
  await join(brought)
  await waitFor(() => teamStore.listMembersByTeam(SCRIPTED_OFFICE).length === host.members.length)

  return {
    manager,
    teamStore,
    federationStore,
    host,
    removed,
    join,
    send,
    sendRoster,
    /** The host's roster drops these members and the host says so, as a kick or an applied leave does. */
    removeOnHost(appIds: string[]) {
      host.members = host.members.filter((m) => !appIds.includes(m.appId))
      for (const appId of appIds) {
        send({ kind: 'member-removed', officeId: SCRIPTED_OFFICE, fromNode: SCRIPTED_HOST, term: 0, appId, fid: `removed-${appId}` })
      }
      sendRoster()
    },
    dropConnection: () => { for (const client of wss.clients) client.terminate() },
    record: () => federationStore.listJoinedOfficeConnections().find((c) => c.officeId === SCRIPTED_OFFICE),
    sent: <K extends FederationMessage['kind']>(kind: K) =>
      host.outgoing.filter((f): f is Extract<FederationMessage, { kind: K }> => f.kind === kind),
    async close() {
      manager.stopAll()
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.closeAll()
    },
  }
}
