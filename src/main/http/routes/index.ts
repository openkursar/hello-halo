/**
 * API Routes - REST API endpoints for remote access
 * Mirrors the IPC API structure
 */

import { Express, Request, Response } from 'express'
import { BrowserWindow } from 'electron'
import { createReadStream, statSync, existsSync, readdirSync } from 'fs'
import { join, basename, relative } from 'path'
import { createGzip } from 'zlib'
import { Readable } from 'stream'

import * as agentController from '../../controllers/agent.controller'
import * as spaceController from '../../controllers/space.controller'
import * as conversationController from '../../controllers/conversation.controller'
import * as configController from '../../controllers/config.controller'
import { listArtifacts } from '../../services/artifact.service'
import { getTempSpacePath } from '../../services/config.service'
import { getSpace, getAllSpacePaths } from '../../services/space.service'

// Helper: get working directory for a space
function getWorkingDir(spaceId: string): string {
  if (spaceId === 'halo-temp') {
    return join(getTempSpacePath(), 'artifacts')
  }
  const space = getSpace(spaceId)
  return space ? space.path : getTempSpacePath()
}

// Helper: collect all files in a directory recursively for tar-like output
function collectFiles(dir: string, baseDir: string, files: { path: string; fullPath: string }[] = []): { path: string; fullPath: string }[] {
  if (!existsSync(dir)) return files

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const fullPath = join(dir, entry.name)
    const relativePath = relative(baseDir, fullPath)

    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, files)
    } else {
      files.push({ path: relativePath, fullPath })
    }
  }
  return files
}

/**
 * Register all API routes
 */
