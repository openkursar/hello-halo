/**
 * Store IPC Handlers
 *
 * Exposes the Store (App Registry) operations to the renderer process.
 *
 * Channels:
 *   store:query                          Paginated query (new primary entry point)
 *   store:list-apps                      List apps from the store with optional filtering
 *   store:get-app-detail                 Get detailed info about a store app by slug
 *   store:install                        Install an app from the store into a space
 *   store:refresh                        Refresh the registry index from remote sources
 *   store:check-updates                  Check for available updates for installed apps
 *   store:get-registries                 Get the list of configured registry sources
 *   store:add-registry                   Add a new registry source
 *   store:remove-registry                Remove a registry source
 *   store:toggle-registry                Enable or disable a registry source
 *   store:update-registry-adapter-config Update adapter config (e.g. API keys) for a registry
 */

import { ipcMain } from 'electron'
import * as storeController from '../controllers/store.controller'
import { onSyncStatusChanged } from '../store'
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
  })

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

  console.log('[StoreIPC] Store handlers registered (11 channels + sync push)')
}
