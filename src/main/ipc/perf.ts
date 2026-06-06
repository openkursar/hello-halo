/**
 * Performance Monitoring IPC Handlers
 *
 * Exposes performance monitoring functionality to the renderer process.
 * Request/response channels are registered from the typed RPC contract
 * (passthrough — handler bodies and return shapes preserved verbatim). The
 * one-way `perf:renderer-metrics` channel stays a plain `ipcMain.on` event.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { perfService } from '../services/perf'
import type { PerfConfig, RendererMetrics } from '../services/perf'
import { perfRpc } from '../../shared/rpc/contracts/perf.contract'
import { registerRawRpcHandlers } from './rpc'

/**
 * Register performance monitoring IPC handlers
 */
export function registerPerfHandlers(mainWindow: BrowserWindow): void {
  // Set main window reference for event emission
  perfService.setMainWindow(mainWindow)

  registerRawRpcHandlers(perfRpc, {
    perfStart: async (config?: Partial<PerfConfig>) => {
      try {
        await perfService.start(config)
        return { success: true }
      } catch (error) {
        console.error('[Perf IPC] Start failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },
    perfStop: async () => {
      try {
        perfService.stop()
        return { success: true }
      } catch (error) {
        console.error('[Perf IPC] Stop failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },
    perfGetState: async () => perfService.getState(),
    perfGetHistory: async () => perfService.getHistory(),
    perfClearHistory: async () => {
      perfService.clearHistory()
      return { success: true }
    },
    perfSetConfig: async (config: Partial<PerfConfig>) => {
      try {
        perfService.setConfig(config)
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    },
    perfExport: async () => perfService.export(),
  })

  // Receive renderer metrics (one-way, no response needed)
  ipcMain.on('perf:renderer-metrics', (_event, metrics: RendererMetrics) => {
    perfService.updateRendererMetrics(metrics)
  })

  console.log('[Perf IPC] Handlers registered')
}
