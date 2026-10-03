/**
 * Health System Module - System Health Management (SHM)
 *
 * Provides comprehensive health monitoring, process tracking,
 * and automatic recovery for the Halo application.
 *
 * Architecture:
 * - Process Guardian: Track and cleanup subprocess lifecycle
 * - Health Checker: Startup and runtime health probes
 * - Recovery Manager: Automatic and manual recovery strategies
 * - Diagnostics: Collect and export debug information
 * - Orchestrator: Central coordination
 *
 * Usage:
 * 1. Call initInstanceId() synchronously at app startup (<1ms)
 * 2. Call initializeHealthSystem() in Extended Services phase
 * 3. Call setSessionCleanupFn() to enable agent recovery
 * 4. Call shutdownHealthSystem() during app shutdown
 */

// ============================================
// Orchestrator (Main Entry Point)
// ============================================

export {
  initInstanceId,
  initializeHealthSystem,
  setSessionCleanupFn,
  shutdownHealthSystem,
  getHealthState,
  getHealthStatus,
  triggerRecovery,
  triggerRecoveryWithUI,
  onAgentError,
  onProcessExit,
  onRendererCrash,
  onRendererUnresponsive
} from './orchestrator'

// ============================================
// Resource Sampling (single source of resource numbers)
// ============================================

export {
  getLatestResourceSample,
  onResourceSample,
  sampleResourcesNow,
  formatResourceSample
} from './resource-sampler'
export type { ResourceSample } from './resource-sampler'

// ============================================
// Process Guardian
// ============================================

export {
  // Instance management
  markInstanceStart,
  getCurrentInstanceId,
  getPreviousInstanceId,

  // Registry operations
  registerProcess,
  unregisterProcess,
  updateHeartbeat,
  getCurrentProcesses,
  getOrphanProcesses,
  markCleanExit,
  wasLastExitClean,
  getRegistryStats,

  // Cleanup
  cleanupOrphans,
  verifyCleanup,
  getRunningHaloProcesses,

  // Platform operations
  getPlatformOps
} from './process-guardian'

// ============================================
// Health Checker
// ============================================

export {
  // Startup checks
  runStartupChecks,
  runQuickHealthCheck,

  // Runtime monitoring
  startFallbackPolling,
  stopFallbackPolling,
  isPollingActive,
  runImmediateCheck,
  getRuntimeStatus,
  runPpidScanAndCleanup,

  // Event handling
  onHealthEvent,
  emitHealthEvent,
  emitAgentError,
  emitProcessExit,
  emitRendererCrash,
  emitRendererUnresponsive,
  emitNetworkError,
  emitConfigChange,
  emitRecoverySuccess,
  getRecentEvents,
  clearRecentEvents,
  trackError,
  resetErrorCounter,
  getErrorCount,

  // Probes
  runConfigProbe,
  runPortProbe,
  runDiskProbe,
  runProcessProbe,
  checkOpenAIRouter,
  checkHttpServer,
  findAvailablePort
} from './health-checker'

// ============================================
// Recovery Manager
// ============================================

export {
  // Strategies
  RECOVERY_STRATEGIES,
  ERROR_THRESHOLDS,
  getStrategy,
  selectRecoveryStrategy,
  requiresConsent,

  // Executor
  executeRecovery,
  executeRecoveryWithUI,
  canRecover,
  getRecoveryStats,
  updateErrorCount,
  requestRecoveryConsent,

  // UI
  showRecoveryDialog,
  showRestartAppDialog,
  showFactoryResetDialog,
  showRecoverySuccessDialog,
  showRecoveryFailedDialog,
  resetDialogSuppression,
  isDialogSuppressed,
  suppressAllDialogs
} from './recovery-manager'
export type { RecoveryDialogResult, RecoveryDialogOptions } from './recovery-manager'

// ============================================
// Diagnostics
// ============================================

export {
  collectDiagnosticReport,
  generateReport,
  exportReport,
  formatReportAsText,
  sanitizeString,
  sanitizeUrl
} from './diagnostics'

// ============================================
// Types
// ============================================

export type {
  // Process types
  ProcessType,
  ProcessEntry,
  HealthRegistry,
  CleanupResult,
  PlatformProcessOps,
  ProcessInfo,

  // Health check types
  HealthSeverity,
  HealthStatus,
  ProbeResult,
  ConfigProbeResult,
  PortProbeResult,
  DiskProbeResult,
  ProcessProbeResult,
  ServiceProbeResult,
  StartupCheckResult,

  // Recovery types
  RecoveryStrategyId,
  RecoveryStrategy,
  RecoveryResult,

  // Event types
  HealthEventCategory,
  HealthEventType,
  HealthEvent,

  // State types
  HealthSystemState,
  HealthStatusChange,

  // Diagnostic types
  DiagnosticReport,

  // Immediate check types
  ImmediateCheckResult,
  ProcessCheckStatus,
  ServiceCheckStatus,
  ChildProcessInfo
} from './types'
