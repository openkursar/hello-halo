/**
 * Health System Types
 *
 * Core type definitions for the System Health Management (SHM) module.
 */

import type { ChildLocalConnectionInfo } from '../../../shared/types/health'

// ============================================
// Process Registry Types
// ============================================

/**
 * Process types that can be tracked by the health system
 */
export type ProcessType = 'v2-session' | 'tunnel' | 'openai-router' | 'http-server'

/**
 * Individual process entry in the registry
 */
export interface ProcessEntry {
  /** Logical ID (e.g., conversationId for v2-session) */
  id: string
  /** OS process ID (null if PID unavailable) */
  pid: number | null
  /** Type of process */
  type: ProcessType
  /** App instance that created this process */
  instanceId: string
  /** When the process was started */
  startedAt: number
  /** Last known heartbeat time */
  lastHeartbeat: number
}

/**
 * Health registry persisted to disk
 * Location: ~/.halo/.health-registry.json
 */
export interface HealthRegistry {
  /** Registry format version */
  version: 1
  /** Current app instance UUID */
  instanceId: string
  /** Previous instance ID (for cleanup reference) */
  previousInstanceId?: string
  /** When this instance started */
  startedAt: number
  /** Did the last run exit cleanly? */
  lastCleanExit: boolean
  /** Registered processes */
  processes: ProcessEntry[]
}

// ============================================
// Health Check Types
// ============================================

/**
 * Severity levels for health issues
 */
export type HealthSeverity = 'info' | 'warning' | 'critical'

/**
 * Health check result status
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

/**
 * Base interface for all probe results
 */
export interface ProbeResult {
  /** Probe name for identification */
  name: string
  /** Whether the check passed */
  healthy: boolean
  /** Severity of any issues found */
  severity: HealthSeverity
  /** Human-readable message */
  message: string
  /** When the check was performed */
  timestamp: number
  /** Optional structured data */
  data?: Record<string, unknown>
}

/**
 * Config probe result
 */
export interface ConfigProbeResult extends ProbeResult {
  name: 'config'
  data?: {
    fileExists: boolean
    jsonValid: boolean
    criticalFieldsPresent: boolean
    apiKeyConfigured: boolean
    errors: string[]
  }
}

/**
 * Port probe result
 */
export interface PortProbeResult extends ProbeResult {
  name: 'port'
  data?: {
    portsChecked: number[]
    portsOccupied: Array<{ port: number; processName?: string }>
    portsAvailable: number[]
  }
}

/**
 * Disk probe result
 */
export interface DiskProbeResult extends ProbeResult {
  name: 'disk'
  data?: {
    path: string
    freeSpace: number
    totalSpace: number
    freePercent: number
    thresholdMB: number
  }
}

/**
 * Process probe result
 */
export interface ProcessProbeResult extends ProbeResult {
  name: 'process'
  data?: {
    orphansFound: Array<{ pid: number; type: ProcessType; instanceId: string }>
    currentProcesses: ProcessEntry[]
    zombiesKilled: number
  }
}

/**
 * Service probe result (for runtime checks)
 */
export interface ServiceProbeResult extends ProbeResult {
  name: 'service'
  data?: {
    serviceName: string
    responsive: boolean
    responseTime?: number
    error?: string
  }
}

/**
 * Combined startup check results
 */
export interface StartupCheckResult {
  /** Overall health status */
  status: HealthStatus
  /** All probe results */
  probes: ProbeResult[]
  /** Total check duration in ms */
  duration: number
  /** When checks were performed */
  timestamp: number
}

// ============================================
// Recovery Types
// ============================================

/**
 * Recovery strategy identifiers
 */
export type RecoveryStrategyId = 'S1' | 'S2' | 'S3' | 'S4'

/**
 * Recovery strategy definition
 */
export interface RecoveryStrategy {
  /** Strategy ID */
  id: RecoveryStrategyId
  /** Human-readable name */
  name: string
  /** Description of what this strategy does */
  description: string
  /** When to trigger this strategy */
  trigger: string
  /** Actions to perform */
  actions: string[]
  /** Does this require user consent? */
  requiresConsent: boolean
}

/**
 * Recovery attempt result
 */
export interface RecoveryResult {
  /** Strategy that was executed */
  strategyId: RecoveryStrategyId
  /** Whether recovery succeeded */
  success: boolean
  /** Result message */
  message: string
  /** When recovery was attempted */
  timestamp: number
  /** Additional data */
  data?: Record<string, unknown>
}

// ============================================
// Health Event Types
// ============================================

/**
 * Health event categories
 */
export type HealthEventCategory = 'critical' | 'warning' | 'info'

/**
 * Health event types
 */
export type HealthEventType =
  | 'agent_error'
  | 'process_exit'
  | 'renderer_crash'
  | 'renderer_unresponsive'
  | 'network_error'
  | 'config_change'
  | 'recovery_success'
  | 'startup_check'

/**
 * Health event emitted by the system
 */
