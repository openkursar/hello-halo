/**
 * About Section Component
 * Displays version info, update status, and resource links
 */

import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { UpdateStatus } from './types'

declare const __BUILD_TIME__: string

const DOCS_URL = 'https://hello-halo.cc/docs/'
const FEEDBACK_URL = 'https://github.com/openkursar/hello-halo/issues'

const handleOpenLink = async (url: string) => {
  try {
    await api.openExternal(url)
  } catch {
    window.open(url, '_blank')
  }
}

export function AboutSection() {
  const { t } = useTranslation()

  // App version state
  const [appVersion, setAppVersion] = useState<string>('')

  // Update check state
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: 'idle' })

  // Load app version
  useEffect(() => {
    api.getVersion().then((result) => {
      if (result.success && result.data) {
        setAppVersion(result.data)
      }
    })
  }, [])

  // Listen for update status
  useEffect(() => {
    const unsubscribe = api.onUpdaterStatus((data) => {
      switch (data.status) {
        case 'checking':
          setUpdateStatus({ phase: 'checking' })
          break
        case 'not-available':
          setUpdateStatus({ phase: 'up-to-date' })
          break
        case 'available':
          setUpdateStatus({ phase: 'downloading', version: data.version, percent: 0 })
          break
        case 'downloading':
          setUpdateStatus({ phase: 'downloading', version: data.version, percent: data.percent })
          break
        case 'downloaded':
        case 'manual-download':
          setUpdateStatus({ phase: 'ready', version: data.version })
          break
        case 'error':
          setUpdateStatus({ phase: 'failed' })
          break
      }
    })
    return () => unsubscribe()
  }, [])

  // Handle check for updates
  const handleCheckForUpdates = async () => {
    setUpdateStatus({ phase: 'checking' })
    await api.checkForUpdates()
  }

  const isBusy = updateStatus.phase === 'checking' || updateStatus.phase === 'downloading'

  return (
    <section id="about" className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-medium mb-4">{t('About')}</h2>

      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap justify-between items-center gap-x-3 gap-y-1">
          <span className="text-muted-foreground">{t('Version')}</span>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <span>{appVersion ? `${appVersion} (${__BUILD_TIME__.replace(/T(\d{2}):(\d{2}).*/, '-$1$2')})` : '-'}</span>
            <button
              onClick={handleCheckForUpdates}
              disabled={isBusy}
              className="text-xs text-primary hover:text-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {updateStatus.phase === 'checking' ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {t('Checking...')}
                </span>
              ) : updateStatus.phase === 'downloading' ? (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {t('Downloading {{version}}… {{percent}}%', {
                    version: updateStatus.version ?? '',
                    percent: Math.round(updateStatus.percent ?? 0)
                  })}
                </span>
              ) : updateStatus.phase === 'ready' ? (
                <span className="text-emerald-500">{t('New version available')}: {updateStatus.version}</span>
              ) : updateStatus.phase === 'up-to-date' ? (
                <span className="text-muted-foreground">{t('Already up to date')}</span>
              ) : updateStatus.phase === 'failed' ? (
                <span className="text-amber-500">{t('Check failed — tap to retry')}</span>
              ) : (
                t('Check for updates')
              )}
            </button>
          </div>
        </div>

        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('Build')}</span>
          <span>Powered by Claude Code</span>
        </div>

        {/* Resource links */}
        <div className="border-t border-border pt-3 flex justify-between items-center">
          <span className="text-muted-foreground">{t('Help')}</span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => handleOpenLink(DOCS_URL)}
              className="text-xs text-primary hover:text-primary/80 transition-colors"
            >
              {t('Docs')}
            </button>
            <span className="text-muted-foreground/40 select-none">·</span>
            <button
              onClick={() => handleOpenLink(FEEDBACK_URL)}
              className="text-xs text-primary hover:text-primary/80 transition-colors"
            >
              {t('Feedback')}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
