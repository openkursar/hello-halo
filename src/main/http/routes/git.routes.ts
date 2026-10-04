/**
 * Git REST API routes (remote access).
 * Mirrors the IPC git surface (ipc/git.ts): the same controller, the same
 * envelopes with a stable `code` on failure. git runs on the host; arguments
 * are validated by the git service, which serves only repositories of the
 * named space.
 */
import type { Express, Request, Response } from 'express'
import * as gitController from '../../controllers/git.controller'

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
}

export function registerGitRoutes(app: Express): void {
  app.post('/api/git/repositories', async (req: Request, res: Response) => {
    res.json(await gitController.listGitRepositories(body(req).spaceId))
  })

  app.post('/api/git/status', async (req: Request, res: Response) => {
    const { spaceId, repoRoot } = body(req)
    res.json(await gitController.getGitStatus(spaceId, repoRoot))
  })

  app.post('/api/git/changes', async (req: Request, res: Response) => {
    const { spaceId, repoRoot, scope } = body(req)
    res.json(await gitController.getGitChanges(spaceId, repoRoot, scope))
  })

  app.post('/api/git/file-contents', async (req: Request, res: Response) => {
    const { spaceId, repoRoot, request } = body(req)
    const disconnected = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) disconnected.abort()
    })
    res.json(await gitController.getGitFileContents(spaceId, repoRoot, request, disconnected.signal))
  })

  app.post('/api/git/revision-options', async (req: Request, res: Response) => {
    const { spaceId, repoRoot } = body(req)
    res.json(await gitController.listGitRevisionOptions(spaceId, repoRoot))
  })

  app.post('/api/git/stage', async (req: Request, res: Response) => {
    const { spaceId, repoRoot, paths } = body(req)
    res.json(await gitController.stageGitPaths(spaceId, repoRoot, paths))
  })

  app.post('/api/git/unstage', async (req: Request, res: Response) => {
    const { spaceId, repoRoot, paths } = body(req)
    res.json(await gitController.unstageGitPaths(spaceId, repoRoot, paths))
  })

  app.post('/api/git/discard', async (req: Request, res: Response) => {
    const { spaceId, repoRoot, paths } = body(req)
    res.json(await gitController.discardGitPaths(spaceId, repoRoot, paths))
  })

  app.post('/api/git/commit', async (req: Request, res: Response) => {
    const { spaceId, repoRoot, request } = body(req)
    res.json(await gitController.commitGitChanges(spaceId, repoRoot, request))
  })

  app.post('/api/git/sync', async (req: Request, res: Response) => {
    const { spaceId, repoRoot } = body(req)
    res.json(await gitController.syncGitBranch(spaceId, repoRoot))
  })

  app.post('/api/git/snapshot', async (req: Request, res: Response) => {
    const { spaceId, repoRoot } = body(req)
    res.json(await gitController.createGitSnapshot(spaceId, repoRoot))
  })

  app.post('/api/git/count-changed-since', async (req: Request, res: Response) => {
    const { spaceId, repoRoot, snapshot } = body(req)
    res.json(await gitController.countGitChangedSince(spaceId, repoRoot, snapshot))
  })
}
