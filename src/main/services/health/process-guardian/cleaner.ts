/**
 * Process Cleaner - Orphan process cleanup
 *
 * Implements dual-mechanism cleanup:
 * 1. PID-based cleanup (from registry)
 * 2. Args-based cleanup (scan for --halo-managed flag)
 *
 * Defense in depth - ensures no orphan processes survive.
 */

import type { CleanupResult, ProcessEntry, ProcessType } from '../types'
import {
  getCurrentInstanceId,
  getOrphanProcesses,
  clearOrphanEntries,
  loadRegistry
} from './registry'
import { getPlatformOps } from './platform'

// Command-line argument patterns for Halo-managed processes
const HALO_MANAGED_FLAG = 'halo-managed'
const HALO_INSTANCE_PREFIX = 'halo-instance='

/**
 * Clean up orphan processes from previous app instances
 *
 * This function uses a dual-mechanism approach:
 * 1. Kill processes by PID (from registry entries)
 * 2. Scan for processes by command-line args (fallback)
 *
 * Only processes from OLD instances are killed - current instance processes are safe.
 */
export async function cleanupOrphans(): Promise<CleanupResult> {
  const result: CleanupResult = {
    cleaned: 0,
    failed: 0,
    details: []
  }

  const currentInstanceId = getCurrentInstanceId()
  if (!currentInstanceId) {
    console.warn('[Health][Cleaner] Cannot cleanup - no current instance ID')
    return result
  }

  const platformOps = getPlatformOps()

  // ====================================
  // Step 1: Kill by PID (registry-based)
  // ====================================

  const orphanEntries = getOrphanProcesses()
  console.log(`[Health][Cleaner] Found ${orphanEntries.length} orphan entries in registry`)

  for (const entry of orphanEntries) {
    if (!entry.pid) {
      // No PID recorded - will rely on args-based cleanup
      continue
    }

    try {
      if (platformOps.isProcessAlive(entry.pid)) {
        await platformOps.killProcess(entry.pid, 'SIGTERM')
        result.cleaned++
        result.details.push({
          pid: entry.pid,
          type: entry.type,
          method: 'pid'
        })
        console.log(`[Health][Cleaner] Killed orphan by PID: ${entry.pid} (${entry.type})`)
      }
    } catch (error) {
      console.error(`[Health][Cleaner] Failed to kill PID ${entry.pid}:`, error)
      result.failed++
    }
  }

  // ====================================
  // Step 2: Scan by Args (fallback)
  // ====================================

  try {
    // Find all processes with --halo-managed flag
    const haloProcesses = await platformOps.findByArgs(HALO_MANAGED_FLAG)
    console.log(`[Health][Cleaner] Found ${haloProcesses.length} Halo-managed processes by args scan`)

    for (const proc of haloProcesses) {
      // Only kill if NOT current instance
      if (proc.commandLine.includes(`${HALO_INSTANCE_PREFIX}${currentInstanceId}`)) {
        // This is a current instance process - skip
        continue
      }

      // Check if we already killed this by PID
      const alreadyKilled = result.details.some(d => d.pid === proc.pid)
      if (alreadyKilled) {
        continue
      }

      // Check if process is still alive before attempting to kill
      if (!platformOps.isProcessAlive(proc.pid)) {
        continue
      }

      try {
        await platformOps.killProcess(proc.pid, 'SIGTERM')
        result.cleaned++
        result.details.push({
          pid: proc.pid,
          type: inferProcessType(proc.commandLine),
          method: 'args'
        })
        console.log(`[Health][Cleaner] Killed orphan by args: ${proc.pid}`)
      } catch (error) {
        console.error(`[Health][Cleaner] Failed to kill PID ${proc.pid} (args):`, error)
        result.failed++
      }
    }
  } catch (error) {
    console.error('[Health][Cleaner] Args-based scan failed:', error)
  }

  // ====================================
  // Step 3: Clean up registry entries
  // ====================================

  clearOrphanEntries()

  console.log(`[Health][Cleaner] Cleanup complete: ${result.cleaned} cleaned, ${result.failed} failed`)
  return result
}

/**
 * Force kill stubborn processes (SIGKILL)
 * Used when SIGTERM doesn't work within timeout
 */
export async function forceKillProcess(pid: number): Promise<boolean> {
  const platformOps = getPlatformOps()

  try {
    if (!platformOps.isProcessAlive(pid)) {
      return true  // Already dead
    }

    await platformOps.killProcess(pid, 'SIGKILL')
    console.log(`[Health][Cleaner] Force killed PID: ${pid}`)
    return true
  } catch (error) {
    console.error(`[Health][Cleaner] Force kill failed for PID ${pid}:`, error)
    return false
  }
}

/**
 * Check if a specific process is a Halo-managed process
 */
export async function isHaloManagedProcess(pid: number): Promise<boolean> {
  const platformOps = getPlatformOps()

  try {
    const processes = await platformOps.findByArgs(HALO_MANAGED_FLAG)
    return processes.some(p => p.pid === pid)
  } catch {
    return false
  }
}

/**
 * Get all running Halo-managed processes
 */
export async function getRunningHaloProcesses(): Promise<Array<{
  pid: number
  instanceId: string | null
  commandLine: string
}>> {
  const platformOps = getPlatformOps()

  try {
    const processes = await platformOps.findByArgs(HALO_MANAGED_FLAG)

    return processes.map(proc => {
      // Extract instance ID from command line
      const instanceMatch = proc.commandLine.match(new RegExp(`${HALO_INSTANCE_PREFIX}([a-f0-9-]+)`))

      return {
        pid: proc.pid,
        instanceId: instanceMatch ? instanceMatch[1] : null,
        commandLine: proc.commandLine
      }
    })
  } catch {
    return []
  }
}

/**
 * Infer process type from command line
 */
function inferProcessType(commandLine: string): ProcessType {
  // V2 sessions typically run via claude-agent-sdk
  if (commandLine.includes('claude') || commandLine.includes('cli.js')) {
    return 'v2-session'
  }

  // Tunnel processes
  if (commandLine.includes('tunnel') || commandLine.includes('cloudflared')) {
    return 'tunnel'
  }

  // Default to v2-session as that's the most common
  return 'v2-session'
}

/**
 * Verify cleanup was successful
 */
export async function verifyCleanup(): Promise<boolean> {
  const currentInstanceId = getCurrentInstanceId()
  const runningProcesses = await getRunningHaloProcesses()

  // Check if any non-current instance processes are still running
  const orphansRemaining = runningProcesses.filter(p =>
    p.instanceId !== currentInstanceId
  )

  if (orphansRemaining.length > 0) {
    console.warn(`[Health][Cleaner] ${orphansRemaining.length} orphan processes still running`)
    return false
  }

  return true
}
