/**
 * Team-invite controller — shared business logic for minting and revoking an
 * office-member invite, used by both the IPC handler and the HTTP route so the
 * two surfaces cannot drift.
 *
 * An office maps 1:1 to a team (officeId === teamId). The invite is a bearer
 * office credential issued into a plain http(s) URL; the joiner app parses the
 * `office` + `invite` query params and connects its federation client to the
 * lanUrl origin. The credential's `identity` is a placeholder at issue time by
 * design (a shareable link cannot know its future holder); the joiner's REAL
 * identity is proven at the WS auth handshake (device-key challenge–response)
 * and bound to the session, which the host asserts on every inbound frame.
 */

import { getTeamStore } from '../apps/team'
import { getAppManager } from '../apps/manager'
import { getFederationManager } from '../apps/runtime/federation/manager'
import { getLocalIdentity } from '../http/identity/index'
import {
  issueOfficeCredential,
  revokeOfficeCredential,
  findReusableOfficeCredential,
} from '../http/auth/office-credential'
import { broadcastToAll } from '../http/websocket'
import { sendToRenderer } from '../foundation/window.service'
import { TEAM_EVENTS, isRemoteMember } from '../../shared/apps/team-types'
import type { JoinMember } from '../apps/runtime/federation/types'
import type { OfficeScope } from '../apps/federation/index'
import type { TeamUpdatedEvent, TeamVersionMismatch } from '../../shared/apps/team-types'

const LOG_TAG = '[TeamInvite]'

/** Internal error codes the transport layer maps to neutral localized text. */
export type TeamInviteError =
  | 'TEAM_NOT_FOUND'
  | 'REMOTE_ACCESS_OFF'
  | 'FEDERATION_UNAVAILABLE'

export interface TeamInvitePayload {
  url: string
  token: string
  jti: string
  officeId: string
  serverUrl: string
}

type Result<T> = { success: true; data: T } | { success: false; error: string }

/**
 * Mint an office-member invite for a team. Requires remote access to be running
 * (so a joiner can reach this host) and the federation manager to be available
 * (so the office can accept joins). An optional `scope` narrows what the joiner
 * may see/contact/be-assigned; omitted = the default-open overlay.
 */
export async function generateTeamInvite(teamId: string, ttlMs?: number, scope?: OfficeScope): Promise<Result<TeamInvitePayload>> {
  const team = getTeamStore()?.getTeamById(teamId)
  if (!team) {
    return { success: false, error: 'TEAM_NOT_FOUND' }
  }

  // Relayed office: when a federation gateway is configured, the invite points
  // joiners at the gateway (no LAN address in the link, §9.4) and the host
  // reaches the gateway outbound — the local server need not be running.
  const { getFederationGatewayUrl } = await import('../foundation/config.service')
  const gatewayUrl = getFederationGatewayUrl()

  let serverUrl = gatewayUrl ? gatewayUrl.replace(/\/+$/, '') : null
  if (!serverUrl) {
    // Lazy import: the remote service pulls electron at load; keeping it out of
    // this controller's static graph lets the team routes (which import this file)
    // load in non-electron contexts (tests, web) without dragging BrowserWindow in.
    const { getRemoteAccessStatus } = await import('../services/remote')
    const status = getRemoteAccessStatus()
    if (!status.server.running || !status.server.lanUrl) {
      return { success: false, error: 'REMOTE_ACCESS_OFF' }
    }
    serverUrl = status.server.lanUrl
  }

  const manager = getFederationManager()
  if (!manager) {
    return { success: false, error: 'FEDERATION_UNAVAILABLE' }
  }
  // Ensure the host coordinator exists so the office is ready to accept joins
  // (and, when a gateway is configured, attaches to it).
  manager.hostOffice(teamId)

  // Reuse the office's still-valid credential from the ledger instead of minting
  // on every dialog open, so a shared link keeps working across restarts (the
  // token is rebuilt from the ledger with deterministic signing). The token is
  // endpoint-independent, so a port drift still yields the same token in a
  // refreshed URL. Reuse is scope-matched — a different scope always mints
  // fresh, never handing back a link wider or narrower than asked.
  const reusable = findReusableOfficeCredential(teamId, scope)
  const { token, jti } = reusable
    ? { token: reusable.token, jti: reusable.record.jti }
    : issueOfficeCredential({ officeId: teamId, identity: '', ttlMs, scope })

  const url = `${serverUrl}/?office=${encodeURIComponent(teamId)}&invite=${encodeURIComponent(token)}`
  const payload: TeamInvitePayload = { url, token, jti, officeId: teamId, serverUrl }

  console.log(`${LOG_TAG} ${reusable ? 'reused' : 'issued'} invite for office=${teamId} jti=${jti}`)
  return { success: true, data: payload }
}

/** Revoke a previously issued invite by its jti. */
export function revokeTeamInvite(jti: string): Result<undefined> {
  revokeOfficeCredential(jti)
  return { success: true, data: undefined }
}

export interface JoinOfficeInput {
  officeId: string
  serverUrl: string
  inviteToken: string
  bringAppIds: string[]
}

/**
 * Join an office hosted elsewhere, bringing local digital humans. Resolves each
 * appId to a JoinMember (name + spaceId from the installed app), then drives the
 * federation join handshake. Unknown appIds are skipped; an empty result is a
 * caller error (NO_MEMBERS). A team this computer hosts is refused (OWN_TEAM).
 */
