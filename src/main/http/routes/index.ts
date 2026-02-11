/**
 * API Routes - REST API endpoints for remote access
 * Mirrors the IPC API structure
 */

import { Express, Request, Response } from 'express'
import { BrowserWindow, app as electronApp } from 'electron'
import { createReadStream, statSync, existsSync, readdirSync, realpathSync } from 'fs'
import { join, basename, relative, resolve, isAbsolute } from 'path'
import { createGzip } from 'zlib'
import { Readable } from 'stream'

import * as agentController from '../../controllers/agent.controller'
import * as spaceController from '../../controllers/space.controller'
import * as conversationController from '../../controllers/conversation.controller'
import * as configController from '../../controllers/config.controller'
import { getEnabledAuthProviderConfigs } from '../../services/ai-sources'
import {
  listArtifacts,
  listArtifactsTree,
  loadTreeChildren,
  readArtifactContent,
  saveArtifactContent,
  detectFileType
} from '../../services/artifact.service'
import { getTempSpacePath, getSpacesDir } from '../../services/config.service'
import { getSpace, getAllSpacePaths } from '../../services/space.service'

// Helper: get working directory for a space
function getWorkingDir(spaceId: string): string {
  if (spaceId === 'halo-temp') {
    return join(getTempSpacePath(), 'artifacts')
  }
  const space = getSpace(spaceId)
  return space ? (space.workingDir || space.path) : getTempSpacePath()
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
 * Check if target path is inside base path.
 * Uses realpathSync to resolve symlinks and prevent symlink-based path traversal attacks.
 */
function isPathInside(target: string, base: string): boolean {
  try {
    // Use realpathSync to resolve symlinks for security
    const realBase = realpathSync(base)
    const realTarget = realpathSync(target)
    const relativePath = relative(realBase, realTarget)
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  } catch {
    // If path doesn't exist or can't be resolved, deny access
    return false
  }
}

/**
 * Check if target path is allowed (inside any space directory).
 * Resolves symlinks to prevent directory traversal via symlinks.
 */
function isPathAllowed(target: string): boolean {
  // First check if path exists
  if (!existsSync(target)) {
    return false
  }

  try {
    const realTarget = realpathSync(target)
    const allowedBases = getAllSpacePaths().filter(p => existsSync(p))
    return allowedBases.some(base => {
      try {
        const realBase = realpathSync(base)
        const relativePath = relative(realBase, realTarget)
        return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

function validateFilePath(res: Response, filePath?: string): string | null {
  if (!filePath) {
    res.status(400).json({ success: false, error: 'Missing file path' })
    return null
  }

  if (!isPathAllowed(filePath)) {
    res.status(403).json({ success: false, error: 'Access denied' })
    return null
  }

  return resolve(filePath)
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
    const { apiKey, apiUrl, provider, model } = req.body
    const result = await configController.validateApi(apiKey, apiUrl, provider, model)
    res.json(result)
  })

  // ===== Auth Routes (Read-only for remote access) =====
  // Remote clients use host machine's auth state, no login operations needed
  app.get('/api/auth/providers', async (req: Request, res: Response) => {
    try {
      const providers = getEnabledAuthProviderConfigs()
      res.json({ success: true, data: providers })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
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

  app.get('/api/spaces/:spaceId/conversations/:conversationId/messages/:messageId/thoughts', async (req: Request, res: Response) => {
    const result = conversationController.getMessageThoughts(
      req.params.spaceId,
      req.params.conversationId,
      req.params.messageId
    )
    res.json(result)
  })

  // Toggle starred status
  app.post('/api/spaces/:spaceId/conversations/:conversationId/star', async (req: Request, res: Response) => {
    const { starred } = req.body
    const result = conversationController.toggleStarConversation(
      req.params.spaceId,
      req.params.conversationId,
      starred
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

  // Answer a pending AskUserQuestion
  app.post('/api/agent/answer-question', async (req: Request, res: Response) => {
    const { conversationId, id, answers } = req.body
    const result = agentController.answerQuestion(conversationId, id, answers)
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
      const artifacts = await listArtifacts(req.params.spaceId)
      res.json({ success: true, data: artifacts })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // Tree view of artifacts
  app.get('/api/spaces/:spaceId/artifacts/tree', async (req: Request, res: Response) => {
    try {
      const tree = await listArtifactsTree(req.params.spaceId)
      res.json({ success: true, data: tree })
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

  // ===== System Routes =====
  app.get('/api/system/version', async (req: Request, res: Response) => {
    try {
      const version = electronApp.getVersion()
      res.json({ success: true, data: version })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  console.log('[HTTP] API routes registered')
}
