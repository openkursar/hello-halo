/**
 * About Section Component
 * Displays version info and update status
 */

import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { UpdateStatus } from './types'

declare const __BUILD_TIME__: string

export function AboutSection() {
  const { t } = useTranslation()

  // App version state
  const [appVersion, setAppVersion] = useState<string>('')

  // Update check state
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    checking: false,
    hasUpdate: false,
    upToDate: false
  })

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
      if (data.status === 'checking') {
        setUpdateStatus({ checking: true, hasUpdate: false, upToDate: false })
      } else if (data.status === 'not-available') {
        setUpdateStatus({ checking: false, hasUpdate: false, upToDate: true })
      } else if (data.status === 'manual-download' || data.status === 'available' || data.status === 'downloaded') {
        setUpdateStatus({ checking: false, hasUpdate: true, upToDate: false, version: data.version })
      } else if (data.status === 'error') {
        setUpdateStatus({ checking: false, hasUpdate: false, upToDate: false })
      } else {
        setUpdateStatus(prev => ({ ...prev, checking: false }))
      }
    })
    return () => unsubscribe()
  }, [])

  // Handle check for updates
  const handleCheckForUpdates = async () => {
    setUpdateStatus({ checking: true, hasUpdate: false, upToDate: false })
    await api.checkForUpdates()
  }

  return (
    <section id="about" className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-medium mb-4">{t('About')}</h2>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">{t('Version')}</span>
          <div className="flex items-center gap-3">
            <span>{appVersion ? `${appVersion} (${__BUILD_TIME__.replace(/T(\d{2}):(\d{2}).*/, '-$1$2')})` : '-'}</span>
            <button
              onClick={handleCheckForUpdates}
              disabled={updateStatus.checking}
              className="text-xs text-primary hover:text-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {updateStatus.checking ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {t('Checking...')}
                </span>
              ) : updateStatus.hasUpdate ? (
                <span className="text-emerald-500">{t('New version available')}: {updateStatus.version}</span>
              ) : updateStatus.upToDate ? (
                <span className="text-muted-foreground">{t('Already up to date')}</span>
              ) : (
                t('Check for updates')
              )}
            </button>
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('Build')}</span>
          <span> Powered by Claude Code </span>
        </div>
      </div>
    </section>
  )
}
