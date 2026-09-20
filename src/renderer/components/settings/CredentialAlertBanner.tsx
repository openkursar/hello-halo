/**
 * CredentialAlertBanner — persistent, dismissible alert for credentials that
 * could not be decoded at rest.
 *
 * The data is preserved on disk (never wiped), so this surfaces the affected
 * fields and routes the user to Settings to re-enter them. It deliberately
 * does NOT suggest restarting: a restart only helps transient failures, and the
 * value is already preserved for that case. On open-source builds (no at-rest
 * encryption) the failure list is always empty, so this renders nothing.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { api } from '../../api'
import { useAppStore } from '../../stores/app.store'
import { useTranslation } from '../../i18n'
import { usePlatform } from '../layout/Header'
import { isElectron, isCapacitor } from '../../api/transport'

interface CredentialFailure {
  path: string
  label: string
}

interface CredentialAlertBannerProps {
  /**
   * Vertical offset in px, so this banner can stack below another fixed
   * top banner (e.g. the WebSocket reconnection bar) instead of overlapping it.
   */
  topOffset?: number
}

function extractFailures(data: unknown): CredentialFailure[] {
  const list = (data as { failures?: unknown })?.failures
  if (!Array.isArray(list)) return []
  return list.filter(
    (f): f is CredentialFailure =>
      !!f && typeof (f as CredentialFailure).path === 'string' && typeof (f as CredentialFailure).label === 'string',
  )
}

export function CredentialAlertBanner({ topOffset = 0 }: CredentialAlertBannerProps) {
  const { t } = useTranslation()
  const platform = usePlatform()
  const navigate = useAppStore((s) => s.navigate)
  const [failures, setFailures] = useState<CredentialFailure[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let active = true

    // Pull the authoritative list on mount (covers failures detected before
    // this component — or any client — was listening).
    void api.getCredentialFailures().then((res) => {
      if (active && res?.success) setFailures(extractFailures(res.data))
    })

    // Merge live pushes by path so the same field never double-counts.
    const unsub = api.onCredentialDecryptFailed((data) => {
      const incoming = extractFailures(data)
      if (incoming.length === 0) return
      setFailures((prev) => {
        const byPath = new Map(prev.map((f) => [f.path, f]))
        for (const f of incoming) byPath.set(f.path, f)
        return Array.from(byPath.values())
      })
      setDismissed(false)
    })

    return () => {
      active = false
      unsub()
    }
  }, [])

  if (dismissed || failures.length === 0) return null

  const labels = failures.map((f) => f.label).join(', ')

  // This banner overlays the top of the window, where the native window
  // controls live (macOS traffic lights on the left, Windows/Linux
  // titleBarOverlay buttons on the right). Reserve their space — mirroring the
  // Header convention — so the banner's own buttons never sit under the native
  // controls (unclickable). Remote/browser/Capacitor have no overlay.
  const overlayPadding =
    isElectron() && !isCapacitor()
      ? platform.isMac
        ? 'pl-20 pr-4'
        : 'pl-4 pr-36'
      : 'px-4'

  return (
    <div
      className={`fixed inset-x-0 z-40 flex items-center justify-between gap-3 py-2 bg-halo-warning/95 border-b border-halo-warning safe-area-top drag-region ${overlayPadding}`}
      style={{ top: topOffset, paddingTop: 'max(8px, var(--sat))' }}
      role="alert"
    >
      <div className="flex items-center gap-2 min-w-0 text-sm text-foreground">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span className="truncate">
          {t('Some saved credentials could not be decrypted. Your data is preserved but currently unusable')}
          {': '}
          <span className="font-medium">{labels}</span>
          {'. '}
          {t('Please re-enter them in Settings.')}
        </span>
      </div>
      {/* Interactive controls must opt out of the drag region to stay clickable. */}
      <div className="no-drag flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => navigate('settings')}
          className="text-sm font-medium text-foreground hover:underline"
        >
          {t('Open Settings')}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="p-1 rounded hover:bg-foreground/10 transition-colors"
          title={t('Hide for now')}
        >
          <X className="w-4 h-4 text-foreground" />
        </button>
      </div>
    </div>
  )
}
