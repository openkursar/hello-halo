/**
 * perfApi — perf domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  isElectron,
  onEvent,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const perfApi = {
  // ===== Performance Monitoring (Electron only, Developer Tools) =====
  perfStart: async (config?: { sampleInterval?: number; maxSamples?: number }): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfStart(config)
  },

  perfStop: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfStop()
  },

  perfGetState: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfGetState()
  },

  perfGetHistory: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfGetHistory()
  },

  perfClearHistory: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfClearHistory()
  },

  perfSetConfig: async (config: { enabled?: boolean; sampleInterval?: number; warnOnThreshold?: boolean }): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfSetConfig(config)
  },

  perfExport: async (): Promise<ApiResponse<string>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.perfExport()
  },

  onPerfSnapshot: (callback: (data: unknown) => void) =>
    onEvent('perf:snapshot', callback),

  onPerfWarning: (callback: (data: unknown) => void) =>
    onEvent('perf:warning', callback),

  // Report renderer metrics to main process (for combined monitoring)
  perfReportRendererMetrics: (metrics: {
    fps: number
    frameTime: number
    renderCount: number
    domNodes: number
    eventListeners: number
    jsHeapUsed: number
    jsHeapLimit: number
    longTasks: number
  }): void => {
    if (isElectron()) {
      window.halo.perfReportRendererMetrics(metrics)
    }
  },

}
