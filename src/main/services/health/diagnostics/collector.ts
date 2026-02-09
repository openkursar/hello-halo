/**
 * Diagnostics Collector - Gather system information for debugging
 *
 * Collects data from various sources for diagnostic reports.
 * All sensitive data is sanitized before inclusion.
 */

import { app } from 'electron'
import { freemem, totalmem } from 'os'
import type { DiagnosticReport } from '../types'
import { getConfig, getHaloDir } from '../../config.service'
import { getHealthState } from '../orchestrator'
import { getRegistryStats } from '../process-guardian'
import { getRecentEvents } from '../health-checker'
import { sanitizeReport } from './sanitizer'

/**
 * Collect full diagnostic report
 */
export async function collectDiagnosticReport(): Promise<DiagnosticReport> {
  const config = getConfig()
  const healthState = getHealthState()
  const registryStats = getRegistryStats()
  const recentEvents = getRecentEvents()

  // Get AI source info (sanitized)
  const aiSources = config.aiSources
  let provider = 'unknown'
  let hasApiKey = false
  let apiUrlHost = ''
  let currentSourceName = 'none'

  if (aiSources?.version === 2 && Array.isArray(aiSources.sources)) {
    const currentSource = aiSources.sources.find(s => s.id === aiSources.currentId)
    if (currentSource) {
      currentSourceName = currentSource.provider || 'unknown'
      provider = currentSource.provider || 'unknown'
      if (currentSource.authType === 'api-key') {
        hasApiKey = !!(currentSource.apiKey && currentSource.apiKey.length > 0)
        apiUrlHost = currentSource.apiUrl ? new URL(currentSource.apiUrl).hostname : ''
      } else if (currentSource.authType === 'oauth') {
        hasApiKey = !!(currentSource.accessToken)
      }
    }
  }

  // Build raw report
  const rawReport: DiagnosticReport = {
    timestamp: new Date().toISOString(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,

    config: {
      currentSource: currentSourceName,
      provider,
      hasApiKey,
      apiUrlHost,
      mcpServerCount: Object.keys(config.mcpServers || {}).length
    },

    processes: {
      registered: registryStats.totalProcesses,
      orphansFound: registryStats.orphanProcesses,
      // Note: Startup checks disabled - orphan cleanup handled by process-guardian cleaner
      orphansCleaned: 0
    },

    health: {
      // Startup checks disabled - event-driven health monitoring only
      lastCheckTime: 'disabled',
      consecutiveFailures: healthState.consecutiveFailures,
      recoveryAttempts: healthState.recoveryAttempts
    },

    recentErrors: recentEvents
      .filter(e => e.category === 'critical' || e.category === 'warning')
      .slice(0, 10)
      .map(e => ({
        time: new Date(e.timestamp).toISOString(),
        source: e.source,
        message: e.message
      })),

    system: {
      memory: {
        total: formatBytes(totalmem()),
        free: formatBytes(freemem())
      },
      uptime: Math.floor(process.uptime())
    }
  }

  // Sanitize sensitive data
  return sanitizeReport(rawReport)
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let value = bytes

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`
}
