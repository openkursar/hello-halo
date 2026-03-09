/**
 * API Routes - REST API endpoints for remote access
 * Mirrors the IPC API structure
 */

import { Express, Request, Response } from 'express'
import { app as electronApp } from 'electron'
import { createReadStream, statSync, existsSync, readdirSync, realpathSync } from 'fs'
import { join, basename, relative, resolve, isAbsolute } from 'path'
import { createGzip } from 'zlib'
import { Readable } from 'stream'

import * as agentController from '../../controllers/agent.controller'
import * as spaceController from '../../controllers/space.controller'
import * as conversationController from '../../controllers/conversation.controller'
import * as configController from '../../controllers/config.controller'
import { getEnabledAuthProviderConfigs, getAISourceManager } from '../../services/ai-sources'
import { testChannel, clearAllTokenCaches } from '../../services/notify-channels'
import type { NotificationChannelType } from '../../../shared/types/notification-channels'
import {
  listArtifacts,
  listArtifactsTree,
  loadTreeChildren,
  readArtifactContent,
  saveArtifactContent,
  detectFileType
} from '../../services/artifact.service'
import { getTempSpacePath, getSpacesDir, getConfig as getServiceConfig } from '../../services/config.service'
import { getSpace, getAllSpacePaths } from '../../services/space.service'
import { getAppManager } from '../../apps/manager'
import { getAppRuntime, sendAppChatMessage, stopAppChat, isAppChatGenerating, loadAppChatMessages, getAppChatSessionState, getAppChatConversationId } from '../../apps/runtime'
import type { AppListFilter, UninstallOptions } from '../../apps/manager'
import type { ActivityQueryOptions, EscalationResponse, AppChatRequest } from '../../apps/runtime'
import { readSessionMessages } from '../../apps/runtime/session-store'
import { broadcastToAll } from '../websocket'
import * as appController from '../../controllers/app.controller'
import type { AppErrorCode } from '../../controllers/app.controller'
import * as storeController from '../../controllers/store.controller'

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
export function registerApiRoutes(app: Express): void {
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

  app.post('/api/config/fetch-models', async (req: Request, res: Response) => {
    const { apiKey, apiUrl } = req.body
    const result = await configController.fetchModels(apiKey, apiUrl)
    res.json(result)
  })

  // ===== AI Sources CRUD Routes (atomic operations) =====
  // These routes read from disk before writing, ensuring rotating tokens are never overwritten.

  app.post('/api/ai-sources/switch-source', async (req: Request, res: Response) => {
    try {
      const { sourceId } = req.body
      const manager = getAISourceManager()
      const result = manager.setCurrentSource(sourceId)
      if (result.currentId !== sourceId) {
        res.json({ success: false, error: `Source not found: ${sourceId}` })
        return
      }
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/ai-sources/set-model', async (req: Request, res: Response) => {
    try {
      const { modelId } = req.body
      const manager = getAISourceManager()
      const result = manager.setCurrentModel(modelId)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/ai-sources/sources', async (req: Request, res: Response) => {
    try {
      const manager = getAISourceManager()
      const result = manager.addSource(req.body)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.put('/api/ai-sources/sources/:sourceId', async (req: Request, res: Response) => {
    try {
      const manager = getAISourceManager()
      const result = manager.updateSource(req.params.sourceId, req.body)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.delete('/api/ai-sources/sources/:sourceId', async (req: Request, res: Response) => {
    try {
      const manager = getAISourceManager()
      const result = manager.deleteSource(req.params.sourceId)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
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
    const result = await spaceController.deleteSpace(req.params.spaceId)
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
    const result = await agentController.sendMessage({
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
    const result = await agentController.testMcpConnections()
    res.json(result)
  })

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

  // ===== Notification Channels Routes =====
  app.post('/api/notify-channels/test', async (req: Request, res: Response) => {
    try {
      const { channelType } = req.body as { channelType?: string }
      if (!channelType) {
        res.status(400).json({ success: false, error: 'Missing channelType' })
        return
      }
      const config = getServiceConfig()
      const channelsConfig = config.notificationChannels
      if (!channelsConfig) {
        res.json({ success: false, error: 'No notification channels configured' })
        return
      }
      const result = await testChannel(channelType as NotificationChannelType, channelsConfig)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  app.post('/api/notify-channels/clear-cache', async (req: Request, res: Response) => {
    try {
      clearAllTokenCaches()
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
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

  // ===== Apps Routes =====

  // Helper: get manager or return 503
  function getManagerOrFail(res: Response): ReturnType<typeof getAppManager> {
    const manager = getAppManager()
    if (!manager) {
      res.status(503).json({ success: false, error: 'App Manager is not yet initialized. Please try again shortly.' })
    }
    return manager
  }

  // Helper: get runtime or return 503
  function getRuntimeOrFail(res: Response): ReturnType<typeof getAppRuntime> {
    const runtime = getAppRuntime()
    if (!runtime) {
      res.status(503).json({ success: false, error: 'App Runtime is not yet initialized. Please try again shortly.' })
    }
    return runtime
  }

  // GET /api/apps — list all installed Apps, optional ?spaceId= and ?status=
  app.get('/api/apps', async (req: Request, res: Response) => {
    try {
      const manager = getManagerOrFail(res)
      if (!manager) return
      const filter: AppListFilter = {}
      if (typeof req.query.spaceId === 'string' && req.query.spaceId) {
        filter.spaceId = req.query.spaceId
      }
      if (typeof req.query.status === 'string' && req.query.status) {
        filter.status = req.query.status as AppListFilter['status']
      }
      let apps = manager.listApps(filter)
      // By default, exclude uninstalled apps unless explicitly requested
      if (!req.query.status) {
        apps = apps.filter(app => app.status !== 'uninstalled')
      }
      console.log('[HTTP] GET /api/apps: count=%d', apps.length)
      res.json({ success: true, data: apps })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/install — install an App
  app.post('/api/apps/install', async (req: Request, res: Response) => {
    try {
      const manager = getManagerOrFail(res)
      if (!manager) return
      const { spaceId, spec, userConfig } = req.body as {
        spaceId?: string | null
        spec?: unknown
        userConfig?: Record<string, unknown>
      }
      // spaceId may be null for global installs (MCP/Skill available across all spaces)
      if (spaceId !== null && spaceId !== undefined && typeof spaceId !== 'string') {
        res.status(400).json({ success: false, error: 'spaceId must be a string or null' })
        return
      }
      const resolvedSpaceId = spaceId || null
      if (!spec || typeof spec !== 'object') {
        res.status(400).json({ success: false, error: 'Missing required field: spec' })
        return
      }
      const appId = await manager.install(resolvedSpaceId, spec as import('../../apps/spec').AppSpec, userConfig)

      // Auto-activate in runtime if available
      const runtime = getAppRuntime()
      if (runtime && (spec as { type?: string }).type === 'automation') {
        await runtime.activate(appId).catch((err: Error) => {
          console.warn(`[HTTP] POST /api/apps/install -- runtime activate failed (non-fatal): ${err.message}`)
        })
      }

      console.log('[HTTP] POST /api/apps/install: appId=%s, space=%s', appId, resolvedSpaceId ?? 'global')
      res.json({ success: true, data: { appId } })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/apps/:appId — get a single App
  app.get('/api/apps/:appId', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      const appData = manager.getApp(appId)
      res.json({ success: true, data: appData })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/apps/:appId — uninstall (soft-delete) an App
  app.delete('/api/apps/:appId', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return

      // Deactivate in runtime first
      const runtime = getAppRuntime()
      if (runtime) {
        await runtime.deactivate(appId).catch((err: Error) => {
          console.warn(`[HTTP] DELETE /api/apps/:appId -- runtime deactivate failed (non-fatal): ${err.message}`)
        })
      }

      const options: UninstallOptions = {}
      if (req.query.purge === 'true') options.purge = true
      await manager.uninstall(appId, options)
      console.log('[HTTP] DELETE /api/apps/%s', appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/reinstall — reinstall a previously uninstalled App
  app.post('/api/apps/:appId/reinstall', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return

      manager.reinstall(appId)

      // Re-activate in runtime
      const runtime = getAppRuntime()
      let activationWarning: string | undefined
      if (runtime) {
        try {
          await runtime.activate(appId)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.warn(`[HTTP] POST /api/apps/:appId/reinstall -- runtime activate failed: ${errMsg}`)
          activationWarning = errMsg
        }
      }

      console.log('[HTTP] POST /api/apps/%s/reinstall', appId)
      res.json({ success: true, data: { activationWarning } })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/move-space — move an App to a different space (or global)
  app.post('/api/apps/:appId/move-space', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return

      const { newSpaceId } = req.body as { newSpaceId?: string | null }
      if (newSpaceId !== null && (typeof newSpaceId !== 'string' || !newSpaceId)) {
        res.status(400).json({ success: false, error: 'newSpaceId must be a non-empty string or null' })
        return
      }

      const appData = manager.getApp(appId)
      if (!appData) {
        res.status(404).json({ success: false, error: `App not found: ${appId}` })
        return
      }

      // For automation apps that are active: deactivate before moving so the
      // scheduler and event router don't hold stale space references, then
      // re-activate after the move completes.
      const isAutomation = appData.spec.type === 'automation'
      const wasActive = appData.status === 'active'
      const runtime = getAppRuntime()

      if (isAutomation && wasActive && runtime) {
        await runtime.deactivate(appId).catch((err: Error) => {
          console.warn(`[HTTP] POST /api/apps/:appId/move-space -- runtime deactivate failed (non-fatal): ${err.message}`)
        })
      }

      await manager.moveToSpace(appId, newSpaceId ?? null)

      // Re-activate automation apps that were running before the move
      let activationWarning: string | undefined
      if (isAutomation && wasActive && runtime) {
        try {
          await runtime.activate(appId)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.warn(`[HTTP] POST /api/apps/:appId/move-space -- runtime activate failed: ${errMsg}`)
          activationWarning = errMsg
        }
      }

      console.log('[HTTP] POST /api/apps/%s/move-space: newSpaceId=%s', appId, newSpaceId ?? 'global')
      res.json({ success: true, data: { activationWarning } })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/apps/:appId/permanent — permanently delete an uninstalled App
  app.delete('/api/apps/:appId/permanent', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return

      await manager.deleteApp(appId)
      broadcastToAll('app:deleted', { appId })
      console.log('[HTTP] DELETE /api/apps/%s/permanent', appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/pause — pause an App
  app.post('/api/apps/:appId/pause', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      manager.pause(appId)

      const runtime = getAppRuntime()
      if (runtime) {
        await runtime.deactivate(appId).catch((err: Error) => {
          console.warn(`[HTTP] POST /api/apps/:appId/pause -- runtime deactivate failed (non-fatal): ${err.message}`)
        })
      }

      console.log('[HTTP] POST /api/apps/%s/pause', appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/resume — resume an App
  app.post('/api/apps/:appId/resume', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      manager.resume(appId)

      const runtime = getAppRuntime()
      if (runtime) {
        await runtime.activate(appId).catch((err: Error) => {
          console.warn(`[HTTP] POST /api/apps/:appId/resume -- runtime activate failed (non-fatal): ${err.message}`)
        })
      }

      console.log('[HTTP] POST /api/apps/%s/resume', appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/trigger — manually trigger a run
  app.post('/api/apps/:appId/trigger', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const runtime = getRuntimeOrFail(res)
      if (!runtime) return
      const result = await runtime.triggerManually(appId)
      console.log('[HTTP] POST /api/apps/%s/trigger: outcome=%s', appId, result.outcome)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/apps/:appId/activity — get activity entries
  app.get('/api/apps/:appId/activity', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const runtime = getRuntimeOrFail(res)
      if (!runtime) return
      const options: ActivityQueryOptions = {}
      if (req.query.limit) options.limit = Number(req.query.limit)
      if (req.query.before) options.since = Number(req.query.before)
      const entries = runtime.getActivityEntries(appId, options)
      res.json({ success: true, data: entries })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/escalation/:entryId/respond — respond to escalation
  app.post('/api/apps/:appId/escalation/:entryId/respond', async (req: Request, res: Response) => {
    try {
      const { appId, entryId } = req.params
      if (!appId || !entryId) {
        res.status(400).json({ success: false, error: 'Missing appId or entryId' })
        return
      }
      const runtime = getRuntimeOrFail(res)
      if (!runtime) return
      const { choice, text } = req.body as { choice?: string; text?: string }
      const response: EscalationResponse = {
        ts: Date.now(),
        choice,
        text,
      }
      await runtime.respondToEscalation(appId, entryId, response)
      console.log('[HTTP] POST /api/apps/%s/escalation/%s/respond', appId, entryId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/apps/:appId/runs/:runId/session — get session messages for "View process"
  app.get('/api/apps/:appId/runs/:runId/session', async (req: Request, res: Response) => {
    try {
      const { appId, runId } = req.params
      if (!appId || !runId) {
        res.status(400).json({ success: false, error: 'Missing appId or runId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return

      const appData = manager.getApp(appId)
      if (!appData) {
        res.status(404).json({ success: false, error: `App not found: ${appId}` })
        return
      }

      const space = appData.spaceId ? getSpace(appData.spaceId) : null
      if (!space?.path) {
        res.status(404).json({ success: false, error: `Space not found for app: ${appId}` })
        return
      }

      const messages = readSessionMessages(space.path, appId, runId)
      res.json({ success: true, data: messages })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/config — update user configuration
  app.post('/api/apps/:appId/config', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      const config = req.body as Record<string, unknown>
      manager.updateConfig(appId, config)
      console.log('[HTTP] POST /api/apps/%s/config', appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/frequency — update subscription frequency override
  app.post('/api/apps/:appId/frequency', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      const { subscriptionId, frequency } = req.body as { subscriptionId?: string; frequency?: string }
      if (!subscriptionId || !frequency) {
        res.status(400).json({ success: false, error: 'Missing subscriptionId or frequency' })
        return
      }
      manager.updateFrequency(appId, subscriptionId, frequency)
      console.log('[HTTP] POST /api/apps/%s/frequency: sub=%s', appId, subscriptionId)

      // Hot-sync scheduler job so the new frequency takes effect immediately
      const runtime = getAppRuntime()
      if (runtime) {
        runtime.syncAppSchedule(appId)
      }

      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // PATCH /api/apps/:appId/spec — update app spec (JSON Merge Patch)
  app.patch('/api/apps/:appId/spec', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      const specPatch = req.body as Record<string, unknown>
      manager.updateSpec(appId, specPatch)

      // Reactivate runtime if subscriptions changed
      if (specPatch.subscriptions) {
        const runtime = getAppRuntime()
        const appData = manager.getApp(appId)
        if (runtime && appData?.status === 'active') {
          await runtime.deactivate(appId).catch(() => {})
          await runtime.activate(appId).catch((err: Error) => {
            console.warn('[HTTP] PATCH /api/apps/:appId/spec -- reactivation failed (non-fatal): %s', err.message)
          })
        }
      }

      console.log('[HTTP] PATCH /api/apps/%s/spec', appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/apps/:appId/state — get real-time AutomationAppState
  app.get('/api/apps/:appId/state', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const runtime = getRuntimeOrFail(res)
      if (!runtime) return
      const state = runtime.getAppState(appId)
      res.json({ success: true, data: state })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // ── App Export / Import Routes ──────────────────────────────────────────

  // Map controller error codes to HTTP status codes
  const appErrorStatus: Record<AppErrorCode, number> = {
    NOT_INITIALIZED: 503,
    NOT_FOUND: 404,
    INVALID_YAML: 400,
    VALIDATION_FAILED: 422,
  }

  // GET /api/apps/:appId/export-spec — export app spec as YAML
  app.get('/api/apps/:appId/export-spec', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }

      const result = appController.exportSpec(appId)
      if (!result.success) {
        const status = result.code ? appErrorStatus[result.code] : 400
        res.status(status).json({ success: false, error: result.error })
        return
      }

      console.log('[HTTP] GET /api/apps/%s/export-spec', appId)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/import-spec — install an app from a YAML spec string
  app.post('/api/apps/import-spec', async (req: Request, res: Response) => {
    try {
      const { spaceId, yamlContent, userConfig } = req.body as {
        spaceId?: string
        yamlContent?: string
        userConfig?: Record<string, unknown>
      }

      if (!spaceId || typeof spaceId !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid spaceId' })
        return
      }
      if (!yamlContent || typeof yamlContent !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid yamlContent' })
        return
      }

      const result = await appController.importSpec({ spaceId, yamlContent, userConfig })
      if (!result.success) {
        const status = result.code ? appErrorStatus[result.code] : 400
        res.status(status).json({ success: false, error: result.error })
        return
      }

      console.log('[HTTP] POST /api/apps/import-spec: appId=%s, space=%s', result.data.appId, spaceId)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // ── App Chat Routes ─────────────────────────────────────────────────────

  // POST /api/apps/:appId/chat/send — send a chat message to an App's AI agent
  app.post('/api/apps/:appId/chat/send', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const runtime = getRuntimeOrFail(res)
      if (!runtime) return
      const request: AppChatRequest = { ...req.body, appId }
      sendAppChatMessage(request).catch((error: unknown) => {
        const err = error as Error
        console.error(`[HTTP] POST /api/apps/:appId/chat/send background error:`, err.message)
      })
      console.log('[HTTP] POST /api/apps/%s/chat/send', appId)
      res.json({
        success: true,
        data: { conversationId: getAppChatConversationId(appId) }
      })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/chat/stop — stop an active app chat generation
  app.post('/api/apps/:appId/chat/stop', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      await stopAppChat(appId)
      console.log('[HTTP] POST /api/apps/%s/chat/stop', appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/apps/:appId/chat/status — get app chat status
  app.get('/api/apps/:appId/chat/status', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      res.json({
        success: true,
        data: {
          isGenerating: isAppChatGenerating(appId),
          conversationId: getAppChatConversationId(appId),
        }
      })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/apps/:appId/chat/messages — load persisted chat messages
  app.get('/api/apps/:appId/chat/messages', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      const appData = manager.getApp(appId)
      if (!appData) {
        res.status(404).json({ success: false, error: `App not found: ${appId}` })
        return
      }
      const space = appData.spaceId ? getSpace(appData.spaceId) : null
      if (!space?.path) {
        res.json({ success: true, data: [] })
        return
      }
      const messages = loadAppChatMessages(space.path, appId)
      res.json({ success: true, data: messages })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/apps/:appId/chat/session-state — get session state for recovery
  app.get('/api/apps/:appId/chat/session-state', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const state = getAppChatSessionState(appId)
      res.json({ success: true, data: state })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // ===== Store (App Registry) Routes =====

  // POST /api/store/query — paginated query (new primary entry point)
  app.post('/api/store/query', async (req: Request, res: Response) => {
    try {
      const { search, type, category, page, pageSize, locale } = req.body as Record<string, unknown>
      const result = await storeController.queryStoreApps({
        search: typeof search === 'string' ? search : undefined,
        type: typeof type === 'string' ? type : undefined,
        category: typeof category === 'string' ? category : undefined,
        page: typeof page === 'number' ? page : undefined,
        pageSize: typeof pageSize === 'number' ? pageSize : undefined,
        locale: typeof locale === 'string' ? locale : undefined,
      })
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/store/apps — list apps from the store (legacy compat)
  app.get('/api/store/apps', async (req: Request, res: Response) => {
    try {
      const query: { search?: string; locale?: string; category?: string; type?: string; tags?: string[] } = {}
      if (typeof req.query.search === 'string') query.search = req.query.search
      if (typeof req.query.locale === 'string') query.locale = req.query.locale
      if (typeof req.query.category === 'string') query.category = req.query.category
      if (typeof req.query.type === 'string') query.type = req.query.type
      if (typeof req.query.tags === 'string') {
        query.tags = req.query.tags.split(',').map(tag => tag.trim()).filter(Boolean)
      } else if (Array.isArray(req.query.tags)) {
        query.tags = req.query.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map(tag => tag.trim())
          .filter(Boolean)
      }
      const result = await storeController.listStoreApps(query)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/store/apps/:slug — get store app detail
  app.get('/api/store/apps/:slug', async (req: Request, res: Response) => {
    try {
      const result = await storeController.getStoreAppDetail(req.params.slug)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/install — install an app from the store
  app.post('/api/store/install', async (req: Request, res: Response) => {
    try {
      const { slug, spaceId, userConfig } = req.body as {
        slug?: string
        spaceId?: string | null
        userConfig?: Record<string, unknown>
      }
      if (!slug || typeof slug !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: slug' })
        return
      }
      // spaceId may be null for global installs (MCP/Skill available across all spaces)
      const resolvedSpaceId = spaceId || null
      const result = await storeController.installStoreApp(slug, resolvedSpaceId, userConfig)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/apps/:slug/install — REST-style install route
  app.post('/api/store/apps/:slug/install', async (req: Request, res: Response) => {
    try {
      const slug = req.params.slug
      const { spaceId, userConfig } = req.body as {
        spaceId?: string | null
        userConfig?: Record<string, unknown>
      }
      if (!slug || typeof slug !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required param: slug' })
        return
      }
      // spaceId may be null for global installs (MCP/Skill available across all spaces)
      const resolvedSpaceId = spaceId || null
      const result = await storeController.installStoreApp(slug, resolvedSpaceId, userConfig)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/refresh — refresh the registry index
  app.post('/api/store/refresh', async (req: Request, res: Response) => {
    try {
      const result = await storeController.refreshStoreIndex()
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/store/updates — check for available updates
  app.get('/api/store/updates', async (req: Request, res: Response) => {
    try {
      const result = await storeController.checkStoreUpdates()
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // GET /api/store/registries — get configured registry sources
  app.get('/api/store/registries', async (req: Request, res: Response) => {
    try {
      const result = storeController.getStoreRegistries()
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/registries — add a new registry source
  app.post('/api/store/registries', async (req: Request, res: Response) => {
    try {
      const result = storeController.addStoreRegistry(req.body)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/store/registries/:registryId — remove a registry source
  app.delete('/api/store/registries/:registryId', async (req: Request, res: Response) => {
    try {
      const result = storeController.removeStoreRegistry(req.params.registryId)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/store/registries/:registryId/toggle — enable or disable a registry source
  app.post('/api/store/registries/:registryId/toggle', async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body as { enabled?: boolean }
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'Missing required field: enabled' })
        return
      }
      const result = storeController.toggleStoreRegistry(req.params.registryId, enabled)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // PATCH /api/store/registries/:registryId/adapter-config — update adapter config (e.g. API keys)
  app.patch('/api/store/registries/:registryId/adapter-config', async (req: Request, res: Response) => {
    try {
      const adapterConfig = req.body as Record<string, unknown>
      if (!adapterConfig || typeof adapterConfig !== 'object' || Array.isArray(adapterConfig)) {
        res.status(400).json({ success: false, error: 'Request body must be a JSON object' })
        return
      }
      const result = storeController.updateStoreRegistryAdapterConfig(req.params.registryId, adapterConfig)
      res.json(result)
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  console.log('[HTTP] API routes registered')
}
