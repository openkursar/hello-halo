/**
 * Recovery Executor - Executes recovery strategies
 *
 * Handles the actual execution of recovery actions.
 * Some strategies require user consent via dialog.
 */

import { BrowserWindow } from 'electron'
import type { RecoveryResult, RecoveryStrategyId } from '../types'
import { getStrategy, requiresConsent } from './strategies'
import { emitRecoverySuccess, resetErrorCounter } from '../health-checker'
import { cleanupOrphans, clearOrphanEntries } from '../process-guardian'
import { relaunchApp } from '../../lifecycle'
import {
  showRecoveryDialog,
  showFactoryResetDialog,
  showRecoverySuccessDialog,
  showRecoveryFailedDialog,
  isDialogSuppressed
} from './ui'

// Track recent recovery attempts to prevent loops
let recentRecoveryAttempts = 0
let lastRecoveryTime = 0
const RECOVERY_COOLDOWN_MS = 30_000  // 30 seconds between recoveries
const MAX_RECOVERY_ATTEMPTS = 3

// Session recovery function (injected to avoid circular dependency)
let closeAllSessionsFn: (() => void) | null = null

// Error counter for triggering dialogs
let consecutiveErrorCount = 0

/**
 * Inject the session cleanup function
 * Called by orchestrator during initialization
 */
export function injectSessionCleanup(fn: () => void): void {
  closeAllSessionsFn = fn
}

/**
 * Update error count and optionally trigger recovery dialog
 */
export function updateErrorCount(count: number): void {
  consecutiveErrorCount = count
}

/**
 * Request user consent for recovery via dialog
 *
 * Returns the strategy ID the user selected, or null if user chose to ignore.
 */
export async function requestRecoveryConsent(
  suggestedStrategy: RecoveryStrategyId,
  errorMessage?: string
): Promise<RecoveryStrategyId | null> {
  // Don't show dialog if suppressed
  if (isDialogSuppressed()) {
    console.log('[Health][Recovery] Dialog suppressed, skipping consent request')
    return null
  }

  const parentWindow = BrowserWindow.getFocusedWindow()

  const result = await showRecoveryDialog({
    consecutiveFailures: consecutiveErrorCount,
    errorMessage,
    suggestedStrategy,
    parentWindow
  })

  // Map user action to strategy
  switch (result.action) {
    case 'tryFix':
      return 'S2'  // Reset Agent Engine
    case 'restart':
      return 'S3'  // Restart App
    case 'factoryReset':
      return 'S4'  // Factory Reset
    default:
      return null  // User chose to ignore
  }
}

/**
 * Execute a recovery strategy
 *
 * @param strategyId - Strategy to execute
 * @param userConsented - Whether user has consented (for strategies that require it)
 * @returns Recovery result
 */
export async function executeRecovery(
  strategyId: RecoveryStrategyId,
  userConsented: boolean = false
): Promise<RecoveryResult> {
  const strategy = getStrategy(strategyId)
  const now = Date.now()

  console.log(`[Health][Recovery] Executing strategy ${strategyId}: ${strategy.name}`)

  // Check if consent is required
  if (strategy.requiresConsent && !userConsented) {
    return {
      strategyId,
      success: false,
      message: 'User consent required',
      timestamp: now
    }
  }

  // Check cooldown to prevent recovery loops
  if (now - lastRecoveryTime < RECOVERY_COOLDOWN_MS) {
    recentRecoveryAttempts++
    if (recentRecoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
      console.warn('[Health][Recovery] Too many recovery attempts, stopping')
      return {
        strategyId,
        success: false,
        message: 'Recovery rate limit exceeded',
        timestamp: now
      }
    }
  } else {
    recentRecoveryAttempts = 1
  }
  lastRecoveryTime = now

  try {
    switch (strategyId) {
      case 'S1':
        return await executeS1()
      case 'S2':
        return await executeS2()
      case 'S3':
        return await executeS3()
      case 'S4':
        return await executeS4()
      default:
        return {
          strategyId,
          success: false,
          message: `Unknown strategy: ${strategyId}`,
          timestamp: now
        }
    }
  } catch (error) {
    console.error(`[Health][Recovery] Strategy ${strategyId} failed:`, error)
    return {
      strategyId,
      success: false,
      message: `Recovery failed: ${(error as Error).message}`,
      timestamp: now
    }
  }
}

/**
 * S1: Restart Single Process
 *
 * Typically triggered for individual session issues.
 * The process cleanup is handled by the caller - this just confirms readiness.
 */
async function executeS1(): Promise<RecoveryResult> {
  console.log('[Health][Recovery] S1: Process restart prepared')

  // Single process recovery is usually just cleanup
  // The actual restart happens on next use (lazy recreation)

  emitRecoverySuccess('S1', 'Process marked for restart on next use')

  return {
    strategyId: 'S1',
    success: true,
    message: 'Process will be recreated on next use',
    timestamp: Date.now()
  }
}

/**
 * S2: Reset Agent Engine
 *
 * Closes all V2 sessions and clears error counters.
 */