export function registerApiRoutes(app: Express, mainWindow: BrowserWindow | null): void {
  // ===== Config Routes =====
  app.get('/api/config', async (req: Request, res: Response) => {
    const result = configController.getConfig()
    res.json(result)
  })

  app.post('/api/config', async (req: Request, res: Response) => {
    const result = configController.setConfig(req.body)
    res.json(result)
  })

  app.post('/api/config/validate', async (req: Request, res: Response) => {
    const { apiKey, apiUrl, provider } = req.body
    const result = await configController.validateApi(apiKey, apiUrl, provider)
    res.json(result)
  })

  // ===== Space Routes =====
  app.get('/api/spaces/halo', async (req: Request, res: Response) => {
    const result = spaceController.getHaloTempSpace()
    res.json(result)
  })

  // Get default space path (must be before :spaceId route)
  app.get('/api/spaces/default-path', async (req: Request, res: Response) => {
    try {
      const spacesDir = getSpacesDir()
      res.json({ success: true, data: spacesDir })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.get('/api/spaces', async (req: Request, res: Response) => {
    const result = spaceController.listSpaces()
    res.json(result)
  })

  app.post('/api/spaces', async (req: Request, res: Response) => {
    const { name, icon, customPath } = req.body
    const result = spaceController.createSpace({ name, icon, customPath })
    res.json(result)
  })

  app.get('/api/spaces/:spaceId', async (req: Request, res: Response) => {
    const result = spaceController.getSpace(req.params.spaceId)
    res.json(result)
  })

  app.put('/api/spaces/:spaceId', async (req: Request, res: Response) => {
    const result = spaceController.updateSpace(req.params.spaceId, req.body)
    res.json(result)
  })

  app.delete('/api/spaces/:spaceId', async (req: Request, res: Response) => {
    const result = spaceController.deleteSpace(req.params.spaceId)
    res.json(result)
  })

  // Note: openSpaceFolder doesn't make sense for remote access
  // We could return the path instead
  app.post('/api/spaces/:spaceId/open', async (req: Request, res: Response) => {
    // For remote access, just return the path
    const space = spaceController.getSpace(req.params.spaceId)
    if (space.success && space.data) {
      res.json({ success: true, data: { path: (space.data as any).path } })
    } else {
      res.json(space)
    }
  })

  // ===== Conversation Routes =====
  app.get('/api/spaces/:spaceId/conversations', async (req: Request, res: Response) => {
    const result = conversationController.listConversations(req.params.spaceId)
    res.json(result)
  })

  app.post('/api/spaces/:spaceId/conversations', async (req: Request, res: Response) => {
    const { title } = req.body
    const result = conversationController.createConversation(req.params.spaceId, title)
    res.json(result)
  })

  app.get('/api/spaces/:spaceId/conversations/:conversationId', async (req: Request, res: Response) => {
    const result = conversationController.getConversation(
      req.params.spaceId,
      req.params.conversationId
    )
    res.json(result)
  })

  app.put('/api/spaces/:spaceId/conversations/:conversationId', async (req: Request, res: Response) => {
    const result = conversationController.updateConversation(
      req.params.spaceId,
      req.params.conversationId,
      req.body
    )
    res.json(result)
  })

  app.delete('/api/spaces/:spaceId/conversations/:conversationId', async (req: Request, res: Response) => {
    const result = conversationController.deleteConversation(
      req.params.spaceId,
      req.params.conversationId
    )
    res.json(result)
  })

  app.post('/api/spaces/:spaceId/conversations/:conversationId/messages', async (req: Request, res: Response) => {
    const result = conversationController.addMessage(
      req.params.spaceId,
      req.params.conversationId,
      req.body
    )
    res.json(result)
  })

  app.put('/api/spaces/:spaceId/conversations/:conversationId/messages/last', async (req: Request, res: Response) => {
    const result = conversationController.updateLastMessage(
      req.params.spaceId,
      req.params.conversationId,
      req.body
    )
    res.json(result)
  })

  // ===== Agent Routes =====
  app.post('/api/agent/message', async (req: Request, res: Response) => {
    const { spaceId, conversationId, message, resumeSessionId, images, thinkingEnabled, aiBrowserEnabled } = req.body
    const result = await agentController.sendMessage(mainWindow, {
      spaceId,
      conversationId,
      message,
      resumeSessionId,
      images,  // Pass images for multi-modal messages (remote access)
      thinkingEnabled,  // Pass thinking mode for extended thinking (remote access)
      aiBrowserEnabled  // Pass AI Browser toggle for remote access
    })
    res.json(result)
  })

  app.post('/api/agent/stop', async (req: Request, res: Response) => {
    const { conversationId } = req.body
    const result = agentController.stopGeneration(conversationId)
    res.json(result)
  })

  app.post('/api/agent/approve', async (req: Request, res: Response) => {
    const { conversationId } = req.body
    const result = agentController.approveTool(conversationId)
    res.json(result)
  })

  app.post('/api/agent/reject', async (req: Request, res: Response) => {
    const { conversationId } = req.body
    const result = agentController.rejectTool(conversationId)
    res.json(result)
  })

  app.get('/api/agent/sessions', async (req: Request, res: Response) => {
    const result = agentController.listActiveSessions()
    res.json(result)
  })

  app.get('/api/agent/generating/:conversationId', async (req: Request, res: Response) => {
    const result = agentController.checkGenerating(req.params.conversationId)
    res.json(result)
  })

  // Get session state for recovery after refresh
  app.get('/api/agent/session/:conversationId', async (req: Request, res: Response) => {
    const result = agentController.getSessionState(req.params.conversationId)
    res.json(result)
  })

  // Test MCP server connections
  app.post('/api/agent/test-mcp', async (req: Request, res: Response) => {
    const result = await agentController.testMcpConnections(mainWindow)
    res.json(result)
  })

  // ===== Artifact Routes =====
  app.get('/api/spaces/:spaceId/artifacts', async (req: Request, res: Response) => {
    try {
      const artifacts = listArtifacts(req.params.spaceId)
      res.json({ success: true, data: artifacts })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Tree view of artifacts
  app.get('/api/spaces/:spaceId/artifacts/tree', async (req: Request, res: Response) => {
    try {
      const { listArtifactsTree } = await import('../../services/artifact.service')
      const tree = listArtifactsTree(req.params.spaceId)
      res.json({ success: true, data: tree })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Download single file
  app.get('/api/artifacts/download', async (req: Request, res: Response) => {
    try {
      const filePath = req.query.path as string
      if (!filePath) {
        res.status(400).json({ success: false, error: 'Missing file path' })
        return
      }

      // Security: ensure path is within allowed space directories
      const allowedPaths = getAllSpacePaths()
      const isAllowed = allowedPaths.some(spacePath => filePath.startsWith(spacePath))
      if (!isAllowed) {
        res.status(403).json({ success: false, error: 'Access denied' })
        return
      }

      if (!existsSync(filePath)) {
        res.status(404).json({ success: false, error: 'File not found' })
        return
      }

      const stats = statSync(filePath)
      const fileName = basename(filePath)

      if (stats.isDirectory()) {
        // For directories, create a simple tar.gz stream
        // Note: This is a simplified implementation. For production, use archiver package.
        const files = collectFiles(filePath, filePath)
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

        const readStream = createReadStream(filePath)
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

  console.log('[HTTP] API routes registered')
}
