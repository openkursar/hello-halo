/**
 * Runtime Checker - Fallback polling health monitor
 *
 * Provides a safety net with 120-second interval polling.
 * Primary health monitoring is event-driven (see event-listener.ts).
 *
 * Key feature: PPID scanning for accurate subprocess detection.
 */

import type { HealthStatus, ImmediateCheckResult, ProcessCheckStatus, ServiceCheckStatus } from '../types'
import { checkOpenAIRouter, checkHttpServer } from './probes/service-probe'
import { getCurrentProcesses, unregisterProcess, getRegistryStats } from '../process-guardian'
import { getPlatformOps } from '../process-guardian/platform'
import { getRouterInfo } from '../../../openai-compat-router'
import { getServerInfo } from '../../../http'
import { getRecentEvents, getTotalErrorCount } from './event-listener'

// Memory threshold for warning (500MB)
const MEMORY_WARNING_THRESHOLD_MB = 500

// Memory threshold for critical (1GB)
const MEMORY_CRITICAL_THRESHOLD_MB = 1024

// Fallback polling interval (120 seconds)
const FALLBACK_POLL_INTERVAL_MS = 120_000

// Timer reference
let pollIntervalId: NodeJS.Timeout | null = null

// Callback for health status changes
type HealthChangeCallback = (status: HealthStatus, message: string) => void
let healthChangeCallback: HealthChangeCallback | null = null

// Last known status
let lastKnownStatus: HealthStatus = 'healthy'

// Last check timestamp
let lastCheckTime: number | null = null

// Check lock for debouncing
let isCheckRunning = false
let lastCheckPromise: Promise<ImmediateCheckResult> | null = null
const MIN_CHECK_INTERVAL_MS = 2000 // Minimum 2 seconds between checks

/**
 * Start fallback polling
 *
 * This is a safety net - event-driven monitoring handles most cases.
 * Polling catches anything that might slip through.
 */
export function startFallbackPolling(callback: HealthChangeCallback): void {
  if (pollIntervalId) {
    console.log('[Health][Runtime] Fallback polling already running')
    return
  }

  healthChangeCallback = callback

  // Use unref'd timer so it doesn't prevent Node.js from exiting
  pollIntervalId = setInterval(() => {
    performFallbackCheck().catch(error => {
      console.error('[Health][Runtime] Fallback check failed:', error)
    })
  }, FALLBACK_POLL_INTERVAL_MS)

  // Allow Node.js to exit even if timer is pending
  pollIntervalId.unref()

  console.log(`[Health][Runtime] Fallback polling started (${FALLBACK_POLL_INTERVAL_MS / 1000}s interval)`)
}

/**
 * Stop fallback polling
 */
export function stopFallbackPolling(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId)
    pollIntervalId = null
    healthChangeCallback = null
    console.log('[Health][Runtime] Fallback polling stopped')
  }
}

/**
 * Check if fallback polling is active
 */
export function isPollingActive(): boolean {
  return pollIntervalId !== null
}

/**
 * Perform fallback health check (called by 120s polling)
 *
 * PASSIVE MODE: Only collects existing state, does NOT execute:
 * - PPID scanning (shell commands)
 * - HTTP service probes
 * - Config file probes
 *
 * These active checks are triggered by events or user action.
 */
