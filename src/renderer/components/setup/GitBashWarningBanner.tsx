/**
 * GitBashWarningBanner - Persistent warning when Git Bash is not installed
 *
 * Shown at the top of the app when user skipped Git Bash installation.
 * Supports inline installation with progress display.
 */

import { useState } from 'react'
import { AlertTriangle, X, Download, Loader2, Check, RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface InstallProgress {
  phase: 'idle' | 'downloading' | 'extracting' | 'configuring' | 'done' | 'error'
  progress: number
  message: string
  error?: string
}

interface GitBashWarningBannerProps {
  installProgress?: InstallProgress
  onInstall?: () => void
  onDismiss?: () => void
}

export function GitBashWarningBanner({
  installProgress = { phase: 'idle', progress: 0, message: '' },
  onInstall,
  onDismiss
}: GitBashWarningBannerProps) {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(false)

  // Don't show if dismissed or installation completed
  if (dismissed || installProgress.phase === 'done') return null

  const isInstalling = ['downloading', 'extracting', 'configuring'].includes(installProgress.phase)
  const isError = installProgress.phase === 'error'

  const handleInstall = () => {
    if (onInstall && !isInstalling) {
      onInstall()
    }
  }

  const handleDismiss = () => {
    setDismissed(true)
    onDismiss?.()
  }

  // Render installing state
  if (isInstalling) {
    return (
      <div className="bg-primary/10 border-b border-primary/20 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1">
          <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <span className="text-sm text-primary font-medium truncate">
              {installProgress.message}
            </span>
            {/* Progress bar */}
            <div className="w-32 h-1.5 bg-primary/20 rounded-full overflow-hidden flex-shrink-0">
              <div
                className="h-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${installProgress.progress}%` }}
              />
            </div>
            <span className="text-xs text-primary/70 flex-shrink-0">
              {installProgress.progress}%
            </span>
          </div>
        </div>
      </div>
    )
  }

  // Render error state
  if (isError) {
    return (
      <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
          <span className="text-red-700 dark:text-red-300">
            {t('Installation failed')}: {installProgress.error || t('Unknown error')}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleInstall}
            className="text-sm text-red-700 dark:text-red-300 hover:underline flex items-center gap-1"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t('Retry')}
          </button>
          <button
            onClick={handleDismiss}
            className="text-red-500 hover:text-red-600 p-1 rounded hover:bg-red-500/10 transition-colors"
            title={t('Hide for now')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  // Render idle state (default warning)
  return (
    <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm">
        <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
        <span className="text-yellow-700 dark:text-yellow-300">
          {t('Command execution environment is not installed, AI cannot run system commands')}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={handleInstall}
          className="text-sm text-yellow-700 dark:text-yellow-300 hover:underline flex items-center gap-1"
        >
          <Download className="w-3.5 h-3.5" />
          {t('Install now')}
        </button>
        <button
          onClick={handleDismiss}
          className="text-yellow-500 hover:text-yellow-600 p-1 rounded hover:bg-yellow-500/10 transition-colors"
          title={t('Hide for now')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