export interface HealthEvent {
  /** Event type */
  type: HealthEventType
  /** Event category */
  category: HealthEventCategory
  /** When the event occurred */
  timestamp: number
  /** Event source (e.g., conversationId, service name) */
  source: string
  /** Event message */
  message: string
  /** Additional data */
  data?: Record<string, unknown>
}

// ============================================
// Orchestrator Types
// ============================================

/**
 * Overall health system state
 */
export interface HealthSystemState {
  /** Current health status */
  status: HealthStatus
  /** Current app instance ID */
  instanceId: string
  /** When health system started */
  startedAt: number
  /** Number of consecutive failures */
  consecutiveFailures: number
  /** Number of recovery attempts */
  recoveryAttempts: number
  /** Is fallback polling running? */
  isPollingActive: boolean
  /** Is health system enabled? */
  isEnabled: boolean
  /** Last startup check result */
  lastStartupCheck?: StartupCheckResult
  /** Recent health events */
  recentEvents: HealthEvent[]
}

/**
 * Health status change event (sent to renderer)
 */
export interface HealthStatusChange {
  status: HealthStatus
  previousStatus: HealthStatus
  reason: string
  timestamp: number
}

// ============================================
// Diagnostics Types
// ============================================

/**
 * Diagnostic report for debugging
 */
export interface DiagnosticReport {
  /** Report generation timestamp */
  timestamp: string
  /** App version */
  version: string
  /** Platform (darwin/win32/linux) */
  platform: string
  /** Architecture */
  arch: string

  /** Config summary (sanitized) */
  config: {
    currentSource: string
    provider: string
    hasApiKey: boolean
    apiUrlHost: string
    mcpServerCount: number
  }

  /** Process summary */
  processes: {
    registered: number
    orphansFound: number
    orphansCleaned: number
  }

  /** Health summary */
  health: {
    lastCheckTime: string
    consecutiveFailures: number
    recoveryAttempts: number
  }

  /** Recent errors (sanitized) */
  recentErrors: Array<{
    time: string
    source: string
    message: string
  }>

  /** System info */
  system: {
    memory: { total: string; free: string }
    uptime: number
  }
}

// ============================================
// Platform Operations Interface
// ============================================

/**
 * Platform-specific process operations
 */
export interface PlatformProcessOps {
  /** Find processes by command-line pattern */
  findByArgs(pattern: string): Promise<ProcessInfo[]>
  /** Find child processes by parent PID */
  findChildProcesses(ppid: number): Promise<ChildProcessInfo[]>
  /** Kill a process by PID */
  killProcess(pid: number, signal?: string): Promise<void>
  /** Check if a process is alive */
  isProcessAlive(pid: number): boolean
}

/**
 * Process info from platform-specific discovery
 */
export interface ProcessInfo {
  pid: number
  commandLine: string
  name?: string
}

/**
 * Child process info from PPID scanning
 */
export interface ChildProcessInfo {
  pid: number
  ppid: number
  name: string
}

// ============================================
// Cleanup Result Types
// ============================================

/**
 * Result of orphan cleanup operation
 */
export interface CleanupResult {
  /** Number of processes cleaned */
  cleaned: number
  /** Number of cleanup failures */
  failed: number
  /** Details of cleaned processes */
  details: Array<{
    pid: number
    type: ProcessType
    method: 'pid' | 'args'
  }>
}

// ============================================
// Immediate Check Types
// ============================================

/**
 * Process status in immediate check
 */
export interface ProcessCheckStatus {
  /** Number of processes expected (from Registry) */
  expected: number
  /** Number of processes actually running */
  actual: number
  /** PIDs of running processes */
  pids: number[]
  /** Whether the count matches */
  healthy: boolean
}

/**
 * Service status in immediate check
 */
export interface ServiceCheckStatus {
  /** Port number (null if not running) */
  port: number | null
  /** Whether the service responded to health check */
  responsive: boolean
  /** Response time in ms */
  responseTime?: number
  /** Error message if not responsive */
  error?: string
}

/** Checks the caller supplies to runImmediateCheck. */
export interface ImmediateCheckOptions {
  /** Connect to the router from a child process started like the engine's. */
  checkChildLocalConnection?: (port: number) => Promise<ChildLocalConnectionInfo>
}

/**
 * Result of immediate health check (runImmediateCheck)
 */
export interface ImmediateCheckResult {
  /** When the check was performed */
  timestamp: number

  /** Process status by type */
  processes: {
    claude: ProcessCheckStatus
    cloudflared: ProcessCheckStatus
  }

  /** Service status */
  services: {
    openaiRouter: ServiceCheckStatus
    httpServer: ServiceCheckStatus
    /** The router reached from a child process; absent when not checked. */
    childLocalConnection?: ChildLocalConnectionInfo
  }

  /** List of issues found */
  issues: string[]

  /** Overall health status */
  healthy: boolean

  /** Registry cleanup actions taken */
  registryCleanup: {
    /** Dead processes removed from registry */
    removed: number
    /** Orphan processes found (running but not in registry) */
    orphans: number
  }
}
