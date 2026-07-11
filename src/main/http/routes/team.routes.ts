/** Digital Team REST API routes. Thin delegation to TeamService. */
import type { Express, Request, Response } from 'express'
import { getTeamService, getTeamStore } from '../../apps/team'
import { readTeamMemberMessages } from '../../apps/runtime/app-chat'
import { getOfficeCredential } from '../auth/middleware'
import { resolveOfficeMemberAppIds } from '../identity/office-membership'
import { createScopeGate } from '../../apps/runtime/federation/authority/scope-gate'
import { getFederationManager } from '../../apps/runtime/federation/manager'
import {
  generateTeamInvite,
  revokeTeamInvite,
  joinTeamOffice,
  leaveTeamOffice,
} from '../../controllers/team-invite.controller'
import type { OfficeScope } from '../../apps/federation/index'
import type {
  CreateTeamInput,
  UpdateTeamInput,
  TeamMemberInput,
  TeamEdge,
  ProposedMember,
  TeamTriggerInput,
  BlackboardTask,
  BlackboardFinding,
  BlackboardSnapshot,
  TeamArtifactGroup,
} from '../../../shared/apps/team-types'

export function registerTeamRoutes(app: Express): void {
  // Resolve the service or respond 503 (it initializes asynchronously).
  function getServiceOrFail(res: Response): ReturnType<typeof getTeamService> {
    const service = getTeamService()
    if (!service) {
      res.status(503).json({ success: false, error: 'Team service is not yet initialized. Please try again shortly.' })
    }
    return service
  }

  // Cross-office isolation gate. Office-member credentials are scoped to a
  // single office, which currently maps 1:1 to a team — so an office credential
  // may only read its own team. Remote-control PIN requests carry no office
  // credential (getOfficeCredential → null) and keep full read access unchanged.
  function officeGateOk(req: Request, res: Response, teamId: string): boolean {
    const cred = getOfficeCredential(req)
    if (cred && cred.officeId !== teamId) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return false
    }
    return true
  }

  // Per-invite scope projection. A request authenticated by an office
  // credential is projected down to what the member(s) that credential owns may
  // see; a PIN request (no credential) is returned unchanged. Fail-closed: a
  // credential mapping to NO member of this office sees an empty board, never the
  // unfiltered snapshot. When the identity owns several members, the visible set
  // is the UNION of each member's filtered view (it legitimately owns them all).
  function projectBoardForCredential(
    req: Request,
    teamId: string,
    tasks: BlackboardTask[],
    findings: BlackboardFinding[],
  ): { tasks: BlackboardTask[]; findings: BlackboardFinding[] } {
    const cred = getOfficeCredential(req)
    if (!cred) return { tasks, findings }

    const store = getTeamStore()
    if (!store) return { tasks: [], findings: [] }

    const appIds = resolveOfficeMemberAppIds(teamId, cred.identity)
    if (appIds.length === 0) return { tasks: [], findings: [] }

    const gate = createScopeGate({ store })
    const snapshot: BlackboardSnapshot = { tasks, findings, roster: [] }
    const taskIds = new Set<string>()
    const findingIds = new Set<string>()
    const visibleTasks: BlackboardTask[] = []
    const visibleFindings: BlackboardFinding[] = []
    for (const appId of appIds) {
      const filtered = gate.filterBoard(teamId, appId, snapshot)
      for (const t of filtered.tasks) {
        if (!taskIds.has(t.id)) {
          taskIds.add(t.id)
          visibleTasks.push(t)
        }
      }
      for (const f of filtered.findings) {
        if (!findingIds.has(f.id)) {
          findingIds.add(f.id)
          visibleFindings.push(f)
        }
      }
    }
    return { tasks: visibleTasks, findings: visibleFindings }
  }

  // Per-invite scope projection for artifact listings, mirroring the transcript
  // rule: a credentialed reader always sees the artifacts of the member(s) its
  // identity owns; seeing PEERS' artifacts requires a board-wide scope (full
  // visibility AND discoverable). Fail-closed: a credential mapping to no member
  // sees nothing. PIN requests (no credential) pass through unchanged.
  function projectArtifactsForCredential(
    req: Request,
    teamId: string,
    groups: TeamArtifactGroup[],
  ): TeamArtifactGroup[] {
    const cred = getOfficeCredential(req)
    if (!cred) return groups
    const store = getTeamStore()
    if (!store) return []
    const ownAppIds = resolveOfficeMemberAppIds(teamId, cred.identity)
    if (ownAppIds.length === 0) return []
    const gate = createScopeGate({ store })
    const members = store.listMembersByTeam(teamId)
    const canSeePeers = ownAppIds.some((own) => {
      const member = members.find((m) => m.appId === own)
      if (!member) return false
      const scope = gate.parseScope(member)
      return scope.visibility === 'full' && scope.discoverable
    })
    if (canSeePeers) return groups
    return groups.filter((g) => ownAppIds.includes(g.appId))
  }

  // GET /api/teams — list teams (optional ?spaceId=)
  app.get('/api/teams', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      const spaceId = typeof req.query.spaceId === 'string' && req.query.spaceId ? req.query.spaceId : undefined
      res.json({ success: true, data: service.listTeamItems(spaceId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams — create a team
  app.post('/api/teams', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      const { input, confirmedProposal } = req.body as {
        input?: CreateTeamInput
        confirmedProposal?: ProposedMember[]
      }
      if (!input || typeof input !== 'object') {
        res.status(400).json({ success: false, error: 'Missing required field: input' })
        return
      }
      const team = await service.createTeam(input, confirmedProposal)
      res.json({ success: true, data: team })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/propose-members — propose AI members from a goal
  app.post('/api/teams/propose-members', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      const { goal, owningSpaceId } = req.body as { goal?: string; owningSpaceId?: string }
      if (!goal || !owningSpaceId) {
        res.status(400).json({ success: false, error: 'Missing required fields: goal, owningSpaceId' })
        return
      }
      const proposed = await service.proposeMembers(goal, owningSpaceId)
      res.json({ success: true, data: proposed })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId — get a single team
  app.get('/api/teams/:teamId', async (req: Request, res: Response) => {
    try {
      if (!officeGateOk(req, res, req.params.teamId)) return
      const service = getServiceOrFail(res)
      if (!service) return
      res.json({ success: true, data: service.getTeam(req.params.teamId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/detail — full TeamDetail bundle
  app.get('/api/teams/:teamId/detail', async (req: Request, res: Response) => {
    try {
      if (!officeGateOk(req, res, req.params.teamId)) return
      const service = getServiceOrFail(res)
      if (!service) return
      const detail = service.getTeamDetail(req.params.teamId)
      if (!detail) {
        res.json({ success: true, data: detail })
        return
      }
      // Project tasks/findings down to the credential's scope. PIN requests
      // pass through unchanged; team meta/edges/roster are unaffected.
      const projected = projectBoardForCredential(req, req.params.teamId, detail.tasks, detail.findings)
      res.json({ success: true, data: { ...detail, tasks: projected.tasks, findings: projected.findings } })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/chat-messages — a member's team-channel chat history
  // for ONE run. ?appId is required and MUST be a member of the team (prevents
  // probing arbitrary apps). ?epochId defaults to the team's current epoch.
  app.get('/api/teams/:teamId/chat-messages', async (req: Request, res: Response) => {
    try {
      if (!officeGateOk(req, res, req.params.teamId)) return
      const store = getTeamStore()
      if (!store) {
        res.status(503).json({ success: false, error: 'Team store is not yet initialized. Please try again shortly.' })
        return
      }
      const teamId = req.params.teamId
      const appId = typeof req.query.appId === 'string' ? req.query.appId : ''
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing required query parameter: appId' })
        return
      }
      const targetMember = store.listMembersByTeam(teamId).find((m) => m.appId === appId)
      if (!targetMember) {
        res.status(404).json({ success: false, error: 'App is not a member of this team' })
        return
      }
      // Per-invite scope on transcripts. An office-credential reader may
      // always read its OWN members' transcripts; reading another member's
      // transcript requires a board-wide scope (full visibility AND discoverable).
      // A narrow member (assigned/readonly, or non-discoverable) is confined to
      // its own transcripts so it cannot probe peers it may not even see on the
      // board. PIN requests carry no credential and are unaffected.
      const cred = getOfficeCredential(req)
      if (cred) {
        const ownAppIds = resolveOfficeMemberAppIds(teamId, cred.identity)
        if (!ownAppIds.includes(appId)) {
          const gate = createScopeGate({ store })
          const members = store.listMembersByTeam(teamId)
          const canSeePeer = ownAppIds.some((own) => {
            const member = members.find((m) => m.appId === own)
            if (!member) return false
            const scope = gate.parseScope(member)
            return scope.visibility === 'full' && scope.discoverable
          })
          if (!canSeePeer) {
            res.status(404).json({ success: false, error: 'App is not a member of this team' })
            return
          }
        }
      }
      // Fall back to the latest (possibly sealed) epoch so a member's history
      // stays readable after the run that produced it has ended.
      const epochId =
        (typeof req.query.epochId === 'string' && req.query.epochId
          ? req.query.epochId
          : (store.getCurrentEpochForTeam(teamId)?.id ?? store.listEpochsByTeam(teamId)[0]?.id)) ?? ''
      if (!epochId) {
        res.status(400).json({ success: false, error: 'No run has started for this team yet' })
        return
      }
      // A remote-owned member's transcript lives on the node that OWNS it, not
      // here. Pull it over the office link from that owner; the owner
      // authorizes and serves only members it owns. A locally-owned member is
      // read straight from local chat storage as before.
      if (targetMember.origin === 'remote' && targetMember.ownerNodeId) {
        const manager = getFederationManager()
        if (!manager) {
          res.status(503).json({ success: false, error: 'Federation is not yet initialized. Please try again shortly.' })
          return
        }
        // The owner rejects with a TECHNICAL error (a code, not user text) on
        // not-owned / not-found / timeout. Never surface it: log it and answer a
        // neutral 502 so the transcript simply reads as unavailable.
        try {
          const messages = await manager.fetchMemberHistory({
            officeId: teamId,
            ownerNodeId: targetMember.ownerNodeId,
            appId,
            epochId,
          })
          res.json({ success: true, data: messages })
        } catch (err) {
          console.warn(`[TeamRoutes] remote history fetch failed office=${teamId} appId=${appId}:`, (err as Error).message)
          res.status(502).json({ success: false, error: 'History is temporarily unavailable.' })
        }
        return
      }
      res.json({ success: true, data: readTeamMemberMessages(appId, teamId, epochId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/:teamId/members/:appId/send — dispatch a message to one
  // member for ONE run. The only write an office-member credential may reach
  // (the rest of the allowlist is read-only). Two scope gates apply to a
  // credentialed caller (a PIN/host-operator request carries no credential and
  // is unrestricted): the caller must not be read-only (canCoordinationWrite),
  // and a lead-only target is reachable only by the office lead (canContact).
  app.post('/api/teams/:teamId/members/:appId/send', async (req: Request, res: Response) => {
    try {
      const teamId = req.params.teamId
      const targetAppId = req.params.appId
      if (!officeGateOk(req, res, teamId)) return
      const service = getServiceOrFail(res)
      if (!service) return
      const store = getTeamStore()
      if (!store) {
        res.status(503).json({ success: false, error: 'Team store is not yet initialized. Please try again shortly.' })
        return
      }

      const isMember = store.listMembersByTeam(teamId).some((m) => m.appId === targetAppId)
      if (!isMember) {
        res.status(404).json({ success: false, error: 'App is not a member of this team' })
        return
      }

      const cred = getOfficeCredential(req)
      if (cred) {
        const callerAppIds = resolveOfficeMemberAppIds(teamId, cred.identity)
        if (callerAppIds.length === 0) {
          res.status(403).json({ success: false, error: 'Forbidden' })
          return
        }
        const gate = createScopeGate({ store })
        // A read-only member cannot dispatch; a lead-only target is reachable
        // only by the lead. The caller passes if ANY member it owns may both
        // make coordination writes AND contact the target.
        const allowed = callerAppIds.some(
          (callerAppId) =>
            gate.canCoordinationWrite(teamId, callerAppId) && gate.canContact(teamId, callerAppId, targetAppId),
        )
        if (!allowed) {
          res.status(403).json({ success: false, error: 'Forbidden' })
          return
        }
      }

      const { message, images, thinkingEnabled } = (req.body ?? {}) as {
        message?: string
        images?: { type: string; media_type: string; data: string }[]
        thinkingEnabled?: boolean
      }
      if (typeof message !== 'string' || message.length === 0) {
        res.status(400).json({ success: false, error: 'Missing required field: message' })
        return
      }
      // epochId defaults to the team's current run when the body omits it, and
      // falls back to the latest (possibly sealed) epoch so ad-hoc 1:1 chat keeps
      // working after a run finished — sendToMember reactivates it before sending.
      const epochId =
        (typeof req.body?.epochId === 'string' && req.body.epochId
          ? req.body.epochId
          : (store.getCurrentEpochForTeam(teamId)?.id ?? store.listEpochsByTeam(teamId)[0]?.id)) ?? ''
      if (!epochId) {
        res.status(400).json({ success: false, error: 'No run has started for this team yet' })
        return
      }

      const result = await service.sendToMember({ teamId, appId: targetAppId, epochId, message, images, thinkingEnabled })
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/artifacts — per-member product listing (current/latest run)
  app.get('/api/teams/:teamId/artifacts', async (req: Request, res: Response) => {
    try {
      if (!officeGateOk(req, res, req.params.teamId)) return
      const service = getServiceOrFail(res)
      if (!service) return
      const groups = await service.listArtifacts(req.params.teamId)
      res.json({ success: true, data: projectArtifactsForCredential(req, req.params.teamId, groups) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/epochs — run history (newest first). Mirrors IPC
  // team:list-epochs so the History tab works over remote access too.
  app.get('/api/teams/:teamId/epochs', async (req: Request, res: Response) => {
    try {
      if (!officeGateOk(req, res, req.params.teamId)) return
      const service = getServiceOrFail(res)
      if (!service) return
      res.json({ success: true, data: service.listEpochs(req.params.teamId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/epochs/:epochId/board — tasks/findings/members for a past run
  app.get('/api/teams/:teamId/epochs/:epochId/board', async (req: Request, res: Response) => {
    try {
      if (!officeGateOk(req, res, req.params.teamId)) return
      const service = getServiceOrFail(res)
      if (!service) return
      const board = service.getEpochBoard(req.params.teamId, req.params.epochId)
      if (!board) {
        res.json({ success: true, data: board })
        return
      }
      // Same per-invite scope projection as /detail; epoch + members metadata
      // is unaffected, only the tasks/findings the board exposes.
      const projected = projectBoardForCredential(req, req.params.teamId, board.tasks, board.findings)
      res.json({ success: true, data: { ...board, tasks: projected.tasks, findings: projected.findings } })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/epochs/:epochId/artifacts — products produced during a run
  app.get('/api/teams/:teamId/epochs/:epochId/artifacts', async (req: Request, res: Response) => {
    try {
      if (!officeGateOk(req, res, req.params.teamId)) return
      const service = getServiceOrFail(res)
      if (!service) return
      const groups = await service.listArtifacts(req.params.teamId, req.params.epochId)
      res.json({ success: true, data: projectArtifactsForCredential(req, req.params.teamId, groups) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // PATCH /api/teams/:teamId — update mutable fields
  app.patch('/api/teams/:teamId', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      const input = req.body as UpdateTeamInput
      const team = await service.updateTeam(req.params.teamId, input)
      res.json({ success: true, data: team })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/teams/:teamId — dissolve
  app.delete('/api/teams/:teamId', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      await service.dissolveTeam(req.params.teamId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/:teamId/members — add a member
  app.post('/api/teams/:teamId/members', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      const member = req.body as TeamMemberInput
      if (!member?.appId) {
        res.status(400).json({ success: false, error: 'Missing required field: appId' })
        return
      }
      const added = await service.addMember(req.params.teamId, member)
      res.json({ success: true, data: added })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/teams/:teamId/members/:appId — remove a member
  app.delete('/api/teams/:teamId/members/:appId', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      await service.removeMember(req.params.teamId, req.params.appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // PUT /api/teams/:teamId/edges — replace the collaboration topology
  app.put('/api/teams/:teamId/edges', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      const { edges } = req.body as { edges?: TeamEdge[] }
      service.setEdges(req.params.teamId, edges ?? [])
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/:teamId/run — start a run epoch (external = http trigger)
  app.post('/api/teams/:teamId/run', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      await service.runTeam(req.params.teamId, { type: 'http' })
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/:teamId/pause — seal the running epoch
  app.post('/api/teams/:teamId/pause', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      await service.pauseTeam(req.params.teamId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/triggers — list a team's triggers
  app.get('/api/teams/:teamId/triggers', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      res.json({ success: true, data: service.listTriggers(req.params.teamId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/:teamId/triggers — create/update a trigger (body: { trigger, triggerId? })
  app.post('/api/teams/:teamId/triggers', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      const { trigger, triggerId } = req.body as { trigger?: TeamTriggerInput; triggerId?: string }
      if (!trigger || typeof trigger !== 'object') {
        res.status(400).json({ success: false, error: 'Missing required field: trigger' })
        return
      }
      res.json({ success: true, data: service.setTrigger(req.params.teamId, trigger, triggerId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/:teamId/invite — mint an office invite (control-plane).
  // Remote-control scoped (PIN), NOT in the office-member allowlist — this
  // generates a credential and must not be reachable by an office member.
  app.post('/api/teams/:teamId/invite', async (req: Request, res: Response) => {
    try {
      const { ttlMs, scope } = (req.body ?? {}) as { ttlMs?: number; scope?: OfficeScope }
      res.json(await generateTeamInvite(req.params.teamId, ttlMs, scope))
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/teams/:teamId/invite/:jti — revoke an office invite (control-plane).
  app.delete('/api/teams/:teamId/invite/:jti', async (req: Request, res: Response) => {
    try {
      res.json(revokeTeamInvite(req.params.jti))
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/:teamId/join — join an office hosted elsewhere, bringing
  // local digital humans (control-plane). Mirrors IPC team:join-office so a
  // headless/remote-driven node can join over HTTP. NOT in the office-member
  // allowlist: this is reachable only by the node's own remote-control PIN — an
  // office credential gets 403 at the middleware. The :teamId path segment is
  // the target officeId; serverUrl + inviteToken come from the host's invite.
  app.post('/api/teams/:teamId/join', async (req: Request, res: Response) => {
    try {
      const { serverUrl, inviteToken, bringAppIds } = (req.body ?? {}) as {
        serverUrl?: string
        inviteToken?: string
        bringAppIds?: string[]
      }
      if (typeof serverUrl !== 'string' || !serverUrl) {
        res.status(400).json({ success: false, error: 'Missing required field: serverUrl' })
        return
      }
      if (typeof inviteToken !== 'string' || !inviteToken) {
        res.status(400).json({ success: false, error: 'Missing required field: inviteToken' })
        return
      }
      if (!Array.isArray(bringAppIds) || bringAppIds.length === 0) {
        res.status(400).json({ success: false, error: 'Missing required field: bringAppIds' })
        return
      }
      res.json(await joinTeamOffice({ officeId: req.params.teamId, serverUrl, inviteToken, bringAppIds }))
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/teams/:teamId/leave — leave a joined office (control-plane).
  // Mirrors IPC team:leave-office. PIN-only, same as join.
  app.post('/api/teams/:teamId/leave', async (req: Request, res: Response) => {
    try {
      res.json(await leaveTeamOffice(req.params.teamId))
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/federation/presence — read-only node presence +
  // authority view for an office (control-plane / observability). PIN-only:
  // NOT in the office-member allowlist. Returns null data when the office is
  // neither hosted nor joined on this node.
  app.get('/api/teams/:teamId/federation/presence', async (req: Request, res: Response) => {
    try {
      const manager = getFederationManager()
      if (!manager) {
        res.status(503).json({ success: false, error: 'Federation is not yet initialized. Please try again shortly.' })
        return
      }
      res.json({ success: true, data: manager.getOfficePresence(req.params.teamId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/teams/:teamId/triggers/:triggerId — remove a trigger
  app.delete('/api/teams/:teamId/triggers/:triggerId', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      service.removeTrigger(req.params.teamId, req.params.triggerId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })
}
