/**
 * Health Orchestrator - Central coordination for health system
 *
 * This is the main entry point for the health system.
 * It coordinates:
 * - Startup health checks
 * - Runtime event monitoring
 * - Recovery strategy selection and execution
 * - Status reporting
 */

import type {
  HealthSystemState,
  HealthStatus,
  HealthEvent,
  RecoveryResult
} from './types'
import {
  markInstanceStart,
  markCleanExit
} from './process-guardian'
import {
  startFallbackPolling,
  stopFallbackPolling,
  isPollingActive,
  onHealthEvent,
  emitHealthEvent,
  emitRendererCrash,
  emitRendererUnresponsive,
  emitAgentError
} from './health-checker'
import {
  executeRecovery,
  executeRecoveryWithUI,
  selectRecoveryStrategy,
  injectSessionCleanup,
  canRecover,
  getRecoveryStats,
  updateErrorCount,
  resetDialogSuppression
} from './recovery-manager'
import { sendToRenderer } from '../window.service'

// ============================================
// State
// ============================================

let systemState: HealthSystemState = {
  status: 'healthy',
  instanceId: '',
  startedAt: 0,
  consecutiveFailures: 0,
  recoveryAttempts: 0,
  isPollingActive: false,
  isEnabled: true,
  recentEvents: []
}

// Self-failure tracking
let selfFailures = 0
const MAX_SELF_FAILURES = 5

// Session cleanup function (injected from agent service)
let closeAllSessionsFn: (() => void) | null = null

// ============================================
// Initialization
// ============================================

/**
 * Mark instance start - MUST be called synchronously at app startup
 *
 * This is the first function called in the health system lifecycle.
 * It generates the instance ID used to distinguish orphan processes.
 *
 * Performance: <1ms synchronous operation
 */
export function initInstanceId(): string {
  const instanceId = markInstanceStart()
  systemState.instanceId = instanceId
  systemState.startedAt = Date.now()

  console.log(`[Health][Orchestrator] Instance initialized: ${instanceId.slice(0, 8)}...`)
  return instanceId
}

/**
 * Initialize the health system (async, runs in Extended phase)
 *
 * This function should be called AFTER the window is visible,
 * during Extended Services initialization.
 */
export async function initializeHealthSystem(): Promise<void> {
  if (!systemState.instanceId) {
    console.warn('[Health][Orchestrator] Instance ID not set - call initInstanceId() first')
    systemState.instanceId = initInstanceId()
  }

  console.log('[Health][Orchestrator] Initializing health system...')

  try {
    // Inject session cleanup function into recovery manager
    if (closeAllSessionsFn) {
      injectSessionCleanup(closeAllSessionsFn)
    }

    // Startup checks disabled - waste CPU/time for diagnostics that don't trigger recovery.
    // Issues are caught naturally when they matter:
    // - Config errors -> agent startup fails -> emitAgentError -> critical event
    // - Port conflicts -> remote access fails -> user sees error
    // - Disk full -> file write fails -> user sees error
    // - Orphan processes -> cleanupOrphans() already handles this
    //
    // Event-driven checks (runtime) are still active for actual error recovery.

    // Register health event handler for automatic recovery
    onHealthEvent(handleHealthEvent)

    // Start fallback polling (runtime checks only)
    startFallbackPolling(handleStatusChange)

    systemState.isPollingActive = true

    console.log('[Health][Orchestrator] Health system initialized (event-driven mode)')
  } catch (error) {
    handleSelfError(error as Error)
  }
}

/**
 * Set the session cleanup function
 * Called by agent service during initialization
 */
export function setSessionCleanupFn(fn: () => void): void {
  closeAllSessionsFn = fn
  injectSessionCleanup(fn)
}

// ============================================
// Event Handlers
// ============================================

/**
 * Handle incoming health events
 */
function handleHealthEvent(event: HealthEvent): void {
  // Skip if health system is disabled (self-protection)
  if (!systemState.isEnabled) {
    return
  }

  try {
    // Update recent events
    systemState.recentEvents.unshift(event)
    if (systemState.recentEvents.length > 50) {
      systemState.recentEvents.pop()
    }

    // Handle info events - reset consecutive failures on success
    if (event.category === 'info') {
      // Reset consecutive failures on recovery success or normal operation
      if (event.type === 'recovery_success' || event.type === 'startup_check') {
        systemState.consecutiveFailures = 0
        updateErrorCount(0)
        systemState.status = 'healthy'
      }
    }

    // Handle critical events
    if (event.category === 'critical') {
      systemState.consecutiveFailures++

      // Sync error count to executor for UI display
      updateErrorCount(systemState.consecutiveFailures)

      // Check if recovery is needed
      const strategyId = selectRecoveryStrategy(
        systemState.consecutiveFailures,
        event.source
      )

      if (strategyId && canRecover()) {
        console.log(`[Health][Orchestrator] Triggering recovery strategy: ${strategyId}`)

        // S1 and S2: Auto-recover without user consent
        if (strategyId === 'S1' || strategyId === 'S2') {
          attemptRecovery(strategyId)
        }
        // S3 and S4: Require user consent via UI dialog
        else if (strategyId === 'S3' || strategyId === 'S4') {
          attemptRecoveryWithUI(strategyId, event.message)
        }
      }
    }

    // Update status
    updateStatus(event)
  } catch (error) {
    handleSelfError(error as Error)
  }
}

/**
 * Handle status changes from fallback polling
 */
