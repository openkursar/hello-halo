/**
 * Update Notification Component
 * Shows a toast-like notification for available updates
 *
 * Behavior:
 * - 'downloaded': Update ready to install (Windows: auto-install, macOS: manual download)
 * - 'manual-download': Need manual download (macOS platform or auto-download failed)
 *
 * The component shows the same UI for both states, with button text depending on the action.
 */

import { useEffect, useState } from 'react'
import { Download, X, RefreshCw, ExternalLink } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'

const isMac = navigator.platform.includes('Mac')

interface UpdateInfo {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'manual-download' | 'error'
  version?: string
  percent?: number
  message?: string
  releaseNotes?: string | { version: string; note: string }[]
  downloadUrl?: string
}

// Parse release notes to array of strings
function parseReleaseNotes(notes: string | { version: string; note: string }[] | undefined): string[] {
  if (!notes) return []

  if (typeof notes === 'string') {
    // Split by newlines and filter out empty lines
    return notes
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^[-*]\s*/, '')) // Remove leading - or *
  }

  // Array format from electron-updater
  if (Array.isArray(notes)) {
    return notes.map(item => item.note)
  }

  return []
}

export function UpdateNotification() {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(false)
  const [notificationVersion, setNotificationVersion] = useState<string | null>(null)
  const [releaseNotes, setReleaseNotes] = useState<string[]>([])
  const [isManualDownload, setIsManualDownload] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string>('')

  useEffect(() => {
    // Listen for updater status events
    const unsubscribe = api.onUpdaterStatus((data) => {
      console.log('[UpdateNotification] Received update status:', data)

      // Show notification for both 'downloaded' and 'manual-download' states
      if ((data.status === 'downloaded' || data.status === 'manual-download') && data.version) {
        setNotificationVersion(data.version)
        setReleaseNotes(parseReleaseNotes(data.releaseNotes))
        setIsManualDownload(data.status === 'manual-download')
        setDownloadUrl(data.downloadUrl || '')
        setDismissed(false)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const handleInstall = () => {
    if (isManualDownload || isMac) {
      // Open download page for manual download
      // URL is provided by main process based on updateConfig in product.json
      if (downloadUrl) {
        window.open(downloadUrl, '_blank')
      }
    } else {
      // Windows auto-install
      api.installUpdate()
    }
  }

  const handleDismiss = () => {
    setDismissed(true)
  }

  // Show notification when we have a version to notify and not dismissed
  if (!notificationVersion || dismissed) {
    return null
  }

  const hasNotes = releaseNotes.length > 0

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className={`bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl p-4 ${hasNotes ? 'max-w-md' : 'max-w-sm'}`}>
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 bg-emerald-500/20 rounded-full flex items-center justify-center">
            <Download className="w-5 h-5 text-emerald-400" />
          </div>

          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-zinc-100">
              {t('New version Halo {{version}} available', { version: notificationVersion })}
            </h4>

            {hasNotes ? (
              <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto text-xs text-zinc-300">
                {releaseNotes.map((note, index) => (
                  <li key={index} className="flex items-start gap-1.5">
                    <span className="text-emerald-400 mt-0.5">•</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-400 mt-1">
                {isManualDownload || isMac ? t('Click to download') : t('Click to restart and complete update')}
              </p>
            )}

            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={handleInstall}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-md transition-colors"
              >
                {isManualDownload || isMac ? (
                  <>
                    <ExternalLink className="w-3.5 h-3.5" />
                    {t('Go to download')}
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    {t('Restart now')}
                  </>
                )}
              </button>
              <button
                onClick={handleDismiss}
                className="px-3 py-1.5 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
              >
                {t('Later')}
              </button>
            </div>
          </div>

          <button
            onClick={handleDismiss}
            className="flex-shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
