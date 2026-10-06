/**
 * Health System - Unified Type Definitions
 *
 * This module defines all types related to the health monitoring system.
 * These types are shared between main process, preload, and renderer.
 *
 * Design Principles:
 * - Single source of truth for all health-related types
 * - Used by IPC handlers, preload API, and renderer API
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Health status levels
 */
export type HealthStatusLevel = 'healthy' | 'degraded' | 'unhealthy'

/**
 * Health event entry
 */
export interface HealthEvent {
  type: string
  category: string
  timestamp: number
  source: string
  message: string
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Response from getHealthStatus
 */
export interface HealthStatusResponse {
  status: HealthStatusLevel
  instanceId: string
  uptime: number
  consecutiveFailures: number
  recoveryAttempts: number
}

/**
 * Response from getHealthState
 */
export interface HealthStateResponse {
  status: HealthStatusLevel
  instanceId: string
  startedAt: number
  consecutiveFailures: number
  recoveryAttempts: number
  isPollingActive: boolean
  isEnabled: boolean
  recentEvents: HealthEvent[]
}

/**
 * Response from triggerHealthRecovery
 */
export interface HealthRecoveryResponse {
  strategyId: string
  success: boolean
  message: string
  timestamp: number
}

/**
 * Response from generateHealthReport
 */
export interface HealthReportResponse {
  timestamp: string
  version: string
  platform: string
  arch: string
  config: {
    currentSource: string
    provider: string
    hasApiKey: boolean
    apiUrlHost: string
    mcpServerCount: number
  }
  processes: {
    registered: number
    orphansFound: number
    orphansCleaned: number
  }
  health: {
    lastCheckTime: string
    consecutiveFailures: number
    recoveryAttempts: number
  }
  recentErrors: Array<{
    time: string
    source: string
    message: string
  }>
  system: {
    memory: { total: string; free: string }
    uptime: number
  }
}

/**
 * Response from exportHealthReport
 */
export interface HealthExportResponse {
  success: boolean
  path?: string
  error?: string
}

/**
 * Process health info in health check
 */
export interface ProcessHealthInfo {
  expected: number
  actual: number
  pids: number[]
  healthy: boolean
}

/**
 * Service health info in health check
 */
export interface ServiceHealthInfo {
  port: number | null
  responsive: boolean
  responseTime?: number
  error?: string
}

/** The router reached from a child process started the way engine processes start. */
export interface ChildLocalConnectionInfo {
  reachable: boolean
  /** Refused by the system (EACCES/EPERM): security software, not Halo, is in the way. */
  blocked: boolean
  /** Error code or reason when not reachable. */
  error?: string
  /** The program the child ran, which an allowlist has to name. */
  program: string
}

/**
 * Response from runHealthCheck
 */
export interface HealthCheckResponse {
  timestamp: number
  processes: {
    claude: ProcessHealthInfo
    cloudflared: ProcessHealthInfo
  }
  services: {
    openaiRouter: ServiceHealthInfo
    httpServer: ServiceHealthInfo
    /** Absent when the router is not running or the check was not asked for. */
    childLocalConnection?: ChildLocalConnectionInfo
  }
  issues: string[]
  healthy: boolean
  registryCleanup: {
    removed: number
    orphans: number
  }
}
