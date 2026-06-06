/**
 * healthApi — health domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  isElectron,
} from './_shared'
import type {
  ApiResponse,
  HealthCheckResponse,
  HealthExportResponse,
  HealthRecoveryResponse,
  HealthReportResponse,
  HealthStateResponse,
  HealthStatusResponse,
} from './_shared'

export const healthApi = {
  // ===== Health System (Electron only) =====
  getHealthStatus: async (): Promise<ApiResponse<HealthStatusResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getHealthStatus()
  },

  getHealthState: async (): Promise<ApiResponse<HealthStateResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getHealthState()
  },

  triggerHealthRecovery: async (strategyId: string, userConsented: boolean): Promise<ApiResponse<HealthRecoveryResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.triggerHealthRecovery(strategyId, userConsented)
  },

  generateHealthReport: async (): Promise<ApiResponse<HealthReportResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.generateHealthReport()
  },

  generateHealthReportText: async (): Promise<ApiResponse<string>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.generateHealthReportText()
  },

  exportHealthReport: async (filePath?: string): Promise<ApiResponse<HealthExportResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.exportHealthReport(filePath)
  },

  runHealthCheck: async (): Promise<ApiResponse<HealthCheckResponse>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.runHealthCheck()
  },

}