function handleStatusChange(status: HealthStatus, message: string): void {
  const previousStatus = systemState.status

  if (status !== previousStatus) {
    systemState.status = status

    // Notify renderer
    sendToRenderer('health:status-change', {
      status,
      previousStatus,
      reason: message,
      timestamp: Date.now()
    })

    console.log(`[Health][Orchestrator] Status changed: ${previousStatus} -> ${status}`)
  }
}

/**
 * Update health status based on event
 */
function updateStatus(event: HealthEvent): void {
  let newStatus: HealthStatus = systemState.status

  if (event.category === 'critical') {
    newStatus = 'unhealthy'
  } else if (event.category === 'warning' && systemState.status === 'healthy') {
    newStatus = 'degraded'
  }

  if (newStatus !== systemState.status) {
    handleStatusChange(newStatus, event.message)
  }
}

// ============================================
// Recovery
// ============================================

/**
 * Attempt automatic recovery (S1/S2 - no user consent needed)
 */
async function attemptRecovery(strategyId: 'S1' | 'S2'): Promise<void> {
  try {
    systemState.recoveryAttempts++

    const result = await executeRecovery(strategyId, false)

    if (result.success) {
      // Reset failure counters on successful recovery
      systemState.consecutiveFailures = 0
      updateErrorCount(0)
      systemState.status = 'healthy'

      console.log(`[Health][Orchestrator] Recovery ${strategyId} successful`)
    } else {
      console.warn(`[Health][Orchestrator] Recovery ${strategyId} failed: ${result.message}`)
    }
  } catch (error) {
    console.error(`[Health][Orchestrator] Recovery error:`, error)
  }
}

/**
 * Attempt recovery with UI dialog (S3/S4 - requires user consent)
 */
async function attemptRecoveryWithUI(strategyId: 'S3' | 'S4', errorMessage?: string): Promise<void> {
  try {
    systemState.recoveryAttempts++

    const result = await executeRecoveryWithUI(strategyId, errorMessage)

    if (result.success) {
      // Reset failure counters on successful recovery
      systemState.consecutiveFailures = 0
      updateErrorCount(0)
      systemState.status = 'healthy'

      console.log(`[Health][Orchestrator] Recovery ${strategyId} successful (with UI)`)
    } else {
      console.warn(`[Health][Orchestrator] Recovery ${strategyId} failed or cancelled: ${result.message}`)
    }
  } catch (error) {
    console.error(`[Health][Orchestrator] Recovery with UI error:`, error)
  }
}

/**
 * Trigger manual recovery (with user consent for S3/S4)
 */
export async function triggerRecovery(
  strategyId: 'S1' | 'S2' | 'S3' | 'S4',
  userConsented: boolean = false
): Promise<RecoveryResult> {
  systemState.recoveryAttempts++
  return executeRecovery(strategyId, userConsented)
}

/**
 * Trigger manual recovery with UI dialog
 */
export async function triggerRecoveryWithUI(
  strategyId: 'S1' | 'S2' | 'S3' | 'S4',
  errorMessage?: string
): Promise<RecoveryResult> {
  systemState.recoveryAttempts++
  return executeRecoveryWithUI(strategyId, errorMessage)
}

// ============================================
// External Event Handlers (called from other services)
// ============================================

/**
 * Handle agent error (called from agent service)
 */
export function onAgentError(conversationId: string, error: string): void {
  emitAgentError(conversationId, error)
}

/**
 * Handle process exit (called from session manager)
 */
export function onProcessExit(processId: string, code: number | null): void {
  emitHealthEvent(
    'process_exit',
    'critical',
    processId,
    `Process exited with code ${code}`,
    { exitCode: code }
  )
}

/**
 * Handle renderer crash (called from main process)
 */
export function onRendererCrash(details: { reason: string }): void {
  emitRendererCrash(details.reason)
}

/**
 * Handle renderer unresponsive (called from main process)
 */
export function onRendererUnresponsive(): void {
  emitRendererUnresponsive()
}

// ============================================
// Shutdown
// ============================================

/**
 * Clean shutdown of health system
 */
export function shutdownHealthSystem(): void {
  console.log('[Health][Orchestrator] Shutting down health system...')

  try {
    // Stop polling
    stopFallbackPolling()

    // Mark clean exit
    markCleanExit()

    console.log('[Health][Orchestrator] Health system shut down')
  } catch (error) {
    console.error('[Health][Orchestrator] Shutdown error:', error)
  }
}

// ============================================
// Status and Diagnostics
// ============================================

/**
 * Get current health system state
 */
export function getHealthState(): HealthSystemState {
  return {
    ...systemState,
    isPollingActive: isPollingActive()
  }
}

/**
 * Get health status summary
 */
export function getHealthStatus(): {
  status: HealthStatus
  instanceId: string
  uptime: number
  consecutiveFailures: number
  recoveryAttempts: number
} {
  return {
    status: systemState.status,
    instanceId: systemState.instanceId,
    uptime: Date.now() - systemState.startedAt,
    consecutiveFailures: systemState.consecutiveFailures,
    recoveryAttempts: systemState.recoveryAttempts
  }
}

// ============================================
// Self-Protection
// ============================================

/**
 * Handle errors in the health system itself
 */
function handleSelfError(error: Error): void {
  selfFailures++
  console.error(`[Health][Orchestrator] Self-failure ${selfFailures}:`, error.message)

  if (selfFailures >= MAX_SELF_FAILURES) {
    console.warn('[Health][Orchestrator] Too many self-failures, disabling health system')
    disableHealthSystem()
  }
}

/**
 * Disable health system (self-protection)
 */
function disableHealthSystem(): void {
  systemState.isEnabled = false
  stopFallbackPolling()
  console.warn('[Health][Orchestrator] Health system disabled due to repeated failures')
}