async function performFallbackCheck(): Promise<void> {
  console.log('[Health][Runtime] Running passive status collection...')

  try {
    const issues: string[] = []

    // ========================================
    // Step 1: Read Registry Statistics (passive)
    // ========================================
    const registryStats = getRegistryStats()
    if (registryStats.orphanProcesses > 0) {
      issues.push(`${registryStats.orphanProcesses} orphan processes in registry`)
    }

    // ========================================
    // Step 2: Read Recent Events (passive)
    // ========================================
    const recentEvents = getRecentEvents()
    const recentCritical = recentEvents.filter(
      e => e.category === 'critical' && Date.now() - e.timestamp < 60_000
    )
    if (recentCritical.length > 0) {
      issues.push(`${recentCritical.length} critical events in last minute`)
    }

    // ========================================
    // Step 3: Read Error Count (passive)
    // ========================================
    const totalErrors = getTotalErrorCount()
    if (totalErrors > 0) {
      issues.push(`${totalErrors} consecutive errors`)
    }

    // ========================================
    // Step 4: Read Memory Usage (passive, no I/O)
    // ========================================
    const memUsage = process.memoryUsage()
    const heapUsedMB = memUsage.heapUsed / (1024 * 1024)
    if (heapUsedMB > MEMORY_CRITICAL_THRESHOLD_MB) {
      issues.push(`Critical memory usage: ${heapUsedMB.toFixed(0)}MB`)
    } else if (heapUsedMB > MEMORY_WARNING_THRESHOLD_MB) {
      issues.push(`High memory usage: ${heapUsedMB.toFixed(0)}MB`)
    }

    // ========================================
    // Step 5: Determine Status and Report
    // ========================================
    let newStatus: HealthStatus = 'healthy'
    if (recentCritical.length > 0 || totalErrors >= 3 || heapUsedMB > MEMORY_CRITICAL_THRESHOLD_MB) {
      newStatus = 'unhealthy'
    } else if (issues.length > 0) {
      newStatus = 'degraded'
    }

    // Report status change if any
    if (newStatus !== lastKnownStatus) {
      const message = issues.length > 0
        ? issues.join('; ')
        : 'All checks passed'

      if (healthChangeCallback) {
        healthChangeCallback(newStatus, message)
      }

      lastKnownStatus = newStatus
    }

    console.log(`[Health][Runtime] Passive check complete: ${newStatus}`)
  } catch (error) {
    console.error('[Health][Runtime] Passive check error:', error)
  }
}

/**
 * Run immediate health check with PPID scanning
 *
 * This is the main health check function that:
 * 1. Scans child processes using PPID
 * 2. Compares with Registry
 * 3. Cleans up dead entries
 * 4. Checks HTTP services
 * 5. Returns comprehensive report
 *
 * Includes debouncing to prevent rapid consecutive calls.
 */
export async function runImmediateCheck(): Promise<ImmediateCheckResult> {
  // Debounce: if check was run recently, return the last result
  const now = Date.now()
  if (lastCheckTime && (now - lastCheckTime) < MIN_CHECK_INTERVAL_MS && lastCheckPromise) {
    console.log('[Health][Runtime] Debounced: returning cached result')
    return lastCheckPromise
  }

  // Lock: if check is already running, wait for it
  if (isCheckRunning && lastCheckPromise) {
    console.log('[Health][Runtime] Check already running, waiting...')
    return lastCheckPromise
  }

  // Start the actual check
  lastCheckPromise = doImmediateCheck()
  return lastCheckPromise
}

/**
 * Internal implementation of immediate health check
 */