export async function joinTeamOffice(
  input: JoinOfficeInput
): Promise<{ success: true } | { success: false; error: string; detail?: TeamVersionMismatch }> {
  // A join first tears down what this computer runs for the office (a re-join
  // replaces it). For its own team that is the hosting: every other computer is
  // cut off, and this computer then grants itself the join, which rewrites the
  // team as hosted elsewhere — read-only here, deleted by a Leave.
  const team = getTeamStore()?.getTeamById(input.officeId)
  if (team && team.hostNodeId == null) {
    console.warn(`${LOG_TAG} join refused office=${input.officeId}: this computer's own team, hosted here`)
    return { success: false, error: 'OWN_TEAM' }
  }

  const appManager = getAppManager()
  const bringMembers: JoinMember[] = []
  for (const appId of input.bringAppIds) {
    const app = appManager?.getApp(appId)
    if (!app) continue
    bringMembers.push({
      appId: app.id,
      memberName: app.spec.name,
      role: '',
      spaceId: app.spaceId ?? undefined,
    })
  }
  if (bringMembers.length === 0) {
    return { success: false, error: 'NO_MEMBERS' }
  }

  const mgr = getFederationManager()
  if (!mgr) {
    return { success: false, error: 'FEDERATION_UNAVAILABLE' }
  }

  const selfContext = { officeId: input.officeId, selfNodeId: getLocalIdentity().id }
  const result = await mgr.joinOffice({
    officeId: input.officeId,
    serverUrl: input.serverUrl,
    credentialToken: input.inviteToken,
    selfContext,
    bringMembers,
  })

  return result.ok ? { success: true } : { success: false, error: result.reason ?? 'JOIN_FAILED', detail: result.detail }
}

/**
 * Leave a joined office: drop the outbound federation connection and remove the
 * local shadow team row this node materialized for the office. The removal is
 * broadcast so the office disappears from every connected view. Only a team
 * joined from elsewhere (hostNodeId set) can be left: one this node hosts is
 * refused (NOT_JOINED) — its host dissolves it, and a leave would stop hosting
 * it and delete it without telling anyone who joined.
 *
 * With `appIds`, only those of this node's members leave and the node stays —
 * unless they are all it has there, which is leaving. Either way the duty of
 * each member that leaves is kept here, so rejoining the same team gives it
 * back: on both machines it lived only in the rows that leaving deletes. Which
 * of the two a request is gets decided here, when it runs: a dialog opened
 * earlier may name a member that has left since, or the last one left.
 */
export async function leaveTeamOffice(
  officeId: string,
  appIds?: string[]
): Promise<{ success: true } | { success: false; error: string }> {
  const store = getTeamStore()
  if (!store) {
    return { success: false, error: 'TEAM_STORE_UNAVAILABLE' }
  }
  const team = store.getTeamById(officeId)
  if (team?.hostNodeId == null) {
    console.warn(
      `${LOG_TAG} ${appIds ? 'withdraw' : 'leave'} refused office=${officeId}: ` +
        (team ? 'hosted here; a host dissolves its team instead' : 'no such team here')
    )
    return { success: false, error: 'NOT_JOINED' }
  }
  const manager = getFederationManager()
  const own = store.listMembersByTeam(officeId).filter((m) => !isRemoteMember(m))

  if (appIds) {
    const leaving = own.filter((m) => appIds.includes(m.appId))
    if (leaving.length === 0) {
      console.warn(`${LOG_TAG} withdraw refused office=${officeId}: none of apps=${appIds.length} is this computer's`)
      return { success: false, error: 'MEMBER_NOT_FOUND' }
    }
    if (leaving.length < own.length) {
      // Read before sending: the office's answer removes the rows.
      const duties = leaving.map((m) => ({ appId: m.appId, duty: m.duty }))
      if (!manager) {
        console.warn(`${LOG_TAG} withdraw refused office=${officeId}: federation manager unavailable`)
        return { success: false, error: 'OFFICE_UNREACHABLE' }
      }
      const outcome = manager.withdrawMembers(officeId, leaving.map((m) => m.appId))
      if (outcome === 'sent') {
        const kept = store.retainMemberDuties(officeId, duties)
        console.log(`${LOG_TAG} withdrew from office=${officeId} apps=${leaving.length} dutiesKept=${kept}`)
        return { success: true }
      }
      if (outcome === 'elected-authority') return { success: false, error: 'ELECTED_AUTHORITY' }
      if (outcome !== 'last-members') return { success: false, error: 'OFFICE_UNREACHABLE' }
      // The others are already on their way out: this is leaving the team.
      console.log(`${LOG_TAG} withdraw of apps=${leaving.length} takes the last members out; leaving office=${officeId}`)
    }
  }

  // Members already on their way out included: their rows are still here.
  const kept = store.retainMemberDuties(officeId, own.map((m) => ({ appId: m.appId, duty: m.duty })))

  // Tell the host we are leaving (drop the members we brought) BEFORE tearing the
  // connection down, so the host roster converges instead of keeping zombies.
  manager?.signalLeave(officeId)
  manager?.leaveOffice(officeId)

  // Remove the local shadow office row plus its mirrored members/edges/triggers.
  store.purgeJoinedOffice(officeId)

  const event: TeamUpdatedEvent = { teamId: officeId, removed: true }
  broadcastToAll(TEAM_EVENTS.updated, event as unknown as Record<string, unknown>)
  sendToRenderer(TEAM_EVENTS.updated, event)

  console.log(`${LOG_TAG} left office=${officeId} apps=${own.length} dutiesKept=${kept}`)
  return { success: true }
}
