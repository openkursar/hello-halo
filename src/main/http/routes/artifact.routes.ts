/**
 * Artifact REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  basename,
  collectFiles,
  createFile,
  createFolder,
  createGzip,
  createReadStream,
  detectFileType,
  existsSync,
  getWorkingDir,
  isPathInside,
  listArtifacts,
  listArtifactsTree,
  loadTreeChildren,
  moveArtifact,
  readArtifactContent,
  reconcileArtifacts,
  renameArtifact,
  saveArtifactContent,
  statSync,
  trashArtifact,
  validateFilePath,
} from './_shared'

export function registerArtifactRoutes(app: Express): void {
  // ===== Artifact Routes =====
  app.get('/api/spaces/:spaceId/artifacts', async (req: Request, res: Response) => {
    try {
      const rawMaxDepth = req.query.maxDepth
      const parsedMaxDepth = typeof rawMaxDepth === 'string' ? Number.parseInt(rawMaxDepth, 10) : Number.NaN
      const maxDepth = Number.isFinite(parsedMaxDepth) ? Math.max(0, parsedMaxDepth) : 2
      const artifacts = await listArtifacts(req.params.spaceId, maxDepth)
      res.json({ success: true, data: artifacts })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Tree view of artifacts — returns { workspaceRoot, nodes }
  app.get('/api/spaces/:spaceId/artifacts/tree', async (req: Request, res: Response) => {
    try {
      const result = await listArtifactsTree(req.params.spaceId)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Lazy load children for tree nodes
  app.post('/api/spaces/:spaceId/artifacts/children', async (req: Request, res: Response) => {
    try {
      const { dirPath } = req.body
      if (!dirPath) {
        res.status(400).json({ success: false, error: 'Missing dirPath' })
        return
      }

      const workDir = getWorkingDir(req.params.spaceId)
      if (!isPathInside(dirPath, workDir)) {
        res.status(403).json({ success: false, error: 'Access denied' })
        return
      }

      const children = await loadTreeChildren(req.params.spaceId, dirPath)
      res.json({ success: true, data: children })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Download single file
  app.get('/api/artifacts/download', async (req: Request, res: Response) => {
    try {
      const validatedPath = validateFilePath(res, req.query.path as string)
      if (!validatedPath) {
        return
      }

      if (!existsSync(validatedPath)) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }

      const stats = statSync(validatedPath)
      const fileName = basename(validatedPath)

      if (stats.isDirectory()) {
        // For directories, create a simple tar.gz stream
        // Note: This is a simplified implementation. For production, use archiver package.
        const files = collectFiles(validatedPath, validatedPath)
        if (files.length === 0) {
          res.status(404).json({ success: false, error: 'Directory is empty' })
          return
        }

        // Set headers for tar.gz download
        res.setHeader('Content-Type', 'application/gzip')
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}.tar.gz"`)

        // Create a simple concatenated file stream with headers
        // For a proper implementation, use archiver or tar package
        // This is a fallback that just zips the first file for now
        const gzip = createGzip()
        const firstFile = files[0]
        const readStream = createReadStream(firstFile.fullPath)

        readStream.pipe(gzip).pipe(res)
      } else {
        // Single file download
        const mimeTypes: Record<string, string> = {
          html: 'text/html',
          htm: 'text/html',
          css: 'text/css',
          js: 'application/javascript',
          json: 'application/json',
          txt: 'text/plain',
          md: 'text/markdown',
          py: 'text/x-python',
          ts: 'text/typescript',
          tsx: 'text/typescript',
          jsx: 'text/javascript',
          svg: 'image/svg+xml',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          pdf: 'application/pdf',
        }

        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        const contentType = mimeTypes[ext] || 'application/octet-stream'

        res.setHeader('Content-Type', contentType)
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
        res.setHeader('Content-Length', stats.size)

        const readStream = createReadStream(validatedPath)
        readStream.pipe(res)
      }
    } catch (error) {
      console.error('[Download] Error:', error)
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Download all artifacts in a space as zip
  app.get('/api/spaces/:spaceId/artifacts/download-all', async (req: Request, res: Response) => {
    try {
      const { spaceId } = req.params
      const workDir = getWorkingDir(spaceId)

      if (!existsSync(workDir)) {
        res.status(404).json({ success: false, error: 'Space not found' })
        return
      }

      const files = collectFiles(workDir, workDir)
      if (files.length === 0) {
        res.status(404).json({ success: false, error: 'No files to download' })
        return
      }

      // For simplicity, just download the first file if archiver is not available
      // A proper implementation would use archiver to create a zip
      const fileName = spaceId === 'halo-temp' ? 'halo-artifacts' : basename(workDir)
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}.tar.gz"`)

      // Stream the first file with gzip as a demo
      // TODO: Use archiver for proper zip support
      const gzip = createGzip()
      const firstFile = files[0]
      const readStream = createReadStream(firstFile.fullPath)
      readStream.pipe(gzip).pipe(res)
    } catch (error) {
      console.error('[Download All] Error:', error)
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Read artifact content (Content Canvas fallback for remote mode)
  app.get('/api/artifacts/content', async (req: Request, res: Response) => {
    try {
      const validatedPath = validateFilePath(res, req.query.path as string)
      if (!validatedPath) {
        return
      }

      if (!existsSync(validatedPath)) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }

      const result = readArtifactContent(validatedPath)
      res.json({ success: true, data: result })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Save artifact content (remote mode edit)
  app.post('/api/artifacts/save', async (req: Request, res: Response) => {
    try {
      const { path: filePath, content } = req.body
      const validatedPath = validateFilePath(res, filePath)
      if (!validatedPath) return

      if (typeof content !== 'string') {
        res.status(400).json({ success: false, error: 'Invalid content' })
        return
      }

      saveArtifactContent(validatedPath, content)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Detect file type (remote mode Canvas fallback)
  app.get('/api/artifacts/detect-type', async (req: Request, res: Response) => {
    try {
      const validatedPath = validateFilePath(res, req.query.path as string)
      if (!validatedPath) return

      if (!existsSync(validatedPath)) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }

      const info = detectFileType(validatedPath)
      res.json({ success: true, data: info })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })


  // ===== File Operations Routes (Create, Rename, Delete, Move) =====

  // Create file — frontend sends (parentPath, name), backend constructs full path
  app.post('/api/spaces/:spaceId/artifacts/file', async (req: Request, res: Response) => {
    try {
      const { parentPath, name, content } = req.body as { parentPath?: string; name?: string; content?: string }
      if (!name) {
        res.status(400).json({ success: false, error: 'Missing name' })
        return
      }
      const resolvedPath = await createFile(req.params.spaceId, parentPath || '', name, content || '')
      res.json({ success: true, data: { path: resolvedPath } })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Create folder — frontend sends (parentPath, name), backend constructs full path
  app.post('/api/spaces/:spaceId/artifacts/folder', async (req: Request, res: Response) => {
    try {
      const { parentPath, name } = req.body as { parentPath?: string; name?: string }
      if (!name) {
        res.status(400).json({ success: false, error: 'Missing name' })
        return
      }
      const resolvedPath = await createFolder(req.params.spaceId, parentPath || '', name)
      res.json({ success: true, data: { path: resolvedPath } })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Reconcile artifact cache against filesystem (push + pull recovery)
  app.post('/api/spaces/:spaceId/artifacts/reconcile', async (req: Request, res: Response) => {
    try {
      await reconcileArtifacts(req.params.spaceId)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Delete file or folder (move to trash)
  app.delete('/api/spaces/:spaceId/artifacts', async (req: Request, res: Response) => {
    try {
      const { path: targetPath } = req.body as { path?: string }
      if (!targetPath) {
        res.status(400).json({ success: false, error: 'Missing path' })
        return
      }
      await trashArtifact(req.params.spaceId, targetPath)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Rename file or folder
  app.post('/api/spaces/:spaceId/artifacts/rename', async (req: Request, res: Response) => {
    try {
      const { oldPath, newName } = req.body as { oldPath?: string; newName?: string }
      if (!oldPath || !newName) {
        res.status(400).json({ success: false, error: 'Missing oldPath or newName' })
        return
      }
      await renameArtifact(req.params.spaceId, oldPath, newName)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

  // Move file or folder — frontend sends (oldPath, newParentPath), backend constructs destination
  app.post('/api/spaces/:spaceId/artifacts/move', async (req: Request, res: Response) => {
    try {
      const { oldPath, newParentPath } = req.body as { oldPath?: string; newParentPath?: string }
      if (!oldPath) {
        res.status(400).json({ success: false, error: 'Missing oldPath' })
        return
      }
      const resolvedPath = await moveArtifact(req.params.spaceId, oldPath, newParentPath || '')
      res.json({ success: true, data: { path: resolvedPath } })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  })

}
