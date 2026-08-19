/**
 * Tlon (knowledge base) REST API routes (remote access).
 * Mirrors the IPC surface in `ipc/tlon.ts`; both delegate to tlon.controller.
 * File/folder pickers are desktop-only and have no HTTP equivalent.
 */
import type { Express, Request, Response } from 'express'
import { tlonController } from './_shared'

export function registerTlonRoutes(app: Express): void {
  // ===== Knowledge Base CRUD =====

  // POST /api/tlon — create a knowledge base
  app.post('/api/tlon', (req: Request, res: Response) => {
    res.json(tlonController.createKB(req.body))
  })

  // GET /api/tlon — list all knowledge bases
  app.get('/api/tlon', (_req: Request, res: Response) => {
    res.json(tlonController.listKBs())
  })

  // GET /api/tlon/for-space/:spaceId — list KBs bound to a space (or default)
  app.get('/api/tlon/for-space/:spaceId', (req: Request, res: Response) => {
    res.json(tlonController.listKBsForSpace(req.params.spaceId))
  })

  // POST /api/tlon/set-default — set (or clear with null) the default KB
  app.post('/api/tlon/set-default', (req: Request, res: Response) => {
    const { kbId } = req.body as { kbId?: string | null }
    res.json(tlonController.setDefaultKB(kbId ?? null))
  })

  // GET /api/tlon/:kbId — get a single knowledge base
  app.get('/api/tlon/:kbId', (req: Request, res: Response) => {
    res.json(tlonController.getKB(req.params.kbId))
  })

  // PUT /api/tlon/:kbId — update name/icon/description/status
  app.put('/api/tlon/:kbId', (req: Request, res: Response) => {
    res.json(tlonController.updateKB(req.params.kbId, req.body))
  })

  // DELETE /api/tlon/:kbId — delete a knowledge base and its data
  app.delete('/api/tlon/:kbId', async (req: Request, res: Response) => {
    res.json(await tlonController.deleteKB(req.params.kbId))
  })

  // ===== Space / App bindings =====

  app.post('/api/tlon/:kbId/bind-space', (req: Request, res: Response) => {
    const { spaceId } = req.body as { spaceId?: string }
    if (!spaceId) {
      res.status(400).json({ success: false, error: 'Missing spaceId' })
      return
    }
    res.json(tlonController.bindToSpace(req.params.kbId, spaceId))
  })

  app.post('/api/tlon/:kbId/unbind-space', (req: Request, res: Response) => {
    const { spaceId } = req.body as { spaceId?: string }
    if (!spaceId) {
      res.status(400).json({ success: false, error: 'Missing spaceId' })
      return
    }
    res.json(tlonController.unbindFromSpace(req.params.kbId, spaceId))
  })

  app.post('/api/tlon/:kbId/bind-app', (req: Request, res: Response) => {
    const { appId } = req.body as { appId?: string }
    if (!appId) {
      res.status(400).json({ success: false, error: 'Missing appId' })
      return
    }
    res.json(tlonController.bindToApp(req.params.kbId, appId))
  })

  app.post('/api/tlon/:kbId/unbind-app', (req: Request, res: Response) => {
    const { appId } = req.body as { appId?: string }
    if (!appId) {
      res.status(400).json({ success: false, error: 'Missing appId' })
      return
    }
    res.json(tlonController.unbindFromApp(req.params.kbId, appId))
  })

  // ===== Linked directories =====

  // POST /api/tlon/:kbId/linked-dirs — link a directory as a source
  app.post('/api/tlon/:kbId/linked-dirs', (req: Request, res: Response) => {
    const { path, label } = req.body as { path?: string; label?: string }
    if (!path) {
      res.status(400).json({ success: false, error: 'Missing path' })
      return
    }
    res.json(tlonController.addLinkedDir(req.params.kbId, { path, label: label || path }))
  })

  // DELETE /api/tlon/:kbId/linked-dirs/:linkId — unlink a directory
  app.delete('/api/tlon/:kbId/linked-dirs/:linkId', (req: Request, res: Response) => {
    res.json(tlonController.removeLinkedDir(req.params.kbId, req.params.linkId))
  })

  // ===== Raw source files =====

  // POST /api/tlon/:kbId/files — add source files by absolute path (server-side)
  app.post('/api/tlon/:kbId/files', (req: Request, res: Response) => {
    const { filePaths } = req.body as { filePaths?: string[] }
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      res.status(400).json({ success: false, error: 'Missing filePaths' })
      return
    }
    res.json(tlonController.addRawFiles(req.params.kbId, filePaths))
  })

  // GET /api/tlon/:kbId/raw — list raw source files
  app.get('/api/tlon/:kbId/raw', (req: Request, res: Response) => {
    res.json(tlonController.listRawFiles(req.params.kbId))
  })

  // POST /api/tlon/:kbId/remove-raw — remove a raw source file
  app.post('/api/tlon/:kbId/remove-raw', (req: Request, res: Response) => {
    const { relativePath } = req.body as { relativePath?: string }
    if (!relativePath) {
      res.status(400).json({ success: false, error: 'Missing relativePath' })
      return
    }
    res.json(tlonController.removeRawFile(req.params.kbId, relativePath))
  })

  // ===== Index / citations =====

  // GET /api/tlon/:kbId/index — read the KB's index.md document map
  app.get('/api/tlon/:kbId/index', (req: Request, res: Response) => {
    res.json(tlonController.readIndexMd(req.params.kbId))
  })

  // POST /api/tlon/:kbId/resolve-sources — map agent Read paths to source docs
  app.post('/api/tlon/:kbId/resolve-sources', (req: Request, res: Response) => {
    const { readPaths } = req.body as { readPaths?: string[] }
    if (!Array.isArray(readPaths)) {
      res.status(400).json({ success: false, error: 'Missing readPaths' })
      return
    }
    res.json(tlonController.resolveSources(req.params.kbId, readPaths))
  })

  // ===== Ingest =====

  // POST /api/tlon/:kbId/ingest — trigger a full ingest (fire-and-forget)
  app.post('/api/tlon/:kbId/ingest', async (req: Request, res: Response) => {
    res.json(await tlonController.triggerIngest(req.params.kbId))
  })

  // POST /api/tlon/:kbId/clear-relearn — clear extracted text and re-ingest
  app.post('/api/tlon/:kbId/clear-relearn', (req: Request, res: Response) => {
    res.json(tlonController.clearAndRelearn(req.params.kbId))
  })

  // GET /api/tlon/:kbId/ingest-status — current ingest progress snapshot
  app.get('/api/tlon/:kbId/ingest-status', (req: Request, res: Response) => {
    res.json(tlonController.getIngestStatus(req.params.kbId))
  })
}
