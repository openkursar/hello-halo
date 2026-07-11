/**
 * Office lifecycle recovery. Run once on boot to re-ready every persisted
 * office so a restart does not silently kill it. Kept out of the bootstrap
 * orchestrator so it carries no window/overlay graph and stays unit-testable: it
 * depends only on the federation manager, the federation store, and the team
 * store passed in.
 */

import type { TeamStore } from '../apps/team'
import { getFederationManager } from '../apps/runtime/federation/manager'
import { getFederationStore } from '../apps/federation'
import { joinTeamOffice } from '../controllers/team-invite.controller'

/**
 * Owned offices (host_node_id null) are re-hosted directly; joined offices are
 * replayed through joinTeamOffice — the same path a manual join takes, so
 * recovery and live join can never diverge.
 *
 * Idempotent (hostOffice/joinOffice tolerate re-entry) and best-effort: a
 * single office's failure never aborts the rest.
 */
export function recoverPersistedOffices(teamStore: TeamStore | null): void {
  if (!teamStore) {
    console.warn('[Bootstrap] Office recovery skipped: team store unavailable')
    return
  }
  const manager = getFederationManager()
  if (!manager) {
    console.warn('[Bootstrap] Office recovery skipped: federation manager unavailable')
    return
  }

  let reHosted = 0
  for (const team of teamStore.listTeams()) {
    if (team.hostNodeId != null) continue // joined offices recover from the connection store below
    try {
      manager.hostOffice(team.id)
      reHosted += 1
      console.log(`[Bootstrap] Re-hosted owned office=${team.id}`)
    } catch (err) {
      console.error(`[Bootstrap] Re-host failed office=${team.id}:`, err)
    }
  }

  const connections = getFederationStore()?.listJoinedOfficeConnections() ?? []
  for (const conn of connections) {
    // Fire-and-forget: a join awaits the network, so we must not block boot; each
    // settles independently and its outcome is logged.
    joinTeamOffice({
      officeId: conn.officeId,
      serverUrl: conn.serverUrl,
      inviteToken: conn.inviteToken,
      bringAppIds: conn.bringAppIds,
    })
      .then((res) =>
        res.success
          ? console.log(`[Bootstrap] Re-joined office=${conn.officeId}`)
          : console.warn(`[Bootstrap] Re-join failed office=${conn.officeId}: ${res.error}`)
      )
      .catch((err) => console.error(`[Bootstrap] Re-join threw office=${conn.officeId}:`, err))
  }

  console.log(
    `[Bootstrap] Office recovery: re-hosted=${reHosted} re-join-dispatched=${connections.length}`
  )
}
