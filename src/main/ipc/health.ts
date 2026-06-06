/**
 * Health IPC Handlers
 *
 * Provides IPC interface for renderer to query health status
 * and trigger recovery actions.
 */

import {
  getHealthStatus,
  getHealthState,
  triggerRecovery,
  collectDiagnosticReport,
  formatReportAsText,
  exportReport,
  runImmediateCheck
} from '../services/health'
import { healthRpc } from '../../shared/rpc/contracts/health.contract'
import { registerRawRpcHandlers } from './rpc'

/**
 * Register health-related IPC handlers
 */
export function registerHealthHandlers(): void {
  registerRawRpcHandlers(healthRpc, {
    // Get current health status (quick query)
    getHealthStatus: async () => {
      try {
        const data = getHealthStatus()
        return { success: true, data }
      } catch (error) {
        console.error('[Settings] health:get-status - Failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    // Get full health state (detailed)
    getHealthState: async () => {
      try {
        const data = getHealthState()
        return { success: true, data }
      } catch (error) {
        console.error('[Settings] health:get-state - Failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    // Trigger manual recovery
    triggerHealthRecovery: async (strategyId: string, userConsented: boolean) => {
      console.log('[Settings] health:trigger-recovery - Strategy:', strategyId, 'consented:', userConsented)
      try {
        const result = await triggerRecovery(
          strategyId as 'S1' | 'S2' | 'S3' | 'S4',
          userConsented
        )
        console.log('[Settings] health:trigger-recovery - Result:', result.success ? 'success' : 'failed')
        return { success: true, data: result }
      } catch (error) {
        console.error('[Settings] health:trigger-recovery - Failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    // Generate diagnostic report
    generateHealthReport: async () => {
      console.log('[Settings] health:generate-report - Generating diagnostic report')
      try {
        const report = await collectDiagnosticReport()
        console.log('[Settings] health:generate-report - Generated')
        return { success: true, data: report }
      } catch (error) {
        console.error('[Settings] health:generate-report - Failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    // Generate diagnostic report as text
    generateHealthReportText: async () => {
      console.log('[Settings] health:generate-report-text - Generating text report')
      try {
        const report = await collectDiagnosticReport()
        const text = formatReportAsText(report)
        console.log('[Settings] health:generate-report-text - Generated, length:', text.length)
        return { success: true, data: text }
      } catch (error) {
        console.error('[Settings] health:generate-report-text - Failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    // Export diagnostic report to file
    exportHealthReport: async (filePath?: string) => {
      console.log('[Settings] health:export-report - Exporting report', filePath ? `to ${filePath}` : '')
      try {
        const outputPath = await exportReport(filePath)
        console.log('[Settings] health:export-report - Exported to:', outputPath)
        return { success: true, data: { success: true, path: outputPath } }
      } catch (error) {
        console.error('[Settings] health:export-report - Failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },

    // Run immediate health check (PPID scanning + service probes)
    runHealthCheck: async () => {
      console.log('[Settings] health:run-check - Running immediate health check')
      try {
        const result = await runImmediateCheck()
        console.log('[Settings] health:run-check - Result:', result.healthy ? 'healthy' : 'unhealthy')
        return { success: true, data: result }
      } catch (error) {
        console.error('[Settings] health:run-check - Failed:', error)
        return { success: false, error: (error as Error).message }
      }
    },
  })

  console.log('[Settings] Health handlers registered')
}
