/** Digital Team REST API routes. Thin delegation to TeamService. */
import type { Express, Request, Response } from 'express'
import { getTeamService } from '../../apps/team'
import type {
  CreateTeamInput,
  UpdateTeamInput,
  TeamMemberInput,
  TeamEdge,
  ProposedMember,
  TeamTriggerInput,
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
      const service = getServiceOrFail(res)
      if (!service) return
      res.json({ success: true, data: service.getTeamDetail(req.params.teamId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/artifacts — per-member product listing (current/latest run)
  app.get('/api/teams/:teamId/artifacts', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      res.json({ success: true, data: await service.listArtifacts(req.params.teamId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/epochs — run history (newest first). Mirrors IPC
  // team:list-epochs so the History tab works over remote access too.
  app.get('/api/teams/:teamId/epochs', async (req: Request, res: Response) => {
    try {
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
      const service = getServiceOrFail(res)
      if (!service) return
      res.json({ success: true, data: service.getEpochBoard(req.params.teamId, req.params.epochId) })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/teams/:teamId/epochs/:epochId/artifacts — products produced during a run
  app.get('/api/teams/:teamId/epochs/:epochId/artifacts', async (req: Request, res: Response) => {
    try {
      const service = getServiceOrFail(res)
      if (!service) return
      res.json({ success: true, data: await service.listArtifacts(req.params.teamId, req.params.epochId) })
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