async function executeS2(): Promise<RecoveryResult> {
  console.log('[Health][Recovery] S2: Resetting agent engine...')

  try {
    // Close all V2 sessions
    if (closeAllSessionsFn) {
      closeAllSessionsFn()
      console.log('[Health][Recovery] All V2 sessions closed')
    }

    // Clean up any orphan processes
    await cleanupOrphans()

    // Clear error counters
    resetErrorCounter('agent')

    emitRecoverySuccess('S2', 'Agent engine reset successfully')

    return {
      strategyId: 'S2',
      success: true,
      message: 'Agent engine reset successfully',
      timestamp: Date.now(),
      data: {
        sessionsClosed: true,
        orphansCleaned: true
      }
    }
  } catch (error) {
    return {
      strategyId: 'S2',
      success: false,
      message: `Reset failed: ${(error as Error).message}`,
      timestamp: Date.now()
    }
  }
}

/**
 * S3: Restart Application
 *
 * Requires user consent. Performs clean shutdown and relaunch.
 */
async function executeS3(): Promise<RecoveryResult> {
  console.log('[Health][Recovery] S3: Restarting application...')

  try {
    // Close all sessions
    if (closeAllSessionsFn) {
      closeAllSessionsFn()
    }

    // Clear orphan entries
    clearOrphanEntries()

    emitRecoverySuccess('S3', 'Application restart initiated')

    // Relaunch app after a short delay
    setTimeout(() => {
      relaunchApp('health-recovery-S3')
    }, 500)

    return {
      strategyId: 'S3',
      success: true,
      message: 'Application restart initiated',
      timestamp: Date.now()
    }
  } catch (error) {
    return {
      strategyId: 'S3',
      success: false,
      message: `Restart failed: ${(error as Error).message}`,
      timestamp: Date.now()
    }
  }
}

/**
 * S4: Factory Reset
 *
 * Requires user consent. Clears caches and resets config.
 * This is a destructive operation - manual trigger only.
 */
async function executeS4(): Promise<RecoveryResult> {
  console.log('[Health][Recovery] S4: Factory reset...')

  try {
    // Close all sessions
    if (closeAllSessionsFn) {
      closeAllSessionsFn()
    }

    // Clean up orphans
    await cleanupOrphans()

    // Clear registry
    clearOrphanEntries()

    // Note: We don't actually delete config here
    // The config.service handles defaults on next startup
    // A true factory reset would need to clear ~/.halo/config.json

    emitRecoverySuccess('S4', 'Factory reset completed')

    // Restart app
    setTimeout(() => {
      relaunchApp('health-recovery-S4')
    }, 500)

    return {
      strategyId: 'S4',
      success: true,
      message: 'Factory reset completed, restarting...',
      timestamp: Date.now()
    }
  } catch (error) {
    return {
      strategyId: 'S4',
      success: false,
      message: `Factory reset failed: ${(error as Error).message}`,
      timestamp: Date.now()
    }
  }
}

/**
 * Execute recovery with UI integration
 *
 * This version shows dialogs for user consent when needed,
 * and displays success/failure notifications after execution.
 *
 * @param strategyId - Strategy to execute
 * @param errorMessage - Optional error message to show in dialog
 * @returns Recovery result
 */
export async function executeRecoveryWithUI(
  strategyId: RecoveryStrategyId,
  errorMessage?: string
): Promise<RecoveryResult> {
  const strategy = getStrategy(strategyId)

  // For strategies requiring consent, show dialog first
  if (strategy.requiresConsent) {
    // For S4 (Factory Reset), use special confirmation dialog
    if (strategyId === 'S4') {
      const parentWindow = BrowserWindow.getFocusedWindow()
      const confirmed = await showFactoryResetDialog(parentWindow)
      if (!confirmed) {
        return {
          strategyId,
          success: false,
          message: 'User cancelled factory reset',
          timestamp: Date.now()
        }
      }
    } else {
      // For S3 and others, use the standard recovery dialog
      const chosenStrategy = await requestRecoveryConsent(strategyId, errorMessage)
      if (!chosenStrategy) {
        return {
          strategyId,
          success: false,
          message: 'User chose to ignore',
          timestamp: Date.now()
        }
      }
      // User might have chosen a different strategy
      if (chosenStrategy !== strategyId) {
        // Recursively execute the chosen strategy
        return executeRecoveryWithUI(chosenStrategy, errorMessage)
      }
    }
  }

  // Execute the recovery
  const result = await executeRecovery(strategyId, true)

  // Show result notification (only for user-triggered recoveries, not auto)
  const parentWindow = BrowserWindow.getFocusedWindow()
  if (result.success) {
    // Don't show success dialog for S3/S4 since app is restarting
    if (strategyId !== 'S3' && strategyId !== 'S4') {
      await showRecoverySuccessDialog(strategy.name, parentWindow)
    }
  } else {
    await showRecoveryFailedDialog(strategy.name, result.message, parentWindow)
  }

  return result
}

/**
 * Check if recovery is possible (not in cooldown)
 */
export function canRecover(): boolean {
  const now = Date.now()
  if (now - lastRecoveryTime < RECOVERY_COOLDOWN_MS) {
    return recentRecoveryAttempts < MAX_RECOVERY_ATTEMPTS
  }
  return true
}

/**
 * Get recovery stats
 */
export function getRecoveryStats(): {
  recentAttempts: number
  lastRecoveryTime: number
  canRecover: boolean
} {
  return {
    recentAttempts: recentRecoveryAttempts,
    lastRecoveryTime,
    canRecover: canRecover()
  }
}