async function doImmediateCheck(): Promise<ImmediateCheckResult> {
  isCheckRunning = true
  const timestamp = Date.now()
  lastCheckTime = timestamp

  try {
    const issues: string[] = []
    let registryRemoved = 0
    let orphansFound = 0

    // Get platform-specific operations
    const platformOps = getPlatformOps()
    const mainPid = process.pid

    // ========================================
    // Step 1: PPID Scan - Find actual child processes
    // ========================================
    let claudeProcesses: number[] = []
    let cloudflaredProcesses: number[] = []

    try {
      const childProcesses = await platformOps.findChildProcesses(mainPid)

      // Filter by process name
      // claude (v2-session) - The CLI process
      // cloudflared (tunnel) - Cloudflare tunnel process
      claudeProcesses = childProcesses
        .filter(p => p.name === 'claude' || p.name === 'claude.exe')
        .map(p => p.pid)

      cloudflaredProcesses = childProcesses
        .filter(p => p.name === 'cloudflared' || p.name === 'cloudflared.exe')
        .map(p => p.pid)

      console.log(`[Health][Runtime] PPID scan: ${claudeProcesses.length} claude, ${cloudflaredProcesses.length} cloudflared`)
    } catch (error) {
      console.error('[Health][Runtime] PPID scan failed:', error)
      issues.push('PPID scan failed')
    }

    // ========================================
    // Step 2: Read Registry
    // ========================================
    const registeredProcesses = getCurrentProcesses()
    const registeredClaude = registeredProcesses.filter(p => p.type === 'v2-session')
    const registeredCloudflared = registeredProcesses.filter(p => p.type === 'tunnel')

    // ========================================
    // Step 3: Reconcile - Registry vs Actual
    // ========================================

    // Find dead processes in Registry (Registry has, actual doesn't)
    for (const entry of registeredClaude) {
      if (entry.pid && !claudeProcesses.includes(entry.pid)) {
        // Process is in registry but not running - remove it
        console.log(`[Health][Runtime] Dead claude process: ${entry.id} (PID: ${entry.pid})`)
        unregisterProcess(entry.id, 'v2-session')
        registryRemoved++
      }
    }

    for (const entry of registeredCloudflared) {
      if (entry.pid && !cloudflaredProcesses.includes(entry.pid)) {
        console.log(`[Health][Runtime] Dead cloudflared process: ${entry.id} (PID: ${entry.pid})`)
        unregisterProcess(entry.id, 'tunnel')
        registryRemoved++
      }
    }

    // Find orphan processes (actual has, Registry doesn't have correct PID)
    // This is less critical - just log as warning
    const registeredClaudePids = registeredClaude.map(p => p.pid).filter(Boolean) as number[]
    const registeredCloudflaredPids = registeredCloudflared.map(p => p.pid).filter(Boolean) as number[]

    for (const pid of claudeProcesses) {
      if (!registeredClaudePids.includes(pid)) {
        console.warn(`[Health][Runtime] Orphan claude process detected: PID ${pid}`)
        orphansFound++
      }
    }

    for (const pid of cloudflaredProcesses) {
      if (!registeredCloudflaredPids.includes(pid)) {
        console.warn(`[Health][Runtime] Orphan cloudflared process detected: PID ${pid}`)
        orphansFound++
      }
    }

    if (registryRemoved > 0) {
      issues.push(`Cleaned ${registryRemoved} dead process entries`)
    }

    if (orphansFound > 0) {
      issues.push(`${orphansFound} orphan processes detected`)
    }

    // ========================================
    // Step 4: Check HTTP Services
    // ========================================
    let routerStatus: ServiceCheckStatus = {
      port: null,
      responsive: false
    }

    let httpServerStatus: ServiceCheckStatus = {
      port: null,
      responsive: false
    }

    // Check OpenAI Router
    const routerInfo = getRouterInfo()
    if (routerInfo) {
      routerStatus.port = routerInfo.port
      try {
        const routerProbe = await checkOpenAIRouter(routerInfo.port)
        routerStatus.responsive = routerProbe.healthy
        routerStatus.responseTime = routerProbe.data?.responseTime as number | undefined
        routerStatus.error = routerProbe.data?.error as string | undefined

        if (!routerProbe.healthy) {
          issues.push(`OpenAI Router not responding: ${routerStatus.error || 'unknown'}`)
        }
      } catch (error) {
        routerStatus.error = (error as Error).message
        issues.push(`OpenAI Router check failed: ${routerStatus.error}`)
      }
    }

    // Check HTTP Server
    const serverInfo = getServerInfo()
    if (serverInfo.running) {
      httpServerStatus.port = serverInfo.port
      try {
        const httpProbe = await checkHttpServer(serverInfo.port)
        httpServerStatus.responsive = httpProbe.healthy
        httpServerStatus.responseTime = httpProbe.data?.responseTime as number | undefined
        httpServerStatus.error = httpProbe.data?.error as string | undefined

        if (!httpProbe.healthy) {
          issues.push(`HTTP Server not responding: ${httpServerStatus.error || 'unknown'}`)
        }
      } catch (error) {
        httpServerStatus.error = (error as Error).message
        issues.push(`HTTP Server check failed: ${httpServerStatus.error}`)
      }
    }

    // ========================================
    // Step 5: Config Check - DISABLED
    // ========================================
    // Config errors are caught naturally when agent starts (emitAgentError -> critical event)
    // No need to waste CPU polling for config issues every 120s

    // ========================================
    // Step 6: Memory Check
    // ========================================
    const memUsage = process.memoryUsage()
    const heapUsedMB = memUsage.heapUsed / (1024 * 1024)
    if (heapUsedMB > MEMORY_WARNING_THRESHOLD_MB) {
      issues.push(`High memory usage: ${heapUsedMB.toFixed(0)}MB`)
    }

    // ========================================
    // Step 7: Build Result
    // ========================================

    // Refresh registered processes after cleanup
    const updatedRegistered = getCurrentProcesses()
    const updatedClaudeCount = updatedRegistered.filter(p => p.type === 'v2-session').length
    const updatedCloudflaredCount = updatedRegistered.filter(p => p.type === 'tunnel').length

    const claudeStatus: ProcessCheckStatus = {
      expected: updatedClaudeCount,
      actual: claudeProcesses.length,
      pids: claudeProcesses,
      healthy: updatedClaudeCount === claudeProcesses.length
    }

    const cloudflaredStatus: ProcessCheckStatus = {
      expected: updatedCloudflaredCount,
      actual: cloudflaredProcesses.length,
      pids: cloudflaredProcesses,
      healthy: updatedCloudflaredCount === cloudflaredProcesses.length
    }

    // Overall health: no critical issues and services are responsive (if running)
    const hasServiceIssues = (routerInfo && !routerStatus.responsive) ||
                             (serverInfo.running && !httpServerStatus.responsive)
    const healthy = issues.length === 0 || (registryRemoved > 0 && issues.length === 1 && !hasServiceIssues)

    return {
      timestamp,
      processes: {
        claude: claudeStatus,
        cloudflared: cloudflaredStatus
      },
      services: {
        openaiRouter: routerStatus,
        httpServer: httpServerStatus
      },
      issues,
      healthy,
      registryCleanup: {
        removed: registryRemoved,
        orphans: orphansFound
      }
    }
  } finally {
    isCheckRunning = false
  }
}

