/**
 * Store IPC Handlers
 *
 * Exposes the Store (App Registry) operations to the renderer process.
 *
 * Channels:
 *   store:query                          Paginated query (new primary entry point)
 *   store:list-apps                      List apps from the store with optional filtering
 *   store:get-app-detail                 Get detailed info about a store app by slug
 *   store:get-app-document               Get SKILL.md/README document for a store app
 *   store:install                        Install an app from the store into a space
 *   store:refresh                        Refresh the registry index from remote sources
 *   store:check-updates                  Check for available updates for installed apps
 *   store:get-registries                 Get the list of configured registry sources
 *   store:add-registry                   Add a new registry source
 *   store:remove-registry                Remove a registry source
 *   store:toggle-registry                Enable or disable a registry source
 *   store:update-registry-adapter-config Update adapter config (e.g. API keys) for a registry
 */

import { ipcMain, dialog } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import * as storeController from '../controllers/store.controller'
import {
  onSyncStatusChanged,
  onUpgradeAvailable,
  applyUpgrade,
  checkUpgradesNow,
  publish,
  getPublishPreview,
  collectFiles,
  packDhpkg,
  unpackDhpkg,
} from '../store'
import { getAppManager } from '../apps/manager'
import { getAppRuntime } from '../apps/runtime'
import { sendToRenderer } from '../foundation/window.service'
import type { StoreInstallProgress } from '../../shared/store/store-types'
import { storeRpc } from '../../shared/rpc/contracts/store.contract'
import { registerRawRpcHandlers } from './rpc'

