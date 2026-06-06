/**
 * Apps REST API routes (remote access).
 * Split from the monolithic routes/index.ts; mirrors the IPC API for this domain.
 */
import type { Express, Request, Response } from 'express'
import {
  AppAlreadyInstalledError,
  MCP_COMMAND_BLOCKED,
  McpCommandBlockedError,
  appController,
  broadcastToAll,
  clearAppChat,
  clearImSession,
  getAppChatConversationId,
  getAppChatSessionState,
  getAppManager,
  getAppRuntime,
  getSpace,
  isAppChatGenerating,
  isMcpAppSpec,
  loadAppChatMessages,
  loadImChatMessages,
  patchTouchesMcp,
  readSessionMessages,
  rejectIfRemoteMcpForbidden,
  restartAppChat,
  sendAppChatMessage,
  stopAppChat,
  writeMcpCommandBlockedResponse,
  yamlIsMcpSpec,
} from './_shared'
import type {
  ActivityQueryOptions,
  AppChatRequest,
  AppErrorCode,
  AppListFilter,
  EscalationResponse,
  InstalledApp,
  UninstallOptions,
} from './_shared'

export function registerAppsRoutes(app: Express): void {
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
    // Remote-MCP gating is a transport-boundary policy (response shape differs
    // per transport), so it stays here, before the shared controller call.
    if (rejectIfRemoteMcpForbidden(res, () => isMcpAppSpec(spec), 'POST /api/apps/install')) return

    // Shared install + activate orchestration. HTTP keeps its original
    // "activate automation apps only" semantics via activateNonAutomation:false.
    const result = await appController.installApp(
      resolvedSpaceId,
      spec as import('../../apps/spec').AppSpec,
      userConfig,
      { activateNonAutomation: false },
    )
    if (result.success) {
      console.log('[HTTP] POST /api/apps/install: appId=%s, space=%s', result.data.appId, resolvedSpaceId ?? 'global')
      res.json(result)
      return
    }
    const status = result.code === 'NOT_INITIALIZED' ? 503
      : result.code === 'MCP_COMMAND_BLOCKED' ? 403
      : result.code === 'ALREADY_INSTALLED' ? 409
      : 200
    res.status(status).json(result)
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

  // POST /api/apps/:appId/clear-memory — delete all memory files for an App
  app.post('/api/apps/:appId/clear-memory', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return

      const filesRemoved = manager.clearAppMemory(appId)
      console.log('[HTTP] POST /api/apps/%s/clear-memory: filesRemoved=%d', appId, filesRemoved)
      res.json({ success: true, data: { filesRemoved } })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // DELETE /api/apps/:appId/permanent — permanently delete an App and all its data
  // External callers must NOT be able to bypass the built-in protection guard.
  // We deliberately do NOT forward any options from the request body — built-in
  // apps will fail with BuiltinAppProtectedError as designed.
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
      const err = error as Error
      // Preserve errorName so HTTP clients can route by discriminator and
      // surface a localized message for built-in protection (and other
      // discriminated errors like AppNotFoundError).
      res.json({ success: false, error: err.message, errorName: err.name })
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

  // POST /api/apps/:appId/runs/:runId/continue — user-initiated continue for premature-stop errors
  app.post('/api/apps/:appId/runs/:runId/continue', async (req: Request, res: Response) => {
    try {
      const { appId, runId } = req.params
      if (!appId || !runId) {
        res.status(400).json({ success: false, error: 'Missing appId or runId' })
        return
      }
      const runtime = getRuntimeOrFail(res)
      if (!runtime) return
      await runtime.continueFailedRun(appId, runId)
      console.log('[HTTP] POST /api/apps/%s/runs/%s/continue', appId, runId)
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

  // PATCH /api/apps/:appId/overrides — update user overrides (JSON Merge Patch semantics)
  // `null` values delete the corresponding key from the stored overrides object.
  // This mirrors the IPC `app:update-overrides` handler. The null-delete convention is
  // required because JSON serialization strips `undefined`, so the client sends `null`
  // to signal "clear this field" (e.g. reset per-app model to follow global).
  app.patch('/api/apps/:appId/overrides', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      const patch = req.body as Record<string, unknown>
      manager.updateOverrides(appId, patch as InstalledApp['userOverrides'])
      console.log('[HTTP] PATCH /api/apps/%s/overrides', appId)
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
        runtime.syncAppSubscriptions(appId)
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
      // Guard both directions: a patch touching mcp_server/type, OR a patch
      // against an app that is already type=mcp (any field change there
      // could re-persist a malicious command).
      if (
        rejectIfRemoteMcpForbidden(
          res,
          () => patchTouchesMcp(specPatch) || isMcpAppSpec(manager.getApp(appId)?.spec),
          'PATCH /api/apps/:appId/spec',
        )
      ) return
      manager.updateSpec(appId, specPatch)

      // Hot-sync subscriptions if subscriptions changed.
      // Uses syncAppSubscriptions() instead of deactivate/activate to avoid
      // aborting any currently running execution for this app.
      if (specPatch.subscriptions) {
        const runtime = getAppRuntime()
        if (runtime) {
          runtime.syncAppSubscriptions(appId)
        }
      }

      console.log('[HTTP] PATCH /api/apps/%s/spec', appId)
      res.json({ success: true })
    } catch (error) {
      if (error instanceof McpCommandBlockedError) {
        writeMcpCommandBlockedResponse(res, error, 'PATCH /api/apps/:appId/spec')
        return
      }
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
    ALREADY_INSTALLED: 409,
    MCP_COMMAND_BLOCKED: 403,
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
        res.status(status).json({ success: false, error: result.error, code: result.code })
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

      if (
        rejectIfRemoteMcpForbidden(
          res,
          () => yamlIsMcpSpec(yamlContent),
          'POST /api/apps/import-spec',
        )
      ) return

      const result = await appController.importSpec({ spaceId, yamlContent, userConfig })
      if (!result.success) {
        const status = result.code ? appErrorStatus[result.code] : 400
        res.status(status).json({ success: false, error: result.error, code: result.code })
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

  // GET /api/apps/:appId/im-chat/messages — load persisted IM chat messages
  app.get('/api/apps/:appId/im-chat/messages', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const channel = typeof req.query.channel === 'string' ? req.query.channel : ''
      const chatType = req.query.chatType === 'group' ? 'group' as const : 'direct' as const
      const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : ''
      const spaceId = typeof req.query.spaceId === 'string' ? req.query.spaceId : ''
      if (!channel || !chatId || !spaceId) {
        res.status(400).json({ success: false, error: 'Missing required query params: channel, chatId, spaceId' })
        return
      }
      const manager = getManagerOrFail(res)
      if (!manager) return
      const appData = manager.getApp(appId)
      if (!appData) {
        res.status(404).json({ success: false, error: 'App not found' })
        return
      }
      const space = getSpace(appData.spaceId ?? spaceId)
      if (!space?.path) {
        res.json({ success: true, data: [] })
        return
      }
      const messages = loadImChatMessages(space.path, appId, channel, chatType, chatId)
      res.json({ success: true, data: messages })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/chat/clear — clear native Halo chat session
  app.post('/api/apps/:appId/chat/clear', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const { spaceId } = req.body as { spaceId?: string }
      if (!spaceId) {
        res.status(400).json({ success: false, error: 'Missing spaceId in body' })
        return
      }
      await clearAppChat(appId, spaceId)
      console.log('[HTTP] POST /api/apps/%s/chat/clear', appId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/chat/restart — restart all chat sessions for an app
  // Closes the CC subprocesses so the next message reloads the system prompt
  // and config. Conversation history is preserved via saved sessionId.
  app.post('/api/apps/:appId/chat/restart', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const result = await restartAppChat(appId)
      console.log('[HTTP] POST /api/apps/%s/chat/restart: closed=%d', appId, result.sessionsClosed)
      res.json({ success: true, data: result })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

  // POST /api/apps/:appId/im-chat/clear — clear an IM session
  app.post('/api/apps/:appId/im-chat/clear', async (req: Request, res: Response) => {
    try {
      const { appId } = req.params
      if (!appId) {
        res.status(400).json({ success: false, error: 'Missing appId' })
        return
      }
      const { spaceId, channel, chatType, chatId } = req.body as {
        spaceId?: string; channel?: string; chatType?: string; chatId?: string
      }
      if (!spaceId || !channel || !chatType || !chatId) {
        res.status(400).json({ success: false, error: 'Missing required body params: spaceId, channel, chatType, chatId' })
        return
      }
      const resolvedChatType = chatType === 'group' ? 'group' as const : 'direct' as const
      await clearImSession(appId, spaceId, channel, resolvedChatType, chatId)
      console.log('[HTTP] POST /api/apps/%s/im-chat/clear channel=%s chatId=%s', appId, channel, chatId)
      res.json({ success: true })
    } catch (error) {
      res.json({ success: false, error: (error as Error).message })
    }
  })

}
