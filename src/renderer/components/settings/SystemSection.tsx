/**
 * System Section Component
 * Manages permissions, auto-launch, logs, and diagnostics
 */

import { useState, useEffect } from 'react'
import {
  FolderOpen, Activity, Loader2, AlertTriangle, CheckCircle,
  XOctagon, ChevronRight, Copy, FileText, RotateCcw, RefreshCw
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { HaloConfig } from '../../types'
import type { HealthCheckResult, HealthReport } from './types'

interface SystemSectionProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
}

export function SystemSection({ config, setConfig }: SystemSectionProps) {
  const { t } = useTranslation()

  // System settings state
  const [autoLaunch, setAutoLaunch] = useState(config?.system?.autoLaunch || false)
  const [taskCompleteNotify, setTaskCompleteNotify] = useState(config?.notifications?.taskComplete || false)

  // Health diagnostics state
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false)
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false)
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null)
  const [isRecovering, setIsRecovering] = useState<string | null>(null)
  const [recoveryResult, setRecoveryResult] = useState<{
    success: boolean
    message: string
  } | null>(null)
  const [reportCopied, setReportCopied] = useState(false)
  const [healthCheckResult, setHealthCheckResult] = useState<HealthCheckResult | null>(null)

  // Load system settings
  useEffect(() => {
    loadSystemSettings()
  }, [])

  const loadSystemSettings = async () => {
    try {
      const autoLaunchRes = await api.getAutoLaunch()
      if (autoLaunchRes.success) {
        setAutoLaunch(autoLaunchRes.data as boolean)
      }
    } catch (error) {
      console.error('[SystemSection] Failed to load system settings:', error)
    }
  }

  // Handle auto launch change
  const handleAutoLaunchChange = async (enabled: boolean) => {
    setAutoLaunch(enabled)
    try {
      await api.setAutoLaunch(enabled)
    } catch (error) {
      console.error('[SystemSection] Failed to set auto launch:', error)
      setAutoLaunch(!enabled) // Revert on error
    }
  }

  // Handle notification toggle
  const handleTaskNotifyChange = async (enabled: boolean) => {
    setTaskCompleteNotify(enabled)
    try {
      const updatedConfig = {
        ...config,
        notifications: { ...config?.notifications, taskComplete: enabled }
      } as HaloConfig
      await api.setConfig({ notifications: updatedConfig.notifications })
      setConfig(updatedConfig)
    } catch (error) {
      console.error('[SystemSection] Failed to update notification settings:', error)
      setTaskCompleteNotify(!enabled) // Revert on error
    }
  }

  // Handle run diagnostics
  const handleRunDiagnostics = async () => {
    setIsRunningDiagnostics(true)
    setRecoveryResult(null)
    try {
      // First, run immediate health check (PPID scan + service probes)
      const checkResult = await api.runHealthCheck()
      if (checkResult.success && checkResult.data) {
        setHealthCheckResult(checkResult.data)
      }

      // Then, generate the full diagnostic report
      const result = await api.generateHealthReport()
      if (result.success && result.data) {
        setHealthReport(result.data)
        setDiagnosticsExpanded(true)
      }
    } catch (error) {
      console.error('[SystemSection] Failed to run diagnostics:', error)
    } finally {
      setIsRunningDiagnostics(false)
    }
  }

  // Handle recovery action
  const handleRecovery = async (strategyId: string) => {
    setIsRecovering(strategyId)
    setRecoveryResult(null)
    try {
      const result = await api.triggerHealthRecovery(strategyId, true)
      if (result.success && result.data) {
        setRecoveryResult({
          success: result.data.success,
          message: result.data.message
        })
        if (result.data.success) {
          setTimeout(handleRunDiagnostics, 1000)
        }
      }
    } catch (error) {
      setRecoveryResult({
        success: false,
        message: t('Recovery failed')
      })
    } finally {
      setIsRecovering(null)
    }
  }

  // Copy report to clipboard
  const handleCopyReport = async () => {
    try {
      const result = await api.generateHealthReportText()
      if (result.success && result.data) {
        await navigator.clipboard.writeText(result.data)
        setReportCopied(true)
        setTimeout(() => setReportCopied(false), 2000)
      }
    } catch (error) {
      console.error('[SystemSection] Failed to copy report:', error)
    }
  }

  // Export report to file
  const handleExportReport = async () => {
    try {
      const result = await api.exportHealthReport()
      if (result.success && result.data?.path) {
        setRecoveryResult({
          success: true,
          message: t('Report exported to') + ': ' + result.data.path
        })
        setTimeout(() => setRecoveryResult(null), 3000)
      }
    } catch (error) {
      console.error('[SystemSection] Failed to export report:', error)
    }
  }

  // Get health status color and icon
  const getHealthStatusStyle = (status: string) => {
    switch (status) {
      case 'healthy':
        return { color: 'text-green-500', bg: 'bg-green-500/10', icon: CheckCircle }
      case 'degraded':
        return { color: 'text-amber-500', bg: 'bg-amber-500/10', icon: AlertTriangle }
      case 'unhealthy':
        return { color: 'text-red-500', bg: 'bg-red-500/10', icon: XOctagon }
      default:
        return { color: 'text-muted-foreground', bg: 'bg-muted', icon: Activity }
    }
  }

  return (
    <>
      {/* Permissions Section */}
      <section id="permissions" className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium">{t('Permissions')}</h2>
          <span className="text-xs px-2 py-1 rounded-full bg-green-500/20 text-green-500">
            {t('Full Permission Mode')}
          </span>
        </div>

        {/* Info banner */}
        <div className="bg-muted/50 rounded-lg p-3 mb-4 text-sm text-muted-foreground">
          {t('We recommend full trust mode - use natural language to control Halo.')}
        </div>

        {/* Trust Mode - always on */}
        <div className="flex items-center justify-between opacity-50">
          <div>
            <p className="font-medium">{t('Trust Mode')}</p>
            <p className="text-sm text-muted-foreground">{t('Automatically execute all operations')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-not-allowed">
            <input
              type="checkbox"
              checked={true}
              disabled
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-primary rounded-full">
              <div className="w-5 h-5 bg-white rounded-full shadow-md transform translate-x-5 mt-0.5" />
            </div>
          </label>
        </div>
      </section>

      {/* System Section */}
      <section id="system" className="bg-card rounded-xl border border-border p-6">
        <h2 className="text-lg font-medium mb-4">{t('System')}</h2>

        <div className="space-y-4">
          {/* Auto Launch */}
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium">{t('Auto Launch on Startup')}</p>
                <span
                  className="inline-flex items-center justify-center w-4 h-4 text-xs rounded-full bg-muted text-muted-foreground cursor-help"
                  title={t('Automatically run Halo when system starts')}
                >
                  ?
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {t('Automatically run Halo when system starts')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={autoLaunch}
                onChange={(e) => handleAutoLaunchChange(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                    autoLaunch ? 'translate-x-5' : 'translate-x-0.5'
                  } mt-0.5`}
                />
              </div>
            </label>
          </div>

          {/* Task Complete Notification */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="flex-1">
              <p className="font-medium">{t('Task Notifications')}</p>
              <p className="text-sm text-muted-foreground">
                {t('Notify when a task completes in the background')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={taskCompleteNotify}
                onChange={(e) => handleTaskNotifyChange(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-secondary rounded-full peer peer-checked:bg-primary transition-colors">
                <div
                  className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                    taskCompleteNotify ? 'translate-x-5' : 'translate-x-0.5'
                  } mt-0.5`}
                />
              </div>
            </label>
          </div>

          {/* Open Log Folder */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="flex-1">
              <p className="font-medium">{t('Log Files')}</p>
              <p className="text-sm text-muted-foreground">
                {t('Open log folder for troubleshooting')}
              </p>
            </div>
            <button
              onClick={() => api.openLogFolder()}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              {t('Open Folder')}
            </button>
          </div>

          {/* System Diagnostics */}
          <div className="pt-4 border-t border-border">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <p className="font-medium">{t('System Diagnostics')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('Check system health and fix issues')}
                </p>
              </div>
              <button
                onClick={handleRunDiagnostics}
                disabled={isRunningDiagnostics}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors disabled:opacity-50"
              >
                {isRunningDiagnostics ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Activity className="w-4 h-4" />
                )}
                {isRunningDiagnostics ? t('Running...') : t('Run Diagnostics')}
              </button>
            </div>

            {/* Diagnostics Results */}
            {healthReport && (
              <div className="mt-4 space-y-3">
                {/* Health Status Summary */}
                <div
                  className={`p-4 rounded-lg ${getHealthStatusStyle('healthy').bg} cursor-pointer`}
                  onClick={() => setDiagnosticsExpanded(!diagnosticsExpanded)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {(() => {
                        const hasIssues = healthReport.health.consecutiveFailures > 0 ||
                          healthReport.processes.orphansFound > 0 ||
                          healthReport.recentErrors.length > 0
                        const StatusIcon = hasIssues ? AlertTriangle : CheckCircle
                        const statusColor = hasIssues ? 'text-amber-500' : 'text-green-500'
                        return (
                          <>
                            <StatusIcon className={`w-5 h-5 ${statusColor}`} />
                            <div>
                              <p className="font-medium">
                                {hasIssues ? t('Issues Detected') : t('System Healthy')}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {t('Last check')}: {new Date(healthReport.timestamp).toLocaleString()}
                              </p>
                            </div>
                          </>
                        )
                      })()}
                    </div>
                    <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${diagnosticsExpanded ? 'rotate-90' : ''}`} />
                  </div>
                </div>

                {/* Expanded Details */}
                {diagnosticsExpanded && (
                  <div className="space-y-3 animate-in slide-in-from-top-2 duration-200">
                    {/* System Info */}
                    <div className="bg-muted/30 rounded-lg p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('System Info')}</p>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('Version')}</span>
                          <span>{healthReport.version}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('Platform')}</span>
                          <span>{healthReport.platform} ({healthReport.arch})</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('Memory')}</span>
                          <span>{healthReport.system.memory.free} / {healthReport.system.memory.total}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('Uptime')}</span>
                          <span>{Math.floor(healthReport.system.uptime / 3600)}h {Math.floor((healthReport.system.uptime % 3600) / 60)}m</span>
                        </div>
                      </div>
                    </div>

                    {/* Health Metrics */}
                    <div className="bg-muted/30 rounded-lg p-3 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Health Metrics')}</p>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('Consecutive Failures')}</span>
                          <span className={healthReport.health.consecutiveFailures > 0 ? 'text-amber-500' : ''}>
                            {healthReport.health.consecutiveFailures}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('Recovery Attempts')}</span>
                          <span>{healthReport.health.recoveryAttempts}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('Active Processes')}</span>
                          <span>{healthReport.processes.registered}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">{t('Orphans Found')}</span>
                          <span className={healthReport.processes.orphansFound > 0 ? 'text-amber-500' : ''}>
                            {healthReport.processes.orphansFound}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Process Status (from PPID scan) */}
                    {healthCheckResult && (
                      <div className="bg-muted/30 rounded-lg p-3 space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Process Status')}</p>
                        <div className="space-y-2">
                          {/* Claude processes */}
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <div className={`w-2 h-2 rounded-full ${healthCheckResult.processes.claude.healthy ? 'bg-green-500' : 'bg-amber-500'}`} />
                              <span className="text-muted-foreground">Claude (AI Sessions)</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={healthCheckResult.processes.claude.healthy ? '' : 'text-amber-500'}>
                                {healthCheckResult.processes.claude.actual} {t('running')}
                              </span>
                              {healthCheckResult.processes.claude.pids.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  (PID: {healthCheckResult.processes.claude.pids.join(', ')})
                                </span>
                              )}
                            </div>
                          </div>
                          {/* Cloudflared processes */}
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <div className={`w-2 h-2 rounded-full ${healthCheckResult.processes.cloudflared.actual === 0 ? 'bg-muted-foreground' : healthCheckResult.processes.cloudflared.healthy ? 'bg-green-500' : 'bg-amber-500'}`} />
                              <span className="text-muted-foreground">Cloudflared (Tunnel)</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={healthCheckResult.processes.cloudflared.actual === 0 ? 'text-muted-foreground' : healthCheckResult.processes.cloudflared.healthy ? '' : 'text-amber-500'}>
                                {healthCheckResult.processes.cloudflared.actual === 0 ? t('Not running') : `${healthCheckResult.processes.cloudflared.actual} ${t('running')}`}
                              </span>
                              {healthCheckResult.processes.cloudflared.pids.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  (PID: {healthCheckResult.processes.cloudflared.pids.join(', ')})
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Service Status (HTTP probes) */}
                    {healthCheckResult && (
                      <div className="bg-muted/30 rounded-lg p-3 space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Service Status')}</p>
                        <div className="space-y-2">
                          {/* OpenAI Router */}
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <div className={`w-2 h-2 rounded-full ${
                                healthCheckResult.services.openaiRouter.port === null ? 'bg-muted-foreground' :
                                healthCheckResult.services.openaiRouter.responsive ? 'bg-green-500' : 'bg-red-500'
                              }`} />
                              <span className="text-muted-foreground">OpenAI Router</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {healthCheckResult.services.openaiRouter.port === null ? (
                                <span className="text-muted-foreground">{t('Not started')}</span>
                              ) : healthCheckResult.services.openaiRouter.responsive ? (
                                <>
                                  <span className="text-green-500">{t('Healthy')}</span>
                                  <span className="text-xs text-muted-foreground">
                                    (:{healthCheckResult.services.openaiRouter.port}, {healthCheckResult.services.openaiRouter.responseTime}ms)
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="text-red-500">{t('Not responding')}</span>
                                  <span className="text-xs text-muted-foreground">
                                    (:{healthCheckResult.services.openaiRouter.port})
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          {/* HTTP Server */}
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <div className={`w-2 h-2 rounded-full ${
                                healthCheckResult.services.httpServer.port === null ? 'bg-muted-foreground' :
                                healthCheckResult.services.httpServer.responsive ? 'bg-green-500' : 'bg-red-500'
                              }`} />
                              <span className="text-muted-foreground">HTTP Server</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {healthCheckResult.services.httpServer.port === null ? (
                                <span className="text-muted-foreground">{t('Not started')}</span>
                              ) : healthCheckResult.services.httpServer.responsive ? (
                                <>
                                  <span className="text-green-500">{t('Healthy')}</span>
                                  <span className="text-xs text-muted-foreground">
                                    (:{healthCheckResult.services.httpServer.port}, {healthCheckResult.services.httpServer.responseTime}ms)
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="text-red-500">{t('Not responding')}</span>
                                  <span className="text-xs text-muted-foreground">
                                    (:{healthCheckResult.services.httpServer.port})
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Registry Cleanup */}
                    {healthCheckResult && (healthCheckResult.registryCleanup.removed > 0 || healthCheckResult.registryCleanup.orphans > 0) && (
                      <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 space-y-1">
                        <p className="text-xs font-medium text-amber-500 uppercase tracking-wide">{t('Cleanup Actions')}</p>
                        <div className="text-sm text-amber-500">
                          {healthCheckResult.registryCleanup.removed > 0 && (
                            <p>{t('Removed {{count}} dead process entries', { count: healthCheckResult.registryCleanup.removed })}</p>
                          )}
                          {healthCheckResult.registryCleanup.orphans > 0 && (
                            <p>{t('Found {{count}} orphan processes', { count: healthCheckResult.registryCleanup.orphans })}</p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Recent Errors */}
                    {healthReport.recentErrors.length > 0 && (
                      <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3 space-y-2">
                        <p className="text-xs font-medium text-red-500 uppercase tracking-wide">{t('Recent Errors')}</p>
                        <div className="space-y-1.5 max-h-32 overflow-y-auto">
                          {healthReport.recentErrors.slice(0, 5).map((error, index) => (
                            <div key={index} className="text-xs">
                              <span className="text-muted-foreground">{error.time}</span>
                              <span className="mx-1 text-muted-foreground">-</span>
                              <span className="text-red-400">{error.message}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recovery Actions */}
                    <div className="bg-muted/30 rounded-lg p-3 space-y-3">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Recovery Actions')}</p>

                      {recoveryResult && (
                        <div className={`p-2 rounded-lg text-sm ${recoveryResult.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                          {recoveryResult.message}
                        </div>
                      )}

                      <div className="flex flex-wrap gap-2">
                        {/* S2: Reset Agent Engine */}
                        <button
                          onClick={() => handleRecovery('S2')}
                          disabled={isRecovering !== null}
                          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 rounded-lg transition-colors disabled:opacity-50"
                          title={t('Kill all AI sessions and restart - fixes most issues')}
                        >
                          {isRecovering === 'S2' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="w-3.5 h-3.5" />
                          )}
                          {t('Reset AI Engine')}
                        </button>

                        {/* S3: Restart App */}
                        <button
                          onClick={() => handleRecovery('S3')}
                          disabled={isRecovering !== null}
                          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-red-500/10 text-red-500 hover:bg-red-500/20 rounded-lg transition-colors disabled:opacity-50"
                          title={t('Restart the entire application')}
                        >
                          {isRecovering === 'S3' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          {t('Restart App')}
                        </button>
                      </div>
                    </div>

                    {/* Export Actions */}
                    <div className="flex items-center gap-2 pt-2">
                      <button
                        onClick={handleCopyReport}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {reportCopied ? t('Copied!') : t('Copy Report')}
                      </button>
                      <button
                        onClick={handleExportReport}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        {t('Export Report')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  )
}