export function registerStoreHandlers(): void {
  registerRawRpcHandlers(storeRpc, {
    // ── store:query (new primary entry point) ─────────────────────────────
    storeQuery: async (params: { search?: string; type?: string; category?: string; page?: number; pageSize?: number; locale?: string }) => {
      return storeController.queryStoreApps(params)
    },

    // ── store:list-apps (legacy compat) ─────────────────────────────────
    storeListApps: async (query?: { search?: string; category?: string; type?: string; tags?: string[] }) => {
      return storeController.listStoreApps(query)
    },

    // ── store:get-app-detail ───────────────────────────────────────────────
    storeGetAppDetail: async (slug: string) => {
      return storeController.getStoreAppDetail(slug)
    },

    // ── store:refresh ──────────────────────────────────────────────────────
    storeRefresh: async () => {
      return storeController.refreshStoreIndex()
    },

    // ── store:check-updates ────────────────────────────────────────────────
    storeCheckUpdates: async () => {
      return storeController.checkStoreUpdates()
    },

    // ── store:get-registries ───────────────────────────────────────────────
    storeGetRegistries: async () => {
      return storeController.getStoreRegistries()
    },

    // ── store:add-registry ─────────────────────────────────────────────────
    storeAddRegistry: async (input: { name: string; url: string; sourceType?: string; adapterConfig?: Record<string, unknown> }) => {
      return storeController.addStoreRegistry(input)
    },

    // ── store:remove-registry ──────────────────────────────────────────────
    storeRemoveRegistry: async (registryId: string) => {
      return storeController.removeStoreRegistry(registryId)
    },

    // ── store:toggle-registry ──────────────────────────────────────────────
    storeToggleRegistry: async (input: { registryId: string; enabled: boolean }) => {
      return storeController.toggleStoreRegistry(input.registryId, input.enabled)
    },

    // ── store:update-registry-adapter-config ───────────────────────────────
    storeUpdateRegistryAdapterConfig: async (input: { registryId: string; adapterConfig: Record<string, unknown> }) => {
      return storeController.updateStoreRegistryAdapterConfig(input.registryId, input.adapterConfig)
    },

    // ── store:check-updates-now (manual trigger for the periodic upgrade loop) ─
    storeCheckUpdatesNow: async () => {
      try {
        const result = await checkUpgradesNow()
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[StoreIPC] store:check-updates-now error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── store:apply-upgrade ────────────────────────────────────────────────
    storeApplyUpgrade: async (input: { appId: string; mode?: 'patch_minor' | 'major' | 'force' }) => {
      try {
        const result = await applyUpgrade(input.appId, input.mode ?? 'force')
        console.log(`[StoreIPC] store:apply-upgrade: ${result.appId} ${result.from} -> ${result.to}`)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[StoreIPC] store:apply-upgrade error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── store:publish-preview ──────────────────────────────────────────────
    storePublishPreview: async (input: { appId: string; author?: string }) => {
      try {
        return { success: true, data: getPublishPreview(input.appId, input.author) }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[StoreIPC] store:publish-preview error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── store:publish ──────────────────────────────────────────────────────
    storePublish: async (input: { appId: string; author?: string; version?: string }) => {
      try {
        const result = await publish(input.appId, input.author, input.version)
        console.log(
          `[StoreIPC] store:publish: appId=${input.appId} status=${result.status} target=${result.target}` +
          (result.details ? ` details=${JSON.stringify(result.details)}` : '')
        )
        return {
          success: result.status !== 'error',
          data: result,
          error: result.status === 'error' ? result.details : undefined,
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[StoreIPC] store:publish error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── store:export-dhpkg ─────────────────────────────────────────────────
    storeExportDhpkg: async (input: { appId: string }) => {
      try {
        const manager = getAppManager()
        if (!manager) return { success: false, error: 'App Manager not ready' }
        const app = manager.getApp(input.appId)
        if (!app) return { success: false, error: `App not found: ${input.appId}` }

        const safeName = (app.spec.store?.slug ?? app.spec.name).replace(/[^a-z0-9-]/gi, '-').toLowerCase()
        const dialogResult = await dialog.showSaveDialog({
          title: 'Export as .dhpkg',
          defaultPath: `${safeName}-${app.spec.version ?? '0.0.0'}.dhpkg`,
          filters: [{ name: 'DHP Package', extensions: ['dhpkg'] }],
        })

        if (dialogResult.canceled || !dialogResult.filePath) {
          return { success: false, error: 'User cancelled' }
        }

        const { files, missingSkillIds } = collectFiles(app.spec, manager, app.spaceId)
        if (missingSkillIds.length > 0) {
          return {
            success: false,
            error:
              `Bundled skill dependencies are incomplete — exporting would produce a broken package. ` +
              `Missing skills: ${missingSkillIds.join(', ')}. Install them first, then export again.`,
          }
        }

        const buf = await packDhpkg(app.spec, files)
        await writeFile(dialogResult.filePath, buf)

        console.log(`[StoreIPC] store:export-dhpkg: appId=${input.appId} -> ${dialogResult.filePath}`)
        return { success: true, data: { path: dialogResult.filePath } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[StoreIPC] store:export-dhpkg error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── store:import-dhpkg ─────────────────────────────────────────────────
    storeImportDhpkg: async (input?: { filePath?: string; spaceId?: string | null }) => {
      try {
        let filePath = input?.filePath
        if (!filePath) {
          const dialogResult = await dialog.showOpenDialog({
            title: 'Import .dhpkg',
            filters: [{ name: 'DHP Package', extensions: ['dhpkg', 'zip'] }],
            properties: ['openFile'],
          })
          if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
            return { success: false, error: 'User cancelled' }
          }
          filePath = dialogResult.filePaths[0]
        }

        const buf = await readFile(filePath)
        const { spec } = await unpackDhpkg(buf)

        const manager = getAppManager()
        if (!manager) return { success: false, error: 'App Manager not ready' }

        const spaceId = input?.spaceId ?? null
        const appId = await manager.install(spaceId, spec, {})

        const runtime = getAppRuntime()
        if (runtime) {
          try {
            await runtime.activate(appId)
          } catch (err) {
            console.warn(
              `[StoreIPC] store:import-dhpkg: runtime activate failed (non-fatal): ${(err as Error).message}`
            )
          }
        }

        console.log(`[StoreIPC] store:import-dhpkg: ${filePath} -> appId=${appId}`)
        return { success: true, data: { appId } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[StoreIPC] store:import-dhpkg error:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  // ── store:get-app-document ─────────────────────────────────────────────
  ipcMain.handle(
    'store:get-app-document',
    async (_event, slug: string) => {
      return storeController.getStoreAppDocument(slug)
    }
  )

  // ── store:install ──────────────────────────────────────────────────────
  ipcMain.handle(
    'store:install',
    async (event, input: { slug: string; spaceId: string | null; userConfig?: Record<string, unknown>; progressChannel?: string }) => {
      const { slug, spaceId, userConfig, progressChannel } = input

      // Build progress emitter if the renderer provided a channel name
      const onProgress = progressChannel
        ? (filesComplete: number, filesTotal: number, currentFile: string) => {
            const isAllDownloaded = filesTotal > 0 && filesComplete >= filesTotal
            const progress: StoreInstallProgress = {
              installId: progressChannel,
              phase: filesComplete === 0 && filesTotal === 0
                ? 'fetching-tree'
                : isAllDownloaded ? 'installing' : 'downloading',
              filesComplete,
              filesTotal,
              currentFile,
              // Reserve last 10% for the install step; downloading spans 0–90%
              percent: filesTotal === 0
                ? 5
                : isAllDownloaded
                  ? 90
                  : Math.round(10 + (filesComplete / filesTotal) * 80),
              message: filesComplete === 0 && filesTotal === 0
                ? 'Fetching file list...'
                : isAllDownloaded
                  ? 'Installing...'
                  : `Downloading files (${filesComplete}/${filesTotal})`,
            }
            // Guard against destroyed renderer (e.g. window closed mid-install)
            if (!event.sender.isDestroyed()) {
              event.sender.send(progressChannel, progress)
            }
          }
        : undefined

      return storeController.installStoreApp(slug, spaceId, userConfig, onProgress)
    }
  )

  // ── Sync status push (main → renderer) ──────────────────────────────
  onSyncStatusChanged((event) => {
    sendToRenderer('store:sync-status-changed', event)
  })

  // ── Upgrade-available push (main → renderer) ────────────────────────
  onUpgradeAvailable((event) => {
    sendToRenderer('store:upgrade-available', event)
  })

  console.log('[StoreIPC] Store handlers registered (18 channels + sync push + upgrade push)')
}
