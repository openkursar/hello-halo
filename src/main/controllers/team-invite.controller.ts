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
import { TEAM_EVENTS } from '../../shared/apps/team-types'
import type { JoinMember } from '../apps/runtime/federation/types'
import type { OfficeScope } from '../apps/federation/index'
import type { TeamUpdatedEvent } from '../../shared/apps/team-types'

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
    // Lazy import: remote.service pulls electron at load; keeping it out of this
    // controller's static graph lets the team routes (which import this file) load
    // in non-electron contexts (tests, web) without dragging BrowserWindow in.
    const { getRemoteAccessStatus } = await import('../services/remote.service')
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
 * caller error (NO_MEMBERS).
 */
export async function joinTeamOffice(
  input: JoinOfficeInput
): Promise<{ success: true } | { success: false; error: string }> {
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

  return result.ok ? { success: true } : { success: false, error: result.reason ?? 'JOIN_FAILED' }
}

/**
 * Leave a joined office: drop the outbound federation connection and remove the
 * local shadow team row this node materialized for the office. Only meaningful
 * for a joined office (hostNodeId set); for a locally-hosted office this is a
 * no-op on the federation side and dissolve is the correct action instead. The
 * removal is broadcast so the office disappears from every connected view.
 */
export async function leaveTeamOffice(
  officeId: string
): Promise<{ success: true } | { success: false; error: string }> {
  const store = getTeamStore()
  if (!store) {
    return { success: false, error: 'TEAM_STORE_UNAVAILABLE' }
  }

  // Tell the host we are leaving (drop the members we brought) BEFORE tearing the
  // connection down, so the host roster converges instead of keeping zombies.
  const manager = getFederationManager()
  manager?.signalLeave(officeId)
  manager?.leaveOffice(officeId)

  // Remove the local shadow office row plus its mirrored members/edges/triggers.
  store.purgeJoinedOffice(officeId)

  const event: TeamUpdatedEvent = { teamId: officeId, removed: true }
  broadcastToAll(TEAM_EVENTS.updated, event as unknown as Record<string, unknown>)
  sendToRenderer(TEAM_EVENTS.updated, event)

  console.log(`${LOG_TAG} left office=${officeId}`)
  return { success: true }
}
