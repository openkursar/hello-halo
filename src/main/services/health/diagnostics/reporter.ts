/**
 * Diagnostics Reporter - Generate and export reports
 *
 * Handles formatting and exporting diagnostic reports.
 */

import { writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { DiagnosticReport } from '../types'
import { collectDiagnosticReport } from './collector'

/**
 * Generate a diagnostic report
 */
export async function generateReport(): Promise<DiagnosticReport> {
  return collectDiagnosticReport()
}

/**
 * Export report to file
 */
export async function exportReport(filePath?: string): Promise<string> {
  const report = await generateReport()

  // Default to downloads folder
  const outputPath = filePath || join(
    app.getPath('downloads'),
    `halo-diagnostics-${Date.now()}.json`
  )

  writeFileSync(outputPath, JSON.stringify(report, null, 2))

  return outputPath
}

/**
 * Format report as text (for display)
 */
export function formatReportAsText(report: DiagnosticReport): string {
  const lines: string[] = [
    '='.repeat(50),
    'HALO DIAGNOSTIC REPORT',
    '='.repeat(50),
    '',
    `Generated: ${report.timestamp}`,
    `Version: ${report.version}`,
    `Platform: ${report.platform} (${report.arch})`,
    '',
    '--- Configuration ---',
    `Current Source: ${report.config.currentSource}`,
    `Provider: ${report.config.provider}`,
    `API Key Configured: ${report.config.hasApiKey ? 'Yes' : 'No'}`,
    `MCP Servers: ${report.config.mcpServerCount}`,
    '',
    '--- Processes ---',
    `Registered: ${report.processes.registered}`,
    `Orphans Found: ${report.processes.orphansFound}`,
    `Orphans Cleaned: ${report.processes.orphansCleaned}`,
    '',
    '--- Health ---',
    `Last Check: ${report.health.lastCheckTime}`,
    `Consecutive Failures: ${report.health.consecutiveFailures}`,
    `Recovery Attempts: ${report.health.recoveryAttempts}`,
    '',
    '--- System ---',
    `Memory: ${report.system.memory.free} free / ${report.system.memory.total} total`,
    `Uptime: ${formatUptime(report.system.uptime)}`,
    ''
  ]

  if (report.imChannels.length > 0) {
    lines.push('--- Message Channels ---')
    for (const ch of report.imChannels) {
      const detail = [
        ch.enabled ? ch.state : 'disabled',
        ch.failures ? `failures=${ch.failures}` : '',
        ch.drops ? `drops=${ch.drops}` : '',
        ch.viaProxy ? 'via proxy' : '',
        ch.lastError ? `last error: ${ch.lastError}` : '',
      ].filter(Boolean).join(', ')
      lines.push(`${ch.type} #${ch.ordinal ?? '?'}: ${detail}`)
    }
    lines.push('')
  }

  if (report.recentErrors.length > 0) {
    lines.push('--- Recent Errors ---')
    for (const error of report.recentErrors) {
      lines.push(`[${error.time}] ${error.source}: ${error.message}`)
    }
    lines.push('')
  }

  lines.push('='.repeat(50))

  return lines.join('\n')
}

/**
 * Format uptime as human-readable string
 */
function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${secs}s`)

  return parts.join(' ')
}
