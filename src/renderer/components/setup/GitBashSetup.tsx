/**
 * GitBashSetup - Windows-only initialization UI for Git Bash dependency
 *
 * Displays when Git Bash is not detected on Windows, offering:
 * - Auto download and install (recommended)
 * - Skip option (degraded mode, no command execution)
 */

import { useState } from 'react'
import { HaloLogo } from '../brand/HaloLogo'
import { Loader2, Check, AlertTriangle, X, Download, ExternalLink } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'configuring' | 'done' | 'error'
  progress: number
  message: string
  error?: string
}

interface GitBashSetupProps {
  onComplete: (installed: boolean) => void
}

type Phase = 'choice' | 'downloading' | 'extracting' | 'configuring' | 'done' | 'error' | 'skipped'

export function GitBashSetup({ onComplete }: GitBashSetupProps) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('choice')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [autoInstall, setAutoInstall] = useState(true)

  const handleContinue = async () => {
    if (!autoInstall) {
      // User chose to skip
      setPhase('skipped')
      setTimeout(() => onComplete(false), 1500)
      return
    }

    // Start installation
    setPhase('downloading')

    try {
      const result = await window.halo.installGitBash((progressData: DownloadProgress) => {
        setPhase(progressData.phase as Phase)
        setProgress(progressData.progress)
        setMessage(progressData.message)
        if (progressData.error) {
          setError(progressData.error)
        }
      })

      if (result.success) {
        setPhase('done')
        setTimeout(() => onComplete(true), 1500)
      } else {
        setPhase('error')
        setError(result.error || t('Unknown error'))
      }
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleRetry = () => {
    setPhase('choice')
    setError('')
    setProgress(0)
  }

  const handleManualInstall = () => {
    window.halo.openExternal?.('https://git-scm.com/downloads/win')
  }

  // Choice screen
  if (phase === 'choice') {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <div className="w-[520px] p-8 rounded-2xl bg-card border border-border shadow-xl">
          <div className="flex items-center gap-3 mb-6">
            <HaloLogo size={40} animated={false} />
            <h2 className="text-xl font-semibold">{t('First-time setup required')}</h2>
          </div>

          <p className="text-muted-foreground mb-6 leading-relaxed">
            {t('To enable AI to execute system commands (such as git, npm, pip, etc.), a command execution environment needs to be installed. This is a one-time operation and does not require reconfiguration after installation.')}
          </p>

          <div className="space-y-3 mb-6">
            <label
              className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
                autoInstall
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                  : 'border-border hover:bg-accent/50'
              }`}
            >
              <input
                type="radio"
                checked={autoInstall}
                onChange={() => setAutoInstall(true)}
                className="mt-1 accent-primary"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Download className="w-4 h-4 text-primary" />
                  <span className="font-medium">{t('Auto download and install')}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">{t('Recommended')}</span>
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {t('About 50MB, automatically configured after download, no other operations required')}
                </div>
              </div>
            </label>

            <label
              className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
                !autoInstall
                  ? 'border-yellow-500/50 bg-yellow-500/5 ring-1 ring-yellow-500/20'
                  : 'border-border hover:bg-accent/50'
              }`}
            >
              <input
                type="radio"
                checked={!autoInstall}
                onChange={() => setAutoInstall(false)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-500" />
                  <span className="font-medium">{t('Skip, install manually later')}</span>
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {t('AI will not be able to execute system commands, only supports conversation and code generation')}
                </div>
              </div>
            </label>
          </div>

          <button
            onClick={handleContinue}
            className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
          >
            {t('Continue')}
          </button>
        </div>
      </div>
    )
  }

  // Download/Install progress screen
  if (phase === 'downloading' || phase === 'extracting' || phase === 'configuring') {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <div className="w-[420px] p-8 rounded-2xl bg-card border border-border shadow-xl text-center">
          <div className="mb-6">
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-primary/10 flex items-center justify-center">
              <Loader2 className="w-10 h-10 text-primary animate-spin" />
            </div>
            <h3 className="text-lg font-medium mb-2">{message}</h3>
            <p className="text-sm text-muted-foreground">{t('First-time initialization, please wait...')}</p>
          </div>

          {/* Progress bar */}
          <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-3 text-sm text-muted-foreground font-medium">{progress}%</p>
        </div>
      </div>
    )
  }

  // Success screen
  if (phase === 'done') {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <div className="w-[420px] p-8 rounded-2xl bg-card border border-border shadow-xl text-center">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-green-500/10 flex items-center justify-center">
            <Check className="w-10 h-10 text-green-500" />
          </div>
          <h3 className="text-lg font-medium mb-2">{t('Initialization complete')}</h3>
          <p className="text-sm text-muted-foreground">{t('Entering application...')}</p>
        </div>
      </div>
    )
  }

  // Skipped screen
  if (phase === 'skipped') {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <div className="w-[420px] p-8 rounded-2xl bg-card border border-border shadow-xl text-center">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-yellow-500/10 flex items-center justify-center">
            <AlertTriangle className="w-10 h-10 text-yellow-500" />
          </div>
          <h3 className="text-lg font-medium mb-2">{t('Limited functionality mode')}</h3>
          <p className="text-sm text-muted-foreground">{t('AI will not be able to execute system commands')}</p>
        </div>
      </div>
    )
  }

  // Error screen
  if (phase === 'error') {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <div className="w-[520px] p-8 rounded-2xl bg-card border border-border shadow-xl">
          <div className="text-center mb-6">
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-red-500/10 flex items-center justify-center">
              <X className="w-10 h-10 text-red-500" />
            </div>
            <h3 className="text-lg font-medium mb-2">{t('Initialization failed')}</h3>
            <p className="text-sm text-muted-foreground break-words">{error}</p>
          </div>

          <div className="space-y-3">
            <button
              onClick={handleRetry}
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
            >
              {t('Retry')}
            </button>
            <button
              onClick={handleManualInstall}
              className="w-full py-3 rounded-xl border border-border font-medium hover:bg-accent transition-colors flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              {t('Download and install manually')}
            </button>
            <button
              onClick={() => onComplete(false)}
              className="w-full py-3 rounded-xl text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('Skip, use with limited functionality')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
