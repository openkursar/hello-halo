/**
 * Load-balancing group REST routes (remote access).
 * Mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  createGroupAnswer,
  deleteGroupAnswer,
  groupHealthAnswer,
  groupRoutesAnswer,
  releaseGroupRestAnswer,
  updateGroupAnswer,
} from '../../controllers/ai-groups.controller'
import { maskConfigFields } from '../../foundation/config-encryption'
import type { AIGroupInput } from '../../../shared/rpc/contracts/ai-groups.contract'
import type { AISourcesConfig } from '../../../shared/types'

/** The desktop answer hides managed tokens only; a remote client must not receive any account's key either. */
function forRemote<T extends { data?: { aiSources: AISourcesConfig } }>(answer: T): T {
  if (!answer.data) return answer
  const aiSources = maskConfigFields({ aiSources: answer.data.aiSources } as unknown as Record<string, unknown>).aiSources as AISourcesConfig
  return { ...answer, data: { ...answer.data, aiSources } }
}

export function registerAiGroupsRoutes(app: Express): void {
  app.post('/api/ai-groups', (req: Request, res: Response) => {
    res.json(forRemote(createGroupAnswer(req.body as AIGroupInput)))
  })

  app.put('/api/ai-groups/:groupId', (req: Request, res: Response) => {
    res.json(forRemote(updateGroupAnswer(req.params.groupId, req.body as AIGroupInput)))
  })

  app.delete('/api/ai-groups/:groupId', (req: Request, res: Response) => {
    res.json(forRemote(deleteGroupAnswer(req.params.groupId)))
  })

  app.get('/api/ai-groups/:groupId/health', (req: Request, res: Response) => {
    res.json(groupHealthAnswer(req.params.groupId))
  })

  app.post('/api/ai-groups/:groupId/release-rest', (req: Request, res: Response) => {
    const memberKey = typeof req.body?.memberKey === 'string' ? req.body.memberKey : undefined
    res.json(releaseGroupRestAnswer(req.params.groupId, memberKey))
  })

  app.post('/api/ai-groups/routes', (req: Request, res: Response) => {
    res.json(groupRoutesAnswer(req.body?.sessionKeys))
  })
}
