/**
 * Disk Probe - Disk space health check
 *
 * Checks:
 * - Free disk space on Halo data directory
 * - Warns if below threshold
 */

import { statfsSync } from 'fs'
import type { DiskProbeResult } from '../../types'
import { getHaloDir } from '../../../../foundation/config.service'

// Minimum free space threshold (100 MB)
const MIN_FREE_SPACE_MB = 100

// Warning threshold (500 MB)
const WARNING_FREE_SPACE_MB = 500

/**
 * Get disk space information for a path
 */
function getDiskSpace(path: string): { free: number; total: number } | null {
  try {
    const stats = statfsSync(path)

    // Calculate bytes
    const free = stats.bfree * stats.bsize
    const total = stats.blocks * stats.bsize

    return { free, total }
  } catch {
    return null
  }
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

/**
 * Check disk space health
 */
export async function runDiskProbe(): Promise<DiskProbeResult> {
  const haloDir = getHaloDir()

  try {
    const diskSpace = getDiskSpace(haloDir)

    if (!diskSpace) {
      return {
        name: 'disk',
        healthy: true,  // Assume healthy if we can't check
        severity: 'warning',
        message: 'Unable to check disk space',
        timestamp: Date.now(),
        data: {
          path: haloDir,
          freeSpace: 0,
          totalSpace: 0,
          freePercent: 0,
          thresholdMB: MIN_FREE_SPACE_MB
        }
      }
    }

    const freeMB = diskSpace.free / (1024 * 1024)
    const totalMB = diskSpace.total / (1024 * 1024)
    const freePercent = (diskSpace.free / diskSpace.total) * 100

    // Determine health status
    let healthy = true
    let severity: 'info' | 'warning' | 'critical' = 'info'
    let message = `${formatBytes(diskSpace.free)} free (${freePercent.toFixed(1)}%)`

    if (freeMB < MIN_FREE_SPACE_MB) {
      healthy = false
      severity = 'critical'
      message = `Critical: Only ${formatBytes(diskSpace.free)} free - app may not function properly`
    } else if (freeMB < WARNING_FREE_SPACE_MB) {
      severity = 'warning'
      message = `Warning: Low disk space - ${formatBytes(diskSpace.free)} free`
    }

    return {
      name: 'disk',
      healthy,
      severity,
      message,
      timestamp: Date.now(),
      data: {
        path: haloDir,
        freeSpace: diskSpace.free,
        totalSpace: diskSpace.total,
        freePercent,
        thresholdMB: MIN_FREE_SPACE_MB
      }
    }
  } catch (error) {
    return {
      name: 'disk',
      healthy: true,  // Assume healthy on error
      severity: 'warning',
      message: `Disk check failed: ${(error as Error).message}`,
      timestamp: Date.now(),
      data: {
        path: haloDir,
        freeSpace: 0,
        totalSpace: 0,
        freePercent: 0,
        thresholdMB: MIN_FREE_SPACE_MB
      }
    }
  }
}