/**
 * Get current runtime health status
 */
export function getRuntimeStatus(): {
  status: HealthStatus
  isPollingActive: boolean
  lastCheckTime: number | null
} {
  return {
    status: lastKnownStatus,
    isPollingActive: isPollingActive(),
    lastCheckTime
  }
}

/**
 * Run PPID scan and cleanup dead processes (event-driven)
 *
 * Called when:
 * - Session creation fails
 * - Agent error occurs
 *
 * This is the active PPID scanning, separate from passive polling.
 */
export async function runPpidScanAndCleanup(): Promise<{
  removed: number
  orphans: number
}> {
  console.log('[Health][Runtime] Running event-driven PPID scan...')

  let removed = 0
  let orphans = 0

  try {
    const platformOps = getPlatformOps()
    const mainPid = process.pid

    // Find actual child processes
    const childProcesses = await platformOps.findChildProcesses(mainPid)

    const claudeProcesses = childProcesses
      .filter(p => p.name === 'claude' || p.name === 'claude.exe')
      .map(p => p.pid)

    const cloudflaredProcesses = childProcesses
      .filter(p => p.name === 'cloudflared' || p.name === 'cloudflared.exe')
      .map(p => p.pid)

    // Read registry and reconcile
    const registeredProcesses = getCurrentProcesses()
    const registeredClaude = registeredProcesses.filter(p => p.type === 'v2-session')
    const registeredCloudflared = registeredProcesses.filter(p => p.type === 'tunnel')

    // Clean dead processes from registry
    for (const entry of registeredClaude) {
      if (entry.pid && !claudeProcesses.includes(entry.pid)) {
        console.log(`[Health][Runtime] Cleaning dead claude process: ${entry.id} (PID: ${entry.pid})`)
        unregisterProcess(entry.id, 'v2-session')
        removed++
      }
    }

    for (const entry of registeredCloudflared) {
      if (entry.pid && !cloudflaredProcesses.includes(entry.pid)) {
        console.log(`[Health][Runtime] Cleaning dead cloudflared process: ${entry.id} (PID: ${entry.pid})`)
        unregisterProcess(entry.id, 'tunnel')
        removed++
      }
    }

    // Count orphans
    const registeredClaudePids = registeredClaude.map(p => p.pid).filter(Boolean) as number[]
    const registeredCloudflaredPids = registeredCloudflared.map(p => p.pid).filter(Boolean) as number[]

    for (const pid of claudeProcesses) {
      if (!registeredClaudePids.includes(pid)) {
        console.warn(`[Health][Runtime] Orphan claude process: PID ${pid}`)
        orphans++
      }
    }

    for (const pid of cloudflaredProcesses) {
      if (!registeredCloudflaredPids.includes(pid)) {
        console.warn(`[Health][Runtime] Orphan cloudflared process: PID ${pid}`)
        orphans++
      }
    }

    console.log(`[Health][Runtime] PPID scan complete: removed=${removed}, orphans=${orphans}`)
  } catch (error) {
    console.error('[Health][Runtime] PPID scan failed:', error)
  }

  return { removed, orphans }
}
